// Pergunta rápida: o Pedro escreve, o Claude responde (a resposta também sai no HUD, pelo processo principal).
const $ = (s) => document.querySelector(s);
const SUGGESTIONS = ['Dica rápida para agora', 'O que estou errando?', 'O que eu devo treinar hoje?'];
let info = { game: null, turns: [] };
let busy = false;

function line(role, text) {
  const d = document.createElement('div');
  d.className = `turn ${role}`; d.textContent = text;
  return d;
}
// A janela é transparente e cresce com o conteúdo: o processo principal ajusta a altura.
function fit() { requestAnimationFrame(() => window.api.quickSize($('#box').offsetHeight + 4)); }
function render() {
  $('#game').textContent = info.gameName || 'Pergunta rápida';
  $('#line').textContent = info.line || (info.game && !info.ready ? 'abrindo o Claude...' : '');
  $('#dot').classList.toggle('wait', busy || !info.ready);
  const log = $('#log');
  log.replaceChildren(...(info.turns || []).map((t) => line(t.role, t.content)));
  $('#chips').replaceChildren(...(!(info.turns || []).length && info.game ? SUGGESTIONS.map((s) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = s; b.onclick = () => ask(s); return b;
  }) : []));
  $('#clear').hidden = !(info.turns || []).length;
  if (!info.game) log.append(line('error', 'Abra um jogo (ou escolha um no painel) para perguntar.'));
  $('#q').disabled = !info.game; $('#go').disabled = !info.game || busy;
  log.scrollTop = log.scrollHeight;
  fit();
}
async function ask(q) {
  q = String(q || '').trim();
  if (!q || busy || !info.game) return;
  busy = true; $('#q').value = '';
  info.turns = [...(info.turns || []), { role: 'user', content: q }];
  render();
  $('#log').append(line('wait', 'Pensando...')); $('#log').scrollTop = $('#log').scrollHeight; $('#go').disabled = true; fit();
  let r;
  try { r = await window.api.quickAsk(q); } catch { r = { error: 'page', message: 'O app não conseguiu falar com o Claude. Tente de novo.' }; }
  busy = false;
  if (r && r.text) info = { ...info, turns: [...info.turns, { role: 'assistant', content: r.text }] };
  else { info = { ...info, turns: info.turns.slice(0, -1) }; render(); $('#log').append(line('error', (r && r.message) || 'O Claude não respondeu agora.')); $('#q').value = q; fit(); $('#q').focus(); return; }
  render(); $('#q').focus();
}
$('#form').onsubmit = (e) => { e.preventDefault(); ask($('#q').value); };
$('#x').onclick = () => window.api.quickHide();
$('#clear').onclick = async () => { info = await window.api.quickClear(); render(); $('#q').focus(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); window.api.quickHide(); } });
window.api.onQuickOpen((i) => { info = i; busy = Boolean(i.busy); render(); $('#q').focus(); $('#q').select(); });
window.api.quickInfo().then((i) => { info = i; render(); }).catch(() => {});
