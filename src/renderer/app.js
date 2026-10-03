const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const fmt = (totalSeconds) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let games = [];
let game = null;
let state = null;
let sessionStart = null;
let tipIndex = 0;
let lastStats = null;
const history = { cpu: [], gpu: [] };
const timers = [];          // { id, label, end }
const reminderNext = {};    // { reminderId: timestamp }
const stopwatch = { running: false, start: 0, acc: 0 };

// ---------- Abas ----------
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === 'desempenho') renderPlaytime();
}));

$('#btn-hide').onclick = () => window.api.hide();
$('#btn-web').onclick = () => window.api.openWeb();
$('#btn-shot').onclick = () => window.api.captureScore();
$('#btn-browser').onclick = () => window.api.openWebExternal();
$('#btn-fps-admin').onclick = () => { window.api.fpsAdmin(); $('#btn-fps-admin').hidden = true; };

// Avisos curtos vindos do processo principal (print do placar).
window.api.onToast((text) => {
  const b = $('#banner');
  b.textContent = text; b.hidden = false;
  clearTimeout(b._t); b._t = setTimeout(() => { b.hidden = true; }, 7000);
});
window.api.onUpdate((u) => {
  const el = $('#update');
  el.textContent = `⬆️ Versão ${u.version} disponível. Clique para baixar.`;
  el.hidden = false; el.onclick = () => window.api.openUpdate(u.url);
});

// FPS do jogo (PresentMon).
let lastFps = null;
async function refreshFps() {
  let f; try { f = await window.api.fps(); } catch { return; }
  lastFps = f.fps != null ? f : null;
  const msg = { off: game ? 'n/d' : '–', unavailable: 'n/d', starting: '...', 'needs-admin': '–', on: '...' }[f.status] || '–';
  $('#v-fps').textContent = f.fps != null ? f.fps : msg;
  $('#v-fps').style.color = f.fps == null ? '' : f.fps >= 60 ? 'var(--ok, #5ad1a0)' : f.fps >= 30 ? 'var(--warn, #ffb547)' : '#ff6b6b';
  $('#v-low').textContent = f.low1 != null ? `1% mais lento: ${f.low1}` : f.status === 'needs-admin' ? 'precisa de permissão' : '';
  $('#btn-fps-admin').hidden = f.status !== 'needs-admin';
}
$('#btn-compact').onclick = () => window.api.setCompact(true);
$('#btn-expand').onclick = () => window.api.setCompact(false);

window.api.onMode(applyMode);
function applyMode({ clickThrough, compact }) {
  document.body.classList.toggle('clickthrough', clickThrough);
  document.body.classList.toggle('compact', compact);
}

// ---------- Jogo atual, dicas e anotações ----------
function setGame(g) {
  game = g;
  sessionStart = g ? Date.now() : null;
  tipIndex = 0;
  $('#game-name').textContent = g ? g.name : 'Nenhum jogo detectado';
  $('#notes').value = g ? state.notes[g.id] || '' : '';
  $('#notes').disabled = !g;
  renderTip();
  $('#guides').innerHTML = '';
  (g ? g.guides : []).forEach((url) => {
    const b = document.createElement('button');
    b.textContent = new URL(url).hostname.replace(/^www\./, '');
    b.onclick = () => window.api.openUrl(url);
    $('#guides').appendChild(b);
  });
}

function renderTip() {
  $('#tip').textContent = game && game.tips.length
    ? game.tips[tipIndex % game.tips.length]
    : 'Abra um jogo da lista (ou escolha acima) para ver dicas.';
}
$('#btn-next-tip').onclick = () => { tipIndex++; renderTip(); };
setInterval(() => { if (game) { tipIndex++; renderTip(); } }, 90 * 1000);

$('#game-select').onchange = (e) => window.api.setGame(e.target.value || null);
window.api.onGameChanged(setGame);

let noteTimer;
$('#notes').addEventListener('input', () => {
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    if (!game) return;
    state.notes[game.id] = $('#notes').value;
    window.api.saveNote(game.id, $('#notes').value);
  }, 500);
});

