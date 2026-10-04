const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const fmt = (totalSeconds) => {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
};

const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtPlay = (sec) => (sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.max(1, Math.floor(sec / 60))} min`);

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
let activeTab = 'jogo';
$$('.tabs button').forEach((b) => b.addEventListener('click', () => {
  activeTab = b.dataset.tab;
  $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
  if (activeTab === 'turbo') { refreshState(); refreshProcs(); }
  if (activeTab === 'evolucao') { refreshState(); renderEvolution(); window.api.evoSync().then((ok) => { if (ok) renderEvolution(); }).catch(() => {}); }
  if (activeTab === 'clipes') renderGallery();
  // A internet é medida com a aba Turbo aberta, mesmo sem jogo.
  window.api.netWatch(activeTab === 'turbo').then(renderNet).catch(() => {});
}));
function showTab(name) { const b = document.querySelector(`.tabs button[data-tab="${name}"]`); if (b) b.click(); }

$('#btn-hide').onclick = () => window.api.hide();
$('#btn-web').onclick = () => window.api.openWeb();
$('#btn-quick').onclick = () => window.api.openQuick();
$('#btn-quick-open').onclick = () => window.api.openQuick();
$('#btn-shot').onclick = () => window.api.captureScore();
$('#btn-browser').onclick = () => window.api.openWebExternal();
$('#btn-fps-admin').onclick = () => { window.api.fpsAdmin(); $('#btn-fps-admin').hidden = true; };
$('#btn-not-game').onclick = () => window.api.ignoreGame();

// Avisos curtos vindos do processo principal (print do placar).
window.api.onToast((text) => {
  const b = $('#banner');
  b.textContent = text; b.hidden = false;
  clearTimeout(b._t); b._t = setTimeout(() => { b.hidden = true; }, 7000);
});
// Versão nova: no app portátil do Windows ela baixa sozinha e entra ao fechar (ou no botão Reiniciar).
let updState = null;
function renderUpdate(u) {
  updState = u || updState;
  const el = $('#update'), st = $('#update-status');
  if (!updState) return;
  const v = updState.version;
  el.hidden = !['available', 'downloading', 'ready'].includes(updState.status);
  el.classList.toggle('ready', updState.status === 'ready');
  if (updState.status === 'available') { el.textContent = `⬆️ Versão ${v} disponível. Clique para baixar.`; el.onclick = () => window.api.openUpdate(updState.url); }
  if (updState.status === 'downloading') { el.textContent = `⬇️ Baixando a versão ${v}... ${updState.pct || 0}%`; el.onclick = null; }
  if (updState.status === 'ready') { el.textContent = `✅ Versão ${v} pronta. Clique para reiniciar e atualizar (ou ela entra quando você fechar o app).`; el.onclick = () => { el.textContent = 'Reiniciando...'; window.api.updateRestart(); }; }
  st.textContent = updState.status === 'latest' ? 'Você já tem a versão mais nova.'
    : updState.status === 'available' ? `Versão ${v} disponível${updState.auto ? '' : ' no GitHub'}.`
      : updState.status === 'downloading' ? `Baixando a versão ${v}: ${updState.pct || 0}%.`
        : updState.status === 'ready' ? `Versão ${v} baixada. Ela entra quando você fechar o app.`
          : updState.status === 'error' ? updState.msg || 'Não consegui atualizar agora.' : '';
}
window.api.onUpdateStatus(renderUpdate);

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
  $('#t-fps').textContent = $('#v-fps').textContent;
  $('#t-fps').style.color = $('#v-fps').style.color;
  $('#hero-fps').textContent = f.fps != null ? `${f.fps} FPS` : '';
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
  $('#auto-note').hidden = !(g && g.auto);
  document.body.classList.toggle('playing', Boolean(g));
  renderHero(g);
  renderTotal();
  renderCs2();
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

// Capa: arte do jogo (Steam) quando existe; senão um degradê com a cor do nome e as iniciais.
const initials = (name) => String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hueOf = (text) => [...String(text)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
let heroFor = null;
async function renderHero(g) {
  const key = g ? g.id : null;
  heroFor = key;
  const art = $('#hero-art');
  document.documentElement.style.setProperty('--hue', g ? hueOf(g.name) : 160);
  art.style.backgroundImage = ''; art.classList.remove('cover');
  $('#hero-mark').textContent = g ? initials(g.name) : '';
  if (!g) return;
  let url = null;
  try { url = await window.api.cover(g); } catch {}
  if (!url || heroFor !== key) return;
  art.style.backgroundImage = `url("${url}")`; art.classList.add('cover');
  $('#hero-mark').textContent = '';
}
function renderTotal() {
  const sec = game && state ? state.playtime[game.id] || 0 : 0;
  // Formato curto para caber no quadrinho (ex.: 20h 05m).
  $('#t-total').textContent = !game || sec < 60 ? '–' : sec >= 3600 ? `${Math.floor(sec / 3600)}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m` : `${Math.floor(sec / 60)} min`;
}

function renderTip() {
  $('#tip').textContent = !game ? 'Abra qualquer jogo para ver dicas aqui.'
    : game.tips.length ? game.tips[tipIndex % game.tips.length]
      : `Toque em 🤖 e peça ao Claude dicas e um guia de ${game.name}.`;
}
$('#btn-next-tip').onclick = () => { tipIndex++; renderTip(); };
setInterval(() => { if (game) { tipIndex++; renderTip(); } if (cs2State) { cs2Tip++; renderCs2(); } }, 90 * 1000);

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

// Lê o estado salvo de novo (sessões, tempo, partidas). Os lembretes ficam os da tela, que podem ter sido editados.
async function refreshState() {
  const reminders = state.reminders;
  ({ state } = await window.api.getState());
  state.reminders = reminders;
  renderPlaytime(); renderFpsHistory(); renderSessions(); renderCs2();
}

const nameOf = (id) => (games.find((g) => g.id === id) || {}).name || state.names[id] || id;

function renderPlaytime() {
  renderTotal();
  const rows = Object.entries(state.playtime).sort((a, b) => b[1] - a[1]);
  $('#playtime').innerHTML = rows.length
    ? rows.map(([id, sec]) => {
      return `<tr><td>${escapeHtml(nameOf(id))}</td><td>${fmtPlay(sec)}</td></tr>`;
    }).join('')
    : '<tr><td class="muted">Ainda sem registros.</td><td></td></tr>';
}

// FPS médio de cada sessão do jogo atual (ou do último jogo com FPS medido).
function renderFpsHistory() {
  const lastWithFps = [...state.sessions].reverse().find((x) => x.fpsAvg != null);
  const id = game ? game.id : lastWithFps && lastWithFps.gameId;
  const list = id ? state.sessions.filter((x) => x.gameId === id && x.end && x.fpsAvg != null).slice(-12) : [];
  $('#fps-hist-game').textContent = id ? `· ${nameOf(id)}` : '';
  const c = $('#fps-hist'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!list.length) {
    $('#fps-hist-info').textContent = 'Cada sessão com o FPS ligado vira uma barra aqui, para comparar os dias.';
    return;
  }
  const max = Math.max(60, ...list.map((x) => x.fpsAvg));
  const slot = c.width / 12, top = 14, h = c.height - top - 4, bw = slot - 8;
  ctx.font = '10px "Segoe UI", sans-serif'; ctx.textAlign = 'center';
  list.forEach((x, i) => {
    const left = i * slot + 4, bh = Math.max(2, (x.fpsAvg / max) * h), y = c.height - 4 - bh;
    ctx.fillStyle = x.fpsAvg >= 60 ? '#5ad1a0' : x.fpsAvg >= 30 ? '#ffb454' : '#ff6b6b';
    ctx.fillRect(left, y, bw, bh);
    if (x.fpsLow != null) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(left, c.height - 4 - (x.fpsLow / max) * h, bw, 2); }
    ctx.fillStyle = '#e8eaf0'; ctx.fillText(String(x.fpsAvg), left + bw / 2, y - 3);
  });
  const vals = list.map((x) => x.fpsAvg);
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  $('#fps-hist-info').textContent = `Média ${avg} · melhor ${Math.max(...vals)} · pior ${Math.min(...vals)} nas últimas ${vals.length} sessões. A faixa escura é o FPS mais baixo.`;
}

const RATE = { good: '👍', ok: '😐', bad: '👎' };
function renderSessions() {
  const list = state.sessions.filter((x) => x.end && x.end - x.start >= 60000).slice(-6).reverse();
  $('#sessions').innerHTML = list.length ? list.map((x) => {
    const d = new Date(x.start);
    const when = `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    return `<tr><td>${escapeHtml(nameOf(x.gameId))}<div class="muted tiny">${when}</div></td>`
      + `<td>${fmtPlay((x.end - x.start) / 1000)}${x.fpsAvg != null ? ` · ${x.fpsAvg} FPS` : ''} ${RATE[x.rating] || ''}</td></tr>`;
  }).join('') : '<tr><td class="muted">As sessões aparecem aqui quando você fecha um jogo.</td><td></td></tr>';
}

