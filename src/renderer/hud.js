// HUD por cima do jogo: só mostra; os cliques passam direto para o jogo.
const box = document.getElementById('hud');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (sec) => {
  const s = Math.max(0, Math.floor(sec)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
};
let data = null, lastSize = '';

function render() {
  if (!data) return;
  const it = data.items || {}, now = Date.now(), top = [], rows = [];
  if (it.fps) {
    const cls = data.fps == null ? '' : data.fps >= 60 ? 'good' : data.fps >= 30 ? 'mid' : 'bad';
    top.push(`<span class="pill${data.rec ? ' rec' : ''}"><i class="dot"></i><b class="${cls}">${data.fps ?? '–'}</b> FPS${data.low1 != null ? ` <small>1% ${data.low1}</small>` : ''}</span>`);
  } else if (data.rec) top.push('<span class="pill rec"><i class="dot"></i>REC</span>');
  if (it.perf && data.sys) {
    const t = (v) => (v ? ` <small>${Math.round(v)}°</small>` : '');
    top.push(`<span class="pill">CPU ${data.sys.cpu}%${t(data.sys.cpuTemp)}${data.sys.gpu != null ? ` · GPU ${data.sys.gpu}%${t(data.sys.gpuTemp)}` : ''}</span>`);
  }
  if (it.session && data.session) top.push(`<span class="pill">⏱ ${fmt((now - data.session) / 1000)}</span>`);
  if (it.clock) top.push(`<span class="pill">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>`);
  if (it.net && data.net && data.net.ms != null) {
    const n = data.net, cls = n.trouble || n.loss >= 0.05 || n.ms > 100 ? 'bad' : n.loss > 0 || n.ms > 50 ? 'mid' : 'good';
    top.push(`<span class="pill">📶 <b class="${cls}">${n.ms < 1 ? '<1' : Math.round(n.ms)}</b> ms${n.loss > 0 ? ` <small>perda ${Math.round(n.loss * 100)}%</small>` : ''}</span>`);
  }
  if (top.length) rows.push(`<div class="row">${top.join('')}</div>`);
  if (it.timer && data.timers && data.timers.length) {
    rows.push(`<div class="row">${data.timers.map((t) => `<span class="pill">⏰ ${esc(t.label)} <b>${fmt((t.end - now) / 1000)}</b></span>`).join('')}</div>`);
  }
  const c = data.cs2;
  if (it.cs2 && c) {
    const mine = c.team === 'CT' ? `${c.ct}-${c.t}` : c.team === 'T' ? `${c.t}-${c.ct}` : `CT ${c.ct} x ${c.t} T`;
    rows.push(`<div class="row"><span class="pill">${esc(c.map)} ${mine}${c.money != null ? ` · $${Number(c.money).toLocaleString('pt-BR')}` : ''}</span></div>`);
    // A dica de compra só aparece no tempo de compra (início da rodada).
    if (c.buy && c.roundPhase === 'freezetime') rows.push(`<div class="row"><span class="pill tip ${esc(c.buy.kind)}">💰 ${esc(c.buy.text)}</span></div>`);
  } else if (it.live && data.live) {
    rows.push(`<div class="row"><span class="pill">${esc(data.live.title)} · ${esc(data.live.text)}</span></div>`);
  }
  // Dica do coach: aparece por alguns segundos depois da partida e no começo da próxima.
  if (it.coach && data.coach) rows.push(`<div class="row"><span class="pill tip coach">🧠 <span><small>${esc(data.coach.label)}</small><br>${esc(data.coach.text)}</span></span></div>`);
  box.innerHTML = rows.join('');
  const r = box.getBoundingClientRect(), size = `${Math.ceil(r.width)}x${Math.ceil(r.height)}`;
  if (size !== lastSize) { lastSize = size; window.api.hudSize(Math.ceil(r.width) + 2, Math.ceil(r.height) + 2); }
}

window.api.onHud((d) => { data = d; render(); });