$('#search').onsubmit = (e) => {
  e.preventDefault();
  const q = `${game ? game.name + ' ' : ''}${$('#search-q').value}`.trim();
  if (q) window.api.openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
};

// ---------- Desempenho ----------
function meter(id, pct, label) {
  const el = $(`#m-${id}`);
  const v = pct == null ? 0 : Math.min(100, pct);
  el.style.width = `${v}%`;
  el.className = v > 90 ? 'crit' : v > 75 ? 'hot' : '';
  $(`#v-${id}`).textContent = label;
}

async function refreshStats() {
  let s;
  try { s = await window.api.systemStats(); } catch { return; }
  lastStats = s;
  meter('cpu', s.cpu, `${s.cpu}%`);
  meter('gpu', s.gpu, s.gpu == null ? 'n/d' : `${s.gpu}%`);
  meter('ram', (s.ramUsed / s.ramTotal) * 100, `${s.ramUsed.toFixed(1)}/${s.ramTotal.toFixed(0)} GB`);
  meter('vram', s.vramTotal ? (s.vramUsed / s.vramTotal) * 100 : null,
    s.vramTotal ? `${s.vramUsed.toFixed(1)}/${s.vramTotal.toFixed(0)} GB` : 'n/d');
  const temps = [];
  if (s.cpuTemp) temps.push(`CPU ${Math.round(s.cpuTemp)}°C`);
  if (s.gpuTemp) temps.push(`GPU ${Math.round(s.gpuTemp)}°C`);
  $('#temps').textContent = [s.gpuName, temps.join(' · ')].filter(Boolean).join(' — ');
  history.cpu.push(s.cpu); history.gpu.push(s.gpu ?? 0);
  if (history.cpu.length > 60) { history.cpu.shift(); history.gpu.shift(); }
  drawSpark();
}

function drawSpark() {
  const c = $('#spark'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  [['cpu', '#5ad1a0'], ['gpu', '#6aa8ff']].forEach(([k, color]) => {
    const data = history[k];
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / 59) * c.width, y = c.height - (v / 100) * (c.height - 4) - 2;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  });
}

async function renderPlaytime() {
  ({ state } = await window.api.getState());
  const rows = Object.entries(state.playtime).sort((a, b) => b[1] - a[1]);
  $('#playtime').innerHTML = rows.length
    ? rows.map(([id, sec]) => {
      const name = (games.find((g) => g.id === id) || {}).name || state.names[id] || id;
      return `<tr><td>${escapeHtml(name)}</td><td>${sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.floor(sec / 60)} min`}</td></tr>`;
    }).join('')
    : '<tr><td class="muted">Ainda sem registros.</td><td></td></tr>';
}

// ---------- Timers e lembretes ----------
function alertUser(text) {
  window.api.show();
  const b = $('#banner');
  b.textContent = `⏰ ${text}`; b.hidden = false;
  clearTimeout(b._t); b._t = setTimeout(() => { b.hidden = true; }, 8000);
  beep();
  try { new Notification('Game Companion', { body: text, silent: true }); } catch {}
}

function beep() {
  const ac = new AudioContext();
  [0, 0.25, 0.5].forEach((t) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = 880; g.gain.value = 0.15;
    o.connect(g).connect(ac.destination);
    o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.15);
  });
  setTimeout(() => ac.close(), 1200);
}

function addTimer(label, minutes) {
  timers.push({ id: Date.now() + Math.random(), label: label || `${minutes} min`, end: Date.now() + minutes * 60000 });
  renderTimers();
}
$$('[data-min]').forEach((b) => b.onclick = () => addTimer('', Number(b.dataset.min)));
$('#timer-form').onsubmit = (e) => {
  e.preventDefault();
  const m = Number($('#timer-min').value);
  if (m > 0) addTimer($('#timer-label').value.trim(), m);
  $('#timer-label').value = '';
};

function renderTimers() {
  const now = Date.now();
  $('#timers').innerHTML = '';
  timers.forEach((t) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="grow"></span><b>${fmt((t.end - now) / 1000)}</b><button>✕</button>`;
    li.querySelector('.grow').textContent = t.label;
    li.querySelector('button').onclick = () => { timers.splice(timers.indexOf(t), 1); renderTimers(); };
    $('#timers').appendChild(li);
  });
}