// ---------- Resumo ao fechar o jogo ----------
let summary = null;
window.api.onSessionSummary(async (s) => {
  summary = s;
  if (document.body.classList.contains('compact')) window.api.setCompact(false);
  await refreshState();
  $('#sum-name').textContent = s.name;
  $('#sum-time').textContent = fmtPlay((s.end - s.start) / 1000);
  $('#sum-fps').textContent = s.fpsAvg ?? '–';
  $('#sum-low').textContent = s.fpsLow ?? '–';
  const prev = state.sessions.filter((x) => x.gameId === s.gameId && x.start !== s.start && x.fpsAvg != null);
  let compare = 'O FPS não foi medido nesta sessão.';
  if (s.fpsAvg != null && prev.length) {
    const avg = Math.round(prev.reduce((a, x) => a + x.fpsAvg, 0) / prev.length), diff = s.fpsAvg - avg;
    compare = diff === 0 ? `FPS igual à sua média neste jogo (${avg}).` : `${Math.abs(diff)} FPS ${diff > 0 ? 'acima' : 'abaixo'} da sua média neste jogo (${avg}).`;
  } else if (s.fpsAvg != null) compare = 'Primeira sessão com FPS medido neste jogo.';
  $('#sum-compare').textContent = compare;
  $('#sum-high').innerHTML = (s.highlights || []).map((h) => `<li>${escapeHtml(h)}</li>`).join('');
  $('#sum-note').value = '';
  $('#summary').hidden = false;
});
function closeSummary() { $('#summary').hidden = true; summary = null; setTimeout(refreshState, 300); }
$$('[data-rate]').forEach((b) => b.onclick = () => {
  if (summary) window.api.rateSession(summary.start, b.dataset.rate, $('#sum-note').value.trim());
  closeSummary();
});
$('#sum-close').onclick = () => {
  const note = $('#sum-note').value.trim();
  if (summary && note) window.api.rateSession(summary.start, null, note);
  closeSummary();
};

// ---------- CS2 ao vivo ----------
let cs2State = null;
let cs2Status = 'off';
let cs2Tip = 0;
const CS2_MSG = {
  'installed-restart': 'Modo ao vivo pronto. Feche e abra o CS2 uma vez para ele começar a mandar os dados.',
  installed: 'Modo ao vivo pronto. Entre numa partida para ver mapa, placar e K/A/D aqui.',
  live: 'Aguardando dados do CS2. Entre numa partida.',
  'not-found': 'Não achei a pasta do CS2 na Steam. O modo ao vivo liga sozinho quando ela existir.',
  error: 'Não consegui gravar a configuração na pasta do CS2. Abra o app como administrador uma vez.',
  'port-busy': 'Outro programa está usando a porta 3971, então o modo ao vivo ficou desligado.',
};
const RES_SHORT = { V: 'Vitória', D: 'Derrota', E: 'Empate' };
function renderCs2() {
  const show = Boolean(cs2State) || Boolean(game && game.id === 'cs2');
  $('#cs2-card').hidden = !show;
  const s = cs2State;
  $('#c-cs2').textContent = s ? `${s.mapLabel} ${s.ctScore}-${s.tScore}${s.kills != null ? ` · ${s.kills}/${s.assists}/${s.deaths}` : ''}` : (liveCard && liveCard.compact) || '';
  if (!show) return;
  $('#cs2-live').hidden = !s;
  $('#cs2-msg').textContent = s ? '' : CS2_MSG[cs2Status] || 'Aguardando o CS2.';
  $('#cs2-map').textContent = s ? `CS2 ao vivo · ${s.mapLabel}` : 'CS2 ao vivo';
  if (s) {
    $('#cs2-round').textContent = s.phase === 'warmup' ? 'aquecimento' : s.phase === 'gameover' ? 'fim de jogo' : s.round != null ? `rodada ${s.round + 1}` : '';
    $('#cs2-ct').textContent = s.ctScore; $('#cs2-t').textContent = s.tScore;
    $('#cs2-ct-box').classList.toggle('mine', s.team === 'CT'); $('#cs2-t-box').classList.toggle('mine', s.team === 'T');
    $('#cs2-kad').textContent = s.kills != null ? `${s.kills}/${s.assists}/${s.deaths}` : '–';
    $('#cs2-money').textContent = s.money != null ? Number(s.money).toLocaleString('pt-BR') : '–';
    $('#cs2-hp').textContent = s.health ?? '–';
    $('#cs2-watch').hidden = !s.watching;
    $('#cs2-tip').textContent = s.tips.length ? `💡 ${s.tips[cs2Tip % s.tips.length]}` : '';
  } else $('#cs2-round').textContent = '';
  const last = (state.cs2Matches || []).slice(-3).reverse();
  $('#cs2-last').innerHTML = last.length ? '<div>Últimas partidas registradas:</div>' + last.map((m) =>
    `<div>${escapeHtml(`${RES_SHORT[m.res] || 'Sem resultado'}${m.k != null ? `, ${m.k}/${m.a}/${m.d}` : ''}, ${m.note.split(' (')[0]}`)}</div>`).join('') : '';
}
window.api.onCs2((s) => {
  if (s && (!cs2State || cs2State.map !== s.map)) cs2Tip = 0;
  cs2State = s; renderCs2();
});
window.api.onCs2Status((st) => { cs2Status = st; renderCs2(); });

