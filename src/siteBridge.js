// Ligação do app com a página do Claude: o que mandar, quando mandar e como limpar as respostas.
// Lógica pura, testável com Node. Só vai para a página o que o jogo mostra para o próprio jogador
// (o seu mapa, placar, lado e números); nada de outros jogadores.
const stats = require('./stats');
const { MODES } = require('./cs2');

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu;

// CS2: estado de agora, com o placar do seu time primeiro. Sem dados (ou partida terminada): null.
function cs2Snapshot(s) {
  if (!s || !s.map || s.phase === 'gameover') return null;
  const mine = s.team === 'CT' ? s.ctScore : s.team === 'T' ? s.tScore : null;
  const other = s.team === 'CT' ? s.tScore : s.team === 'T' ? s.ctScore : null;
  return {
    game: 'cs2', map: s.mapLabel || s.map, mode: MODES[s.mode] || '',
    score: s.mode === 'deathmatch' || mine == null ? '' : `${mine}-${other}`,
    side: s.team === 'CT' ? 'CT' : s.team === 'T' ? 'T' : '', round: s.round ?? null,
    k: s.kills ?? null, a: s.assists ?? null, d: s.deaths ?? null,
  };
}

// Outros jogos: o cartão do modo ao vivo vira uma frase curta ("Ascent · Competitivo, Placar 5 x 3, Agente Jett").
function cardSnapshot(game, card) {
  if (!game || !card || card.game !== game) return null;
  const parts = [card.sub, ...(card.stats || []).map(([k, v]) => `${k} ${v}`)].filter(Boolean);
  const text = parts.join(', ').replace(EMOJI, '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return text ? { game, text } : null;
}

// Decide quando mandar o estado ao vivo: já quando muda o mapa, o modo ou o lado; no máximo a cada minGap quando só mudam
// os números; de tempos em tempos mesmo sem mudança (a página considera "ao vivo" por 3 minutos); e uma vez para limpar.
class LivePusher {
  constructor({ minGap = 15000, heartbeat = 90000, retry = 30000 } = {}) {
    Object.assign(this, { minGap, heartbeat, retry });
    this.last = null; this.lastKey = null; this.lastAt = 0; this.retryAt = 0;
  }
  static key(s) { return s ? `${s.game}|${s.map || ''}|${s.mode || ''}|${s.side || ''}|${s.map ? '' : s.text ? 't' : ''}` : ''; }
  // Retorna 'now', 'later' (mudou há pouco: tente de novo daqui a pouco) ou 'skip'.
  offer(snap, now = Date.now()) {
    if (now < this.retryAt) return 'skip';
    if (!snap) return this.last === null ? 'skip' : 'now';
    const body = JSON.stringify(snap);
    if (body === this.last) return now - this.lastAt >= this.heartbeat ? 'now' : 'skip';
    if (now - this.lastAt >= this.minGap || LivePusher.key(snap) !== this.lastKey) return 'now';
    return 'later';
  }
  commit(snap, now = Date.now()) { this.last = snap ? JSON.stringify(snap) : null; this.lastKey = snap ? LivePusher.key(snap) : null; this.lastAt = now; this.retryAt = 0; }
  fail(now = Date.now()) { this.retryAt = now + this.retry; }
}

// Metas medidas pelo app, no formato que a página mostra.
function goalRows(goals, history, sessions, now = Date.now()) {
  return (goals || []).map((g) => {
    const p = stats.goalProgress(g, history || [], sessions || [], now), t = stats.GOAL_TYPES[g.type];
    if (!p || !t) return null;
    return { id: String(g.id).slice(0, 40), game: g.game || null, label: p.label, valueText: p.valueText, targetText: p.targetText, pct: Math.round(p.pct * 100), done: Boolean(p.done), over: Boolean(p.over), higher: t.higher };
  }).filter(Boolean);
}

// Metas escritas na página: { jogo: [{ id, text, done }] }, já limpas.
function cleanPageGoals(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [game, list] of Object.entries(raw)) {
    if (!/^[a-z0-9-]{1,48}$/.test(game) || !Array.isArray(list)) continue;
    const clean = list.slice(0, 20).filter((x) => x && x.id != null && x.text).map((x) => ({ id: String(x.id).slice(0, 40), text: String(x.text).slice(0, 120), done: Boolean(x.done) }));
    if (clean.length) out[game] = clean;
  }
  return out;
}

// Resposta do Claude para ler ou ouvir: sem markdown, sem lista, sem emoji, em poucas frases.
function cleanAnswer(text, max = 600) {
  let t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(^|\s)\*([^*\n]+)\*(?=[\s.,;:!?]|$)/g, '$1$2')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ').trim();
  if (t.length > max) {
    const cut = t.slice(0, max), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
  }
  return t;
}

// Conversa da pergunta rápida: guarda as últimas trocas de um jogo e esquece depois de um tempo parado.
class QuickChat {
  constructor({ ttl = 30 * 60000, maxTurns = 6 } = {}) { Object.assign(this, { ttl, maxTurns }); this.game = null; this.list = []; this.at = 0; }
  turns(game, now = Date.now()) { return this.game === game && now - this.at < this.ttl ? this.list.map((t) => ({ ...t })) : []; }
  add(game, question, answer, now = Date.now()) {
    if (this.game !== game || now - this.at >= this.ttl) this.list = [];
    this.game = game; this.at = now;
    this.list = [...this.list, { role: 'user', content: String(question) }, { role: 'assistant', content: String(answer) }].slice(-this.maxTurns);
  }
  clear() { this.game = null; this.list = []; this.at = 0; }
}

const QUICK_ERR = {
  empty: 'Escreva a pergunta.',
  busy: 'Espere a resposta anterior.',
  nogame: 'Abra um jogo (ou escolha um no painel) para perguntar.',
  page: 'A janela do Claude não abriu. Faça login nela com Ctrl+Shift+W e tente de novo.',
  not_granted: 'O Claude ainda não liberou as perguntas: abra a janela do Claude (Ctrl+Shift+W) e faça uma pergunta uma vez.',
  sampling_disabled: 'As perguntas ao Claude não funcionam nesta conta.',
  unavailable: 'As perguntas ao Claude não funcionam nesta conta.',
  not_ready: 'O Claude ainda está abrindo. Tente de novo em alguns segundos.',
  rate_limited: 'Muitas perguntas seguidas ao Claude. Espere um pouco.',
  timeout: 'O Claude demorou demais. Tente de novo.',
  game: 'A página não reconheceu este jogo.',
  stale: 'A página do Claude está desatualizada. Feche e abra a janela do Claude (Ctrl+Shift+W).',
};
const quickError = (code) => QUICK_ERR[code] || 'O Claude não respondeu agora. Tente de novo.';

module.exports = { cs2Snapshot, cardSnapshot, LivePusher, goalRows, cleanPageGoals, cleanAnswer, QuickChat, quickError };