function renderReminders() {
  $('#reminders').innerHTML = '';
  state.reminders.forEach((r) => {
    const li = document.createElement('li');
    li.innerHTML = `<input type="checkbox" ${r.enabled ? 'checked' : ''}><span class="grow"></span>
      <span class="muted">a cada ${r.everyMin} min</span><b class="next"></b><button>✕</button>`;
    li.querySelector('.grow').textContent = r.label;
    li.querySelector('input').onchange = (e) => { r.enabled = e.target.checked; reminderNext[r.id] = null; saveReminders(); };
    li.querySelector('button').onclick = () => { state.reminders.splice(state.reminders.indexOf(r), 1); saveReminders(); };
    li.dataset.id = r.id;
    $('#reminders').appendChild(li);
  });
}
function saveReminders() { window.api.saveReminders(state.reminders); renderReminders(); }
$('#reminder-form').onsubmit = (e) => {
  e.preventDefault();
  const label = $('#rem-label').value.trim(), everyMin = Number($('#rem-min').value);
  if (!label || !(everyMin > 0)) return;
  state.reminders.push({ id: String(Date.now()), label, everyMin, enabled: true });
  $('#rem-label').value = '';
  saveReminders();
};

$('#sw-toggle').onclick = () => {
  if (stopwatch.running) { stopwatch.acc += Date.now() - stopwatch.start; } else { stopwatch.start = Date.now(); }
  stopwatch.running = !stopwatch.running;
  $('#sw-toggle').textContent = stopwatch.running ? 'Pausar' : 'Iniciar';
};
$('#sw-reset').onclick = () => { stopwatch.acc = 0; stopwatch.start = Date.now(); };

// Laço principal de 1 segundo.
function tick() {
  const now = Date.now();
  const session = sessionStart ? fmt((now - sessionStart) / 1000) : '';
  $('#session').textContent = session ? `sessão ${session}` : 'aguardando jogo';

  for (const t of [...timers]) {
    if (now >= t.end) { timers.splice(timers.indexOf(t), 1); alertUser(`${t.label}: tempo esgotado!`); }
  }
  renderTimers();

  // Lembretes só contam enquanto um jogo está aberto.
  for (const r of state.reminders) {
    const li = $(`#reminders li[data-id="${r.id}"] .next`);
    if (!r.enabled || !game) { reminderNext[r.id] = null; if (li) li.textContent = ''; continue; }
    if (!reminderNext[r.id]) reminderNext[r.id] = now + r.everyMin * 60000;
    if (now >= reminderNext[r.id]) { alertUser(r.label); reminderNext[r.id] = now + r.everyMin * 60000; }
    if (li) li.textContent = fmt((reminderNext[r.id] - now) / 1000);
  }

  const sw = stopwatch.acc + (stopwatch.running ? now - stopwatch.start : 0);
  $('#stopwatch').textContent = fmt(sw / 1000);

  // Barra compacta.
  $('#c-game').textContent = game ? game.name : 'Sem jogo';
  $('#c-session').textContent = session;
  $('#c-fps').textContent = lastFps ? `${lastFps.fps} FPS` : '';
  $('#c-perf').textContent = lastStats ? `CPU ${lastStats.cpu}%${lastStats.gpu != null ? ` · GPU ${lastStats.gpu}%` : ''}` : '';
  const next = [...timers].sort((a, b) => a.end - b.end)[0];
  $('#c-timer').textContent = next ? `⏰ ${fmt((next.end - now) / 1000)}` : '';
}

// ---------- Início ----------
(async () => {
  const init = await window.api.getState();
  games = init.games; state = init.state;
  games.forEach((g) => $('#game-select').add(new Option(g.name, g.id)));
  applyMode(init.mode);
  setGame(init.currentGame);
  renderReminders();
  renderPlaytime();
  refreshStats();
  setInterval(tick, 1000);
  setInterval(refreshStats, 2000);
  setInterval(refreshFps, 1000);
  setInterval(renderPlaytime, 30000);
})();