// ---------- Modo ao vivo de outros jogos ----------
let liveCard = null;
function renderLive() {
  const c = liveCard;
  $('#live-card').hidden = !c;
  if (!cs2State) $('#c-cs2').textContent = (c && c.compact) || '';
  if (!c) return;
  $('#live-title').textContent = c.title;
  $('#live-sub').textContent = c.sub || '';
  $('#live-stats').innerHTML = (c.stats || []).map(([label, value]) => `<div><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('');
  $('#live-lines').innerHTML = (c.lines || []).filter(Boolean).map((l) => `<div>${escapeHtml(l)}</div>`).join('');
  $('#live-tip').textContent = c.tip ? `💡 ${c.tip}` : '';
  $('#live-msg').textContent = c.msg || '';
}
window.api.onLive((c) => { liveCard = c; renderLive(); });
window.api.onCs2Match(() => refreshState());

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
  if (settings.sound === false) return;
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
  renderTimers(); syncTimers();
}
// O HUD por cima do jogo mostra o próximo timer.
function syncTimers() { window.api.setTimers(timers.map(({ label, end }) => ({ label, end }))); }
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
    li.querySelector('button').onclick = () => { timers.splice(timers.indexOf(t), 1); renderTimers(); syncTimers(); };
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
  $('#session').textContent = session ? `jogando · ${session}` : 'aguardando jogo';
  $('#t-session').textContent = session || '–';

  for (const t of [...timers]) {
    if (now >= t.end) { timers.splice(timers.indexOf(t), 1); syncTimers(); alertUser(`${t.label}: tempo esgotado!`); }
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
  // Na barra compacta, esconde as bolinhas que não cabem inteiras.
  if (document.body.classList.contains('compact')) {
    const box = $('#compact-bar .pills');
    [...box.children].forEach((el) => { el.style.visibility = ''; });
    const right = box.getBoundingClientRect().right + 1;
    [...box.children].forEach((el) => { if (el.getBoundingClientRect().right > right) el.style.visibility = 'hidden'; });
  }
}

// ---------- Ajustes ----------
let settings = {};
function applySettings() {
  document.documentElement.style.setProperty('--alpha', (settings.opacity ?? 90) / 100);
  $('#set-opacity').value = settings.opacity ?? 90;
  $$('#set-size button').forEach((b) => b.classList.toggle('on', b.dataset.size === (settings.size || 'normal')));
  $('#set-corner-toasts').checked = settings.cornerToasts !== false;
  $('#set-sound').checked = settings.sound !== false;
  $('#set-hud').checked = Boolean(settings.hud);
  $$('#set-hud-corner button').forEach((b) => b.classList.toggle('on', b.dataset.corner === (settings.hudCorner || 'tl')));
  $$('#set-hud-items button').forEach((b) => b.classList.toggle('on', Boolean((settings.hudItems || {})[b.dataset.item])));
  $('#set-turbo-power').checked = Boolean(settings.turboPower);
  $('#set-turbo-alerts').checked = settings.turboAlerts !== false;
  if (document.activeElement !== $('#set-daily-limit')) $('#set-daily-limit').value = settings.dailyLimitMin ? String(Math.round((settings.dailyLimitMin / 60) * 10) / 10) : '';
  $('#set-clips').checked = Boolean(settings.clips);
  $$('#set-clip-seconds button').forEach((b) => b.classList.toggle('on', Number(b.dataset.sec) === Number(settings.clipSeconds || 30)));
  $$('#set-clip-quality button').forEach((b) => b.classList.toggle('on', b.dataset.q === (settings.clipQuality || '720')));
  $('#set-clip-auto').checked = settings.clipAuto !== false;
  $('#set-coach').checked = settings.coach !== false;
  $('#set-coach-ai').checked = settings.coachAi !== false;
  $('#set-coach-ai').disabled = settings.coach === false;
  $('#set-net').checked = settings.net !== false;
  if (document.activeElement !== $('#set-net-host')) $('#set-net-host').value = settings.netHost || '1.1.1.1';
  $('#set-auto-update').checked = settings.autoUpdate !== false;
  $('#set-site').checked = settings.siteSync !== false;
  $('#set-quick-warm').checked = settings.quickWarm !== false;
  $('#set-quick-warm').disabled = settings.siteSync === false;
  renderClips(); renderCoach();
}
function setSetting(key, value) { settings[key] = value; applySettings(); window.api.setSetting(key, value); }
$('#set-opacity').oninput = (e) => setSetting('opacity', Number(e.target.value));
$$('#set-size button').forEach((b) => b.onclick = () => setSetting('size', b.dataset.size));
$$('#set-corner button').forEach((b) => b.onclick = () => window.api.snap(b.dataset.corner));
$('#set-corner-toasts').onchange = (e) => setSetting('cornerToasts', e.target.checked);
$('#set-sound').onchange = (e) => setSetting('sound', e.target.checked);
$('#set-hud').onchange = (e) => setSetting('hud', e.target.checked);
$$('#set-hud-corner button').forEach((b) => b.onclick = () => setSetting('hudCorner', b.dataset.corner));
$$('#set-hud-items button').forEach((b) => b.onclick = () => setSetting('hudItems', { ...(settings.hudItems || {}), [b.dataset.item]: !(settings.hudItems || {})[b.dataset.item] }));
$('#set-turbo-power').onchange = (e) => setSetting('turboPower', e.target.checked);
$('#set-turbo-alerts').onchange = (e) => setSetting('turboAlerts', e.target.checked);
$('#set-daily-limit').onchange = (e) => setSetting('dailyLimitMin', Math.round((Number(String(e.target.value).replace(',', '.')) || 0) * 60));
$('#set-clips').onchange = (e) => setSetting('clips', e.target.checked);
$$('#set-clip-seconds button').forEach((b) => b.onclick = () => setSetting('clipSeconds', Number(b.dataset.sec)));
$$('#set-clip-quality button').forEach((b) => b.onclick = () => setSetting('clipQuality', b.dataset.q));
$('#set-clip-auto').onchange = (e) => setSetting('clipAuto', e.target.checked);
$('#btn-clips-folder').onclick = () => window.api.openClipsFolder();
$('#set-coach').onchange = (e) => setSetting('coach', e.target.checked);
$('#set-coach-ai').onchange = (e) => setSetting('coachAi', e.target.checked);
$('#set-net').onchange = (e) => setSetting('net', e.target.checked);
$('#set-net-host').onchange = (e) => setSetting('netHost', e.target.value.trim() || '1.1.1.1');
$('#set-auto-update').onchange = (e) => setSetting('autoUpdate', e.target.checked);
$('#set-site').onchange = (e) => setSetting('siteSync', e.target.checked);
$('#set-quick-warm').onchange = (e) => setSetting('quickWarm', e.target.checked);
window.api.onSettings((s) => { settings = { ...s }; applySettings(); });
$('#set-autostart').onchange = async (e) => { $('#set-autostart').checked = await window.api.setAutostart(e.target.checked); };
$('#btn-check-update').onclick = async () => {
  $('#update-status').textContent = 'Procurando...';
  let u = null; try { u = await window.api.checkUpdate(); } catch {}
  renderUpdate(u || { status: 'error', msg: 'Não consegui procurar agora. Tente de novo mais tarde.' });
};

// ---------- Início ----------
(async () => {
  const init = await window.api.getState();
  games = init.games; state = init.state; cs2State = init.cs2; cs2Status = init.cs2Status; liveCard = init.live;
  games.forEach((g) => $('#game-select').add(new Option(g.name, g.id)));
  settings = init.settings || {};
  clipsInfo = init.clips || null;
  coachData = init.coach || null;
  applySettings();
  renderUpdate(init.update); renderNet(init.net);
  renderDrops(init.drops || []); renderPower(init.power);
  $('#app-version').textContent = init.version ? `versão ${init.version}` : '';
  window.api.getAutostart().then((on) => { $('#set-autostart').checked = on; }).catch(() => {});
  applyMode(init.mode);
  setGame(init.currentGame);
  renderReminders();
  renderPlaytime(); renderFpsHistory(); renderSessions(); renderCs2(); renderLive();
  refreshStats();
  setInterval(tick, 1000);
  setInterval(refreshStats, 2000);
  setInterval(refreshFps, 1000);
  setInterval(refreshState, 30000);
  setInterval(() => { if (activeTab === 'turbo' && !document.hidden) refreshProcs(); }, 5000);
  window.api.onHistory(() => { if (activeTab === 'evolucao') renderEvolution(); refreshState(); });
})();

// ---------- Evolução ----------
let evoGame = null, evoDays = 30, evo = null;
const fmtNum = (v, d = 2) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
const fmtPct = (r) => (r == null ? '–' : `${Math.round(r * 100)}%`);
function fmtH(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 3600) return `${Math.max(s ? 1 : 0, Math.round(s / 60))} min`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const dateShort = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
const RES_COLOR = { V: '#5ad1a0', D: '#ff6b6b' };

// Seta comparando com o período anterior de mesmo tamanho.
function delta(el, cur, prev, kind) {
  el.className = ''; el.textContent = '';
  if (!evo || !evo.prev || cur == null || prev == null || (kind === 'n' && !cur && !prev)) return;
  const d = cur - prev, tiny = { n: 0.5, pct: 0.005, kd: 0.005, time: 30 }[kind];
  if (Math.abs(d) < tiny) { el.textContent = '= anterior'; return; }
  const txt = kind === 'pct' ? `${Math.round(Math.abs(d) * 100)} pts` : kind === 'kd' ? fmtNum(Math.abs(d)) : kind === 'time' ? fmtH(Math.abs(d)) : String(Math.abs(d));
  el.textContent = `${d > 0 ? '▲' : '▼'} ${txt}`;
  if (kind === 'pct' || kind === 'kd') el.className = d > 0 ? 'up' : 'down';
}

async function renderEvolution() {
  try { evo = await window.api.evolution(evoGame, evoDays); } catch { return; }
  evoGame = evo.game;
  const sel = $('#evo-game');
  sel.innerHTML = '';
  if (!evo.games.length) sel.add(new Option('Nenhum jogo ainda', ''));
  evo.games.forEach((g) => sel.add(new Option(`${g.name}${g.matches ? ` · ${g.matches} ${g.matches === 1 ? 'partida' : 'partidas'}` : ''}`, g.id)));
  sel.value = evo.game || '';
  $$('#evo-days button').forEach((b) => b.classList.toggle('on', Number(b.dataset.days) === evoDays));
  const s = evo.summary, p = evo.prev || {};
  const period = evoDays ? `comparado com os ${evoDays} dias anteriores` : '';
  $$('#tab-evolucao .tiles .tile').forEach((t) => { t.title = period; });
  $('#e-n').textContent = evo.game ? String(s.n) : '–';
  $('#e-win').textContent = fmtPct(s.winRate);
  $('#e-kd').textContent = fmtNum(s.kd);
  // No quadrinho, a partir de 10 horas mostra só as horas para caber.
  $('#e-time').textContent = !evo.game ? '–' : s.sec >= 36000 ? `${Math.floor(s.sec / 3600)}h` : fmtH(s.sec);
  delta($('#e-n-d'), s.n, p.n, 'n'); delta($('#e-win-d'), s.winRate, p.winRate, 'pct');
  delta($('#e-kd-d'), s.kd, p.kd, 'kd'); delta($('#e-time-d'), s.sec, p.sec, 'time');
  const empty = !evo.games.length
    ? 'Jogue com o app aberto e tudo aparece aqui. No CS2, Valorant e TF2 as partidas entram sozinhas; nos outros jogos, contam o tempo e as sessões.'
    : !evo.hasKd && !evo.hasResults ? `No ${evo.name} não há partidas registradas, só o tempo de jogo. As partidas entram sozinhas no CS2, Valorant e TF2, ou pela página do Claude.` : '';
  $('#evo-empty').hidden = !empty; $('#evo-empty').textContent = empty;
  $('#evo-chart-card').hidden = !evo.hasKd;
  $('#evo-maps-card').hidden = !evo.maps.length;
  drawKd(); drawPlay(); renderMaps(); renderRecords(); renderGoals(); renderPageGoals(); renderWeek(); renderEvoCoach();
  $('#evo-src').textContent = evo.games.length ? 'Partidas do modo ao vivo e as anotadas na página do Claude.' : '';
}
$('#evo-game').onchange = (e) => { evoGame = e.target.value || null; renderEvolution(); };
$$('#evo-days button').forEach((b) => b.onclick = () => { evoDays = Number(b.dataset.days); renderEvolution(); });

function drawKd() {
  const svg = $('#evo-chart'), pts = evo.series;
  const t = evo.trend;
  $('#evo-trend').innerHTML = t ? `K/D das últimas ${t.n}: <b>${fmtNum(t.recent)}</b> <span class="${t.diff >= 0 ? 'up' : 'down'}">${t.diff >= 0 ? '▲' : '▼'} ${fmtNum(Math.abs(t.diff))}</span> contra as ${t.n} anteriores` : '';
  if (!pts.length) { svg.innerHTML = '<text x="170" y="62" text-anchor="middle">Sem partidas com abates neste período.</text>'; return; }
  const W = 340, H = 120, L = 26, R = 8, T = 8, B = 8;
  const max = Math.min(6, Math.max(2, ...pts.map((x) => x.kd)) * 1.1);
  const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i / (pts.length - 1)) * (W - L - R));
  const y = (v) => T + (1 - Math.min(v, max) / max) * (H - T - B);
  let out = `<line x1="${L}" x2="${W - R}" y1="${y(1)}" y2="${y(1)}" stroke="rgba(255,255,255,0.28)" stroke-dasharray="3 3"/>`;
  out += `<text x="4" y="${y(1) + 3}">1,0</text><text x="4" y="${y(max) + 8}">${fmtNum(max, 1)}</text><text x="4" y="${H - B}">0</text>`;
  if (pts.length > 1) out += `<polyline fill="none" stroke="#ffd27a" stroke-width="1.8" stroke-linejoin="round" points="${pts.map((q, i) => `${x(i).toFixed(1)},${y(q.avg).toFixed(1)}`).join(' ')}"/>`;
  pts.forEach((q, i) => {
    out += `<circle cx="${x(i).toFixed(1)}" cy="${y(q.kd).toFixed(1)}" r="3.4" fill="${RES_COLOR[q.res] || '#7d8496'}"><title>${dateShort(q.at)}: ${q.k} abates, ${q.d} mortes (K/D ${fmtNum(q.kd)})</title></circle>`;
  });
  svg.innerHTML = out;
}

function drawPlay() {
  const svg = $('#evo-play'), days = evo.playtime || [];
  const W = 340, H = 90, T = 16, B = 14, gap = days.length > 10 ? 2 : 6;
  const max = Math.max(1800, ...days.map((d) => d.sec));
  const bw = (W - gap * (days.length - 1)) / Math.max(1, days.length);
  const week = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  let out = '';
  days.forEach((d, i) => {
    const h = d.sec ? Math.max(2, (d.sec / max) * (H - T - B)) : 0, x0 = i * (bw + gap), y0 = H - B - h;
    out += `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${i === days.length - 1 ? '#6aa8ff' : '#5ad1a0'}" opacity="${d.sec ? 0.9 : 0}"><title>${dateShort(d.day)}: ${fmtH(d.sec)}</title></rect>`;
    if (days.length <= 10) {
      out += `<text x="${(x0 + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle">${week[new Date(d.day).getDay()]}</text>`;
      if (d.sec >= 60) out += `<text x="${(x0 + bw / 2).toFixed(1)}" y="${(y0 - 3).toFixed(1)}" text-anchor="middle">${fmtH(d.sec).replace(' ', '')}</text>`;
    } else if (i % 5 === (days.length - 1) % 5) out += `<text x="${(x0 + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle">${dateShort(d.day)}</text>`;
  });
  svg.innerHTML = out;
  const total = days.reduce((a, d) => a + d.sec, 0), played = days.filter((d) => d.sec >= 60).length;
  $('#evo-play-info').textContent = total ? `Total ${fmtH(total)} em ${days.length} dias · jogou em ${played} ${played === 1 ? 'dia' : 'dias'} · média de ${fmtH(total / Math.max(1, played))} nesses dias.` : 'Sem tempo de jogo neste período.';
}

function renderMaps() {
  const rows = evo.maps.slice(0, 8), pick = evo.mapPick || {};
  $('#evo-maps').innerHTML = rows.length ? '<tr><th>Mapa</th><th>Partidas</th><th>Vitórias</th><th>K/D</th></tr>' + rows.map((r) =>
    `<tr class="${r.map === pick.best ? 'best' : r.map === pick.worst ? 'worst' : ''}"><td>${escapeHtml(r.map)}</td><td>${r.n}</td><td>${r.decided ? fmtPct(r.winRate) : '–'}</td><td>${fmtNum(r.kd)}</td></tr>`).join('') : '';
  $('#evo-maps-note').textContent = pick.best ? `Melhor e pior pelo ${pick.metric === 'win' ? '% de vitórias' : 'K/D'}, contando mapas com 3 partidas ou mais.` : rows.length ? 'Com 3 partidas ou mais em dois mapas, aparece aqui o seu melhor e o seu pior.' : '';
}

function renderRecords() {
  const r = evo.records || {}, box = (label, value, sub) => `<div><span>${label}</span><b>${value}</b><small>${escapeHtml(sub || '')}</small></div>`;
  const where = (m) => [dateShort(m.at), m.mapLabel || m.map].filter(Boolean).join(' · ');
  $('#evo-records').innerHTML = [
    box('Mais abates', r.mostKills ? r.mostKills.k : '–', r.mostKills ? where(r.mostKills) : 'numa partida'),
    box('Melhor K/D', r.bestKd ? fmtNum(r.bestKd.k / Math.max(1, r.bestKd.d)) : '–', r.bestKd ? `${r.bestKd.k}/${r.bestKd.d} · ${where(r.bestKd)}` : 'com 10+ abates e mortes'),
    box('Vitórias seguidas', r.winStreak ? r.winStreak.n : '–', r.winStreak ? `até ${dateShort(r.winStreak.at)}` : 'a maior sequência'),
    box('Sessão mais longa', r.longestSession ? fmtH((r.longestSession.end - r.longestSession.start) / 1000) : '–', r.longestSession ? dateShort(r.longestSession.start) : ''),
  ].join('');
}

const GOAL_DEFAULT = { kd: 1.2, win: 55, kills: 18, matches: 10, hours: 15 };
function renderGoals() {
  const list = evo.goals || [];
  $('#evo-goals').innerHTML = list.length ? '' : '<div class="empty-line">Crie uma meta para acompanhar aqui, por exemplo K/D de 1,2 no CS2.</div>';
  list.forEach((g) => {
    const p = g.progress || {};
    const el = document.createElement('div');
    el.className = `goal${p.done ? ' done' : ''}${p.over ? ' over' : ''}`;
    const sign = g.type === 'hours' ? '≤' : '≥';
    const sub = p.done ? '🎉 Meta batida!' : p.over ? 'Passou do limite desta semana.' : !p.enough ? 'Precisa de pelo menos 5 partidas para contar.' : g.type === 'hours' ? `Faltam ${fmtNum(Math.max(0, p.target - (p.value || 0)), 1)} h até o limite.` : '';
    el.innerHTML = `<div class="top"><span></span><b>${escapeHtml(p.valueText || '–')} / ${sign} ${escapeHtml(p.targetText || '')}</b><button title="Apagar meta">✕</button></div><div class="bar"><i style="width:${Math.round((p.pct || 0) * 100)}%"></i></div><div class="sub"></div>`;
    el.querySelector('.top span').textContent = `${p.label || ''} · ${g.gameName}`;
    el.querySelector('.sub').textContent = sub;
    el.querySelector('button').onclick = async () => { await window.api.setGoals((evo.goals || []).filter((x) => x.id !== g.id)); renderEvolution(); };
    $('#evo-goals').appendChild(el);
  });
}
// Metas escritas na página do Claude: o app mostra, marca e cria (a página guarda).
function renderPageGoals() {
  const list = evo.pageGoals || [], box = $('#page-goals');
  $('#page-goals-box').hidden = !list.length; $('#page-goal-form').hidden = !evo.game;
  box.replaceChildren(...list.map((g) => {
    const l = document.createElement('label'), cb = document.createElement('input'), sp = document.createElement('span');
    cb.type = 'checkbox'; cb.checked = Boolean(g.done); l.className = g.done ? 'done' : ''; sp.textContent = g.text;
    cb.onchange = async () => {
      cb.disabled = true; $('#page-goal-msg').textContent = 'Salvando na página do Claude...';
      const ok = await window.api.pageGoalDone(evo.game, g.id, cb.checked).catch(() => false);
      $('#page-goal-msg').textContent = ok ? '' : 'Não consegui falar com a página do Claude agora. Tente de novo.';
      if (!ok) { cb.checked = !cb.checked; cb.disabled = false; }
    };
    l.append(cb, sp); return l;
  }));
}
$('#page-goal-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#page-goal-text').value.trim();
  if (!text || !evo.game) return;
  $('#page-goal-msg').textContent = 'Criando na página do Claude...';
  const ok = await window.api.pageGoalAdd(evo.game, text).catch(() => false);
  $('#page-goal-msg').textContent = ok ? '' : 'Não consegui falar com a página do Claude agora. Tente de novo.';
  if (ok) $('#page-goal-text').value = '';
};
$('#goal-type').onchange = (e) => { $('#goal-target').value = GOAL_DEFAULT[e.target.value]; };
$('#goal-form').onsubmit = async (e) => {
  e.preventDefault();
  const type = $('#goal-type').value, target = Number(String($('#goal-target').value).replace(',', '.'));
  if (!(target > 0)) return;
  const goals = (evo && evo.goals ? evo.goals : []).map(({ id, game, type: t, target: v }) => ({ id, game, type: t, target: v }));
  goals.push({ id: String(Date.now()), game: type === 'hours' ? null : evoGame, type, target });
  await window.api.setGoals(goals);
  renderEvolution();
};

function renderWeek() {
  const rows = evo.week || [];
  const arrow = (cur, prev) => (cur == null || prev == null || Math.abs(cur - prev) < 1e-9 ? '' : ` <span class="${cur > prev ? 'up' : 'down'}">${cur > prev ? '▲' : '▼'}</span>`);
  const cell = (label, value, before) => `<div><label>${label}</label><b>${value}</b><small>antes ${before}</small></div>`;
  const hm = (sec) => (sec < 3600 ? fmtH(sec).replace(' ', '') : `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`);
  $('#evo-week').innerHTML = rows.length ? rows.slice(0, 6).map((r) => `<div class="wk"><div class="wk-name">${escapeHtml(r.name)}</div><div class="wk-cells">`
    + cell('Tempo', hm(r.cur.sec), hm(r.prev.sec))
    + cell('Partidas', `${r.cur.n}${arrow(r.cur.n, r.prev.n)}`, r.prev.n)
    + cell('Vitórias', `${fmtPct(r.cur.winRate)}${arrow(r.cur.winRate, r.prev.winRate)}`, fmtPct(r.prev.winRate))
    + cell('K/D', `${fmtNum(r.cur.kd)}${arrow(r.cur.kd, r.prev.kd)}`, fmtNum(r.prev.kd))
    + '</div></div>').join('') : '<div class="empty-line">Sem jogo nesta semana nem na passada.</div>';
  $('#btn-evo-ask').disabled = !evo.game;
}
$('#btn-evo-ask').onclick = async () => {
  if (!evo || !evo.game) return;
  $('#evo-ask-msg').textContent = 'Abrindo o Claude com o resumo da sua evolução...';
  let ok = false; try { ok = await window.api.askClaude(evo.game, evoDays); } catch {}
  $('#evo-ask-msg').textContent = ok ? 'Pergunta enviada na janela do Claude.' : 'Copiei o relatório: cole na pergunta da janela do Claude (Ctrl+V).';
};

// ---------- Turbo ----------
const fmtMb = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',')} GB` : `${mb} MB`);
async function refreshProcs() {
  let list = [];
  try { list = await window.api.turboProcs(); } catch {}
  const ul = $('#procs');
  ul.innerHTML = list.length ? '' : '<li class="empty-line">Nada pesando agora.</li>';
  list.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="grow"></span><span class="nums">${fmtNum(p.cpu, p.cpu >= 10 ? 0 : 1)}% CPU · ${fmtMb(p.ramMb)}</span><button class="kill">Fechar</button>`;
    li.querySelector('.grow').textContent = `${p.label}${p.count > 1 ? ` (${p.count})` : ''}`;
    li.querySelector('.grow').title = p.name;
    const btn = li.querySelector('button');
    let step = 0, force = false;
    btn.onclick = async () => {
      if (step === 0) { step = 1; btn.textContent = force ? 'Forçar?' : 'Fechar?'; btn.classList.add('confirm'); setTimeout(() => { if (step === 1) { step = 0; btn.textContent = force ? 'Forçar' : 'Fechar'; btn.classList.remove('confirm'); } }, 3000); return; }
      step = 2; btn.textContent = '...';
      let r = { closed: false, msg: '' };
      try { r = await window.api.turboClose(p.name, force); } catch {}
      $('#procs-msg').textContent = r.closed ? `${p.label} foi fechado.` : r.msg;
      if (r.closed) return refreshProcs();
      force = true; step = 0; btn.textContent = 'Forçar'; btn.classList.remove('confirm');
    };
    ul.appendChild(li);
  });
}
let drops = [];
function renderDrops(list) {
  drops = list || [];
  $('#drops').innerHTML = drops.length ? [...drops].reverse().map((d) => `<li><span class="when">${new Date(d.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span><span class="fall">${d.from} → ${d.to} FPS</span><span class="why">${escapeHtml(d.text)}</span></li>`).join('')
    : `<li class="empty-line">${game ? 'Nenhuma queda até agora.' : 'As quedas de FPS aparecem aqui enquanto você joga, com o motivo provável.'}</li>`;
}
window.api.onTurboDrop((d) => renderDrops(d ? [...drops, d] : []));
function renderPower(st) {
  $('#power-msg').textContent = st === 'on' ? 'Ligado: o Windows está no modo Alto desempenho até o jogo fechar.'
    : st === 'unavailable' ? 'Este PC não tem o plano Alto desempenho do Windows.'
      : settings.turboPower ? 'Liga sozinho quando um jogo abrir e volta ao normal quando ele fechar.' : '';
}
window.api.onTurboPower(renderPower);

// ---------- Clipes ----------
let clipsInfo = null;
const fmtSize = (b) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const fmtClipWhen = (t) => new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fmtSec = (sec) => fmt(Math.round(sec || 0));
function clipLabel(x) { return `${x.gameName || (x.game ? nameOf(x.game) : '') || 'Clipe'}${x.kind === 'trim' ? ' · corte' : x.kind === 'discord' ? ' · Discord' : ''}${x.reason ? ` ${x.reason}` : ''}`; }
function recTitle(c) { return c.status === 'on' ? `Ctrl+Shift+C salva os últimos ${c.seconds} s` : c.status === 'starting' ? 'Começando a gravar...' : c.status === 'error' ? 'Gravação parada' : settings.clips ? 'Começa quando um jogo abrir' : 'Gravação desligada'; }
function renderClips() {
  const c = clipsInfo;
  $('#clips-card').hidden = !settings.clips;
  if (c) {
    const on = c.status === 'on';
    for (const [pill, title, btn, msg] of [['#clips-pill', '#clips-title', '#btn-save-clip', '#clips-msg'], ['#gal-pill', '#gal-title', '#btn-gal-save', '#gal-msg']]) {
      $(pill).classList.toggle('on', on);
      $(pill).lastChild.textContent = on ? 'Gravando' : 'Clipes';
      $(title).textContent = recTitle(c);
      $(btn).disabled = !on;
      $(msg).textContent = c.msg || (!settings.clips && pill === '#gal-pill' ? 'Ligue a gravação em Ajustes, Clipes. Os clipes salvos ficam aqui para ver, cortar e mandar.' : '');
    }
  }
  if (!settings.clips || !c) return;
  $('#clips-list').innerHTML = '';
  c.list.forEach((x) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="grow"></span><span class="muted">${x.ms ? `${Math.round(x.ms / 1000)} s` : fmtSize(x.size)}</span><button>Ver</button>`;
    li.querySelector('.grow').textContent = `${fmtClipWhen(x.at)} · ${clipLabel(x)}`;
    li.querySelector('button').onclick = () => openPlayer(x);
    $('#clips-list').appendChild(li);
  });
  $('#btn-clips-tab').hidden = !c.list.length;
}
$('#btn-save-clip').onclick = () => window.api.saveClip();
$('#btn-gal-save').onclick = () => window.api.saveClip();
$('#btn-clips-tab').onclick = () => showTab('clipes');
$('#btn-gal-folder').onclick = () => window.api.openClipsFolder();
window.api.onClips((c) => { clipsInfo = c; renderClips(); if (activeTab === 'clipes') renderGallery(); });

// Galeria: miniaturas feitas aqui mesmo (um quadro do vídeo) e guardadas pelo app.
let gallery = [];
const thumbQueue = [];
let thumbBusy = false;
async function renderGallery() {
  try { gallery = await window.api.clipsGallery(); } catch { gallery = []; }
  const box = $('#gallery');
  box.innerHTML = '';
  $('#gal-empty').hidden = gallery.length > 0;
  $('#gal-empty').textContent = settings.clips ? 'Nenhum clipe ainda. Durante o jogo, Ctrl+Shift+C salva os últimos segundos.' : 'Nenhum clipe ainda. Ligue a gravação em Ajustes, Clipes, e salve jogadas com Ctrl+Shift+C.';
  gallery.forEach((x) => {
    const el = document.createElement('button');
    el.className = 'clip-tile';
    el.innerHTML = `<div class="thumb">${x.thumb ? `<img src="${escapeHtml(x.thumb)}" alt="">` : '<svg><use href="#i-film"/></svg>'}<span class="dur"></span><span class="play"><svg><use href="#i-play"/></svg></span></div><div class="meta"><b></b><small></small></div>`;
    el.querySelector('.dur').textContent = x.ms ? fmtSec(x.ms / 1000) : '';
    el.querySelector('.dur').hidden = !x.ms;
    el.querySelector('b').textContent = clipLabel(x);
    el.querySelector('small').textContent = `${fmtClipWhen(x.at)} · ${fmtSize(x.size)}`;
    el.onclick = () => openPlayer(x);
    box.appendChild(el);
    if (!x.thumb) { thumbQueue.push({ x, el }); }
  });
  pumpThumbs();
}
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  while (thumbQueue.length) {
    const { x, el } = thumbQueue.shift();
    const url = await makeThumb(x).catch(() => null);
    if (url && el.isConnected) {
      el.querySelector('.thumb').insertAdjacentHTML('afterbegin', `<img src="${escapeHtml(url)}" alt="">`);
      const icon = el.querySelector('.thumb > svg'); if (icon) icon.remove();
    }
  }
  thumbBusy = false;
}
function makeThumb(x) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    const done = (r) => { clearTimeout(t); v.removeAttribute('src'); v.load(); resolve(r); };
    const t = setTimeout(() => done(null), 12000);
    v.onloadedmetadata = () => { v.currentTime = Math.min(1.5, (isFinite(v.duration) ? v.duration : 3) / 3); };
    v.onseeked = async () => {
      try {
        const c = document.createElement('canvas'); c.width = 320; c.height = Math.round(320 * (v.videoHeight / v.videoWidth || 9 / 16));
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        done(await window.api.clipThumb(x.id, c.toDataURL('image/jpeg', 0.72)));
      } catch { done(null); }
    };
    v.onerror = () => done(null);
    v.src = `gcclip://clip/${x.id}`;
  });
}

// Player: assistir, marcar o começo e o fim, e salvar o corte ou a versão para o Discord.
let pl = null;   // { clip, start, end, busy }
const plVideo = $('#pl-video');
function openPlayer(x) {
  pl = { clip: x, start: 0, end: null, busy: false };
  $('#pl-name').textContent = `${clipLabel(x)} · ${fmtClipWhen(x.at)}`;
  $('#pl-msg').textContent = ''; $('#pl-progress').hidden = true;
  plVideo.src = `gcclip://clip/${x.id}`;
  $('#player').hidden = false;
  if (document.body.classList.contains('compact')) window.api.setCompact(false);
  plButtons(); plRender();
}
function closePlayer() {
  if (pl && pl.busy) return;
  plVideo.pause(); plVideo.removeAttribute('src'); plVideo.load();
  $('#player').hidden = true; pl = null;
}
$('#pl-close').onclick = closePlayer;
$('#player').addEventListener('click', (e) => { if (e.target.id === 'player') closePlayer(); });
const plDur = () => (isFinite(plVideo.duration) && plVideo.duration > 0 ? plVideo.duration : (pl && pl.clip.ms ? pl.clip.ms / 1000 : 0));
function plRange() { const d = plDur(); const end = pl.end == null ? d : Math.min(pl.end, d); return { start: Math.min(pl.start, end), end, d }; }
function plRender() {
  if (!pl) return;
  const { start, end, d } = plRange();
  $('#pl-sel').style.left = `${d ? (start / d) * 100 : 0}%`;
  $('#pl-sel').style.width = `${d ? ((end - start) / d) * 100 : 100}%`;
  $('#pl-head').style.left = `${d ? (plVideo.currentTime / d) * 100 : 0}%`;
  const whole = start <= 0.05 && end >= d - 0.05;
  $('#pl-range').textContent = d ? (whole ? `Vídeo inteiro · ${fmtSec(d)}` : `${fmtSec(start)} → ${fmtSec(end)} · ${Math.round(end - start)} s`) : '';
}
function plButtons() {
  const busy = Boolean(pl && pl.busy);
  ['#pl-trim', '#pl-discord', '#pl-copy', '#pl-del', '#pl-in', '#pl-out'].forEach((id) => { $(id).disabled = busy; });
  $('#pl-close').disabled = busy;
}
plVideo.addEventListener('timeupdate', plRender);
plVideo.addEventListener('loadedmetadata', plRender);
$('#pl-bar').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(), d = plDur(); if (d) plVideo.currentTime = Math.max(0, Math.min(d, ((e.clientX - r.left) / r.width) * d)); };
$('#pl-in').onclick = () => { pl.start = plVideo.currentTime; if (pl.end != null && pl.end <= pl.start + 0.5) pl.end = null; plRender(); };
$('#pl-out').onclick = () => { pl.end = plVideo.currentTime; if (pl.end <= pl.start + 0.5) pl.start = 0; plRender(); };
$('#pl-copy').onclick = async () => {
  const ok = await window.api.clipCopy(pl.clip.id).catch(() => false);
  $('#pl-msg').textContent = ok ? 'Copiado! Cole com Ctrl+V no Discord ou no WhatsApp para mandar o vídeo.' : 'Não consegui copiar. Use Mostrar na pasta e arraste o arquivo.';
};
$('#pl-show').onclick = () => window.api.clipShow(pl.clip.id);
let delStep = 0;
$('#pl-del').onclick = async () => {
  if (!delStep) { delStep = 1; $('#pl-msg').textContent = 'Clique de novo na lixeira para apagar este clipe.'; setTimeout(() => { delStep = 0; }, 3000); return; }
  delStep = 0;
  const ok = await window.api.clipDelete(pl.clip.id).catch(() => false);
  if (ok) { closePlayer(); renderGallery(); } else $('#pl-msg').textContent = 'Não consegui apagar o arquivo.';
};
$('#pl-trim').onclick = () => exportClip('trim');
$('#pl-discord').onclick = () => exportClip('discord');

// Exportar = tocar o trecho escolhido num vídeo escondido e gravar de novo (leva o tempo do trecho).
function exportPlan(seconds, mode, w, h) {
  const srcH = Math.min(1080, h || 720), ar = (w || 16) / (h || 9);
  let height = srcH, vbps = srcH >= 1000 ? 8e6 : 5e6, abps = 128000;
  if (mode === 'discord') {
    abps = 96000;
    vbps = Math.max(250000, Math.min(6e6, Math.floor((9 * 8 * 1024 * 1024) / Math.max(1, seconds)) - abps));
    height = vbps >= 3e6 ? Math.min(srcH, 1080) : vbps >= 1.4e6 ? Math.min(srcH, 720) : vbps >= 700000 ? Math.min(srcH, 540) : Math.min(srcH, 360);
  }
  return { width: Math.round((height * ar) / 2) * 2, height, vbps, abps };
}
function pickMime() {
  return ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
}
async function exportClip(mode) {
  if (!pl || pl.busy) return;
  const { start, end } = plRange();
  const seconds = end - start;
  if (seconds < 1) { $('#pl-msg').textContent = 'Escolha um trecho com pelo menos 1 segundo.'; return; }
  if (mode === 'trim' && start <= 0.05 && end >= plRange().d - 0.05) { $('#pl-msg').textContent = 'Marque o início e o fim do trecho (botões ⟦ e ⟧) antes de salvar o corte.'; return; }
  pl.busy = true; plButtons(); plVideo.pause();
  const clip = pl.clip;
  $('#pl-progress').hidden = false; $('#pl-pbar').style.width = '0%';
  $('#pl-ptext').textContent = mode === 'discord' ? 'Fazendo a versão para o Discord...' : 'Cortando...';
  $('#pl-msg').textContent = 'O trecho toca escondido e é gravado de novo, então leva o tempo dele.';
  let result = null;
  try { result = await renderExport(clip, start, end, mode, (f) => { $('#pl-pbar').style.width = `${Math.round(f * 100)}%`; }); } catch { result = null; }
  if (pl) { pl.busy = false; plButtons(); }
  $('#pl-progress').hidden = true;
  if (!result) { $('#pl-msg').textContent = 'Não consegui exportar este clipe.'; return; }
  const mb = result.size / 1024 / 1024;
  $('#pl-msg').textContent = mode === 'discord'
    ? `Pronto: ${result.name} (${fmtSize(result.size)})${mb > 10 ? '. Ficou acima de 10 MB; corte um trecho menor.' : '. Clique em Copiar nele para colar no Discord.'}`
    : `Pronto: ${result.name} (${fmtSize(result.size)}).`;
  renderGallery();
  // O player passa a mostrar o arquivo novo (para copiar ou mandar).
  const fresh = (await window.api.clipsGallery().catch(() => [])).find((g) => g.id === result.id);
  if (fresh && pl && pl.clip.id === clip.id) { const msg = $('#pl-msg').textContent; openPlayer(fresh); $('#pl-msg').textContent = msg; }
}
function renderExport(clip, start, end, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.playsInline = true;
    v.src = `gcclip://clip/${clip.id}`;
    let rec = null, ac = null, tick = 0, stopAt = end, finished = false;
    const chunks = [];
    const fail = (e) => { if (finished) return; finished = true; cleanup(); reject(e); };
    const cleanup = () => { clearInterval(tick); try { v.pause(); } catch {} v.removeAttribute('src'); v.load(); if (ac) ac.close().catch(() => {}); };
    v.onerror = () => fail(new Error('video'));
    v.onloadedmetadata = () => { v.currentTime = start; };
    v.onseeked = async () => {
      if (rec) return;
      try {
        const plan = exportPlan(end - start, mode, v.videoWidth, v.videoHeight);
        const canvas = document.createElement('canvas'); canvas.width = plan.width; canvas.height = plan.height;
        const ctx = canvas.getContext('2d');
        const stream = canvas.captureStream(30);
        // O som passa pelo Web Audio (não sai nas caixas de som) e vai junto para a gravação.
        try {
          ac = new AudioContext();
          const src = ac.createMediaElementSource(v), dest = ac.createMediaStreamDestination();
          src.connect(dest);
          dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
        } catch {}
        const mime = pickMime();
        rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: plan.vbps, audioBitsPerSecond: plan.abps });
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = async () => {
          if (finished) return;
          finished = true; cleanup();
          try {
            const buf = await new Blob(chunks, { type: mime || 'video/webm' }).arrayBuffer();
            resolve(await window.api.clipExport(clip.id, buf, { mode, mime: mime || 'video/webm', ms: Math.round((end - start) * 1000) }));
          } catch (e) { reject(e); }
        };
        // Desenha 30 vezes por segundo com um timer (requestAnimationFrame para com o painel escondido).
        const draw = () => {
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          onProgress(Math.max(0, Math.min(1, (v.currentTime - start) / (end - start))));
          if ((v.currentTime >= stopAt || v.ended) && rec.state === 'recording') { clearInterval(tick); rec.stop(); }
        };
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        rec.start(1000);
        await v.play();
        tick = setInterval(draw, 33);
        // Garantia: se o vídeo travar, para depois do tempo do trecho mais uma folga.
        setTimeout(() => { if (rec && rec.state === 'recording') rec.stop(); }, (end - start) * 1000 + 8000);
      } catch (e) { fail(e); }
    };
  });
}

// ---------- Coach ----------
let coachData = null;
const RES_WORD = { V: 'Vitória', D: 'Derrota', E: 'Empate' };
function tipText(t) { return t.ai || (t.local && t.local.text) || ''; }
function renderCoach() {
  const list = (coachData && coachData.list) || [];
  const t = game ? list.find((x) => x.game === game.id) : list.find((x) => Date.now() - x.at < 6 * 3600000);
  const show = settings.coach !== false && Boolean(t);
  $('#coach-card').hidden = !show;
  if (show) {
    const m = t.match || {};
    $('#coach-title').textContent = [t.gameName, RES_WORD[m.res], m.k != null ? `${m.k}/${m.a ?? '–'}/${m.d}` : '', m.map].filter(Boolean).join(' · ');
    $('#coach-when').textContent = new Date(t.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('#coach-text').textContent = t.status === 'thinking' ? `${t.local.text}` : tipText(t);
    $('#coach-text').classList.toggle('thinking', t.status === 'thinking');
    $('#coach-facts').innerHTML = (t.local.facts || []).map((f) => `<span>${escapeHtml(f)}</span>`).join('');
    $('#coach-err').textContent = t.status === 'thinking' ? '🧠 O Claude está analisando a partida...' : t.err || (t.ai ? 'Dica do Claude.' : 'Dica rápida do app.');
    $('#btn-coach-ask').onclick = async () => {
      $('#coach-err').textContent = 'Abrindo o Claude...';
      const ok = await window.api.coachAsk(t.id).catch(() => false);
      $('#coach-err').textContent = ok ? 'Pergunta enviada na janela do Claude.' : 'Copiei a pergunta: cole na janela do Claude (Ctrl+V).';
    };
  }
  renderEvoCoach();
}
function renderEvoCoach() {
  const list = ((coachData && coachData.list) || []).filter((x) => x.game === evoGame && x.status !== 'thinking').slice(0, 6);
  $('#evo-coach-card').hidden = !list.length;
  $('#evo-coach').innerHTML = list.map((t) => {
    const m = t.match || {};
    return `<li><span class="when">${dateShort(t.at)}</span><span class="what">${escapeHtml([RES_WORD[m.res], m.k != null ? `${m.k}/${m.a ?? '–'}/${m.d}` : '', m.map].filter(Boolean).join(' · '))}</span><span class="why">${escapeHtml(tipText(t))}</span></li>`;
  }).join('');
}
window.api.onCoach((c) => { coachData = c; renderCoach(); });

// ---------- Internet ----------
let netData = null;
function renderNet(n) {
  if (n) netData = n;
  const d = netData;
  if (!d) return;
  const r = d.recent || d.inet, g = d.gw;
  const msTxt = (v) => (v == null ? '–' : v < 1 ? '<1 ms' : `${Math.round(v)} ms`);
  $('#net-host').textContent = d.host ? `· ping para ${d.host}` : '';
  $('#net-ping').textContent = r ? msTxt(r.last ?? r.avg) : '–';
  $('#net-ping').className = !r || r.avg == null ? '' : r.avg <= 50 ? 'good' : r.avg <= 100 ? 'mid' : 'bad';
  $('#net-loss').textContent = r ? `${Math.round(r.loss * 100)}%` : '–';
  $('#net-loss').className = !r ? '' : r.loss === 0 ? 'good' : r.loss < 0.05 ? 'mid' : 'bad';
  $('#net-jitter').textContent = r ? msTxt(r.jitter) : '–';
  $('#net-gw').textContent = g ? `${msTxt(g.avg)}${g.loss ? ` · ${Math.round(g.loss * 100)}%` : ''}` : '–';
  $('#net-diag').textContent = !d.enabled ? 'Medição desligada em Ajustes, Internet.' : !r ? (d.on ? 'Medindo...' : 'Mede enquanto um jogo está aberto ou com esta aba aberta.') : d.diag.text;
  $('#net-diag').className = `small net-diag ${d.diag && d.diag.level ? d.diag.level : ''}`;
  drawNet(d.series || []);
}
function drawNet(series) {
  const c = $('#net-chart'), ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!series.length) return;
  const now = Date.now(), span = 60000, max = Math.max(60, ...series.filter((p) => p.ms != null).map((p) => p.ms)) * 1.15;
  const x = (t) => c.width - ((now - t) / span) * c.width, y = (ms) => c.height - 3 - (ms / max) * (c.height - 8);
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(0, y(50)); ctx.lineTo(c.width, y(50)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#9aa1b2'; ctx.font = '9px "Segoe UI", sans-serif'; ctx.fillText('50 ms', 4, y(50) - 3);
  ctx.strokeStyle = '#6aa8ff'; ctx.lineWidth = 2; ctx.beginPath();
  let pen = false;
  for (const p of series) { if (p.ms == null) { pen = false; continue; } const px = x(p.t), py = y(p.ms); if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true; }
  ctx.stroke();
  ctx.fillStyle = '#ff6b6b';
  for (const p of series) if (p.ms == null) ctx.fillRect(x(p.t) - 1.5, 2, 3, c.height - 4);
}
window.api.onNet(renderNet);
