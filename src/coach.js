// Coach depois de cada partida: uma dica rápida feita pelo próprio app (a partida contra a sua média)
// e o pedido para o Claude escrever uma dica curta. Usa só as partidas do Pedro. Lógica pura, testável com Node.
const stats = require('./stats');

const RESULTS = ['V', 'D', 'E'];
const RES_LABEL = { V: 'Vitória', D: 'Derrota', E: 'Empate' };
const hasKd = (m) => m.k != null && m.d != null;
const kdOf = (m) => m.k / Math.max(1, m.d);
const MODES = { competitive: 'Competitivo', premier: 'Premier', casual: 'Casual', deathmatch: 'Mata-mata', scrimcomp2v2: 'Wingman' };

// Partidas anteriores do mesmo jogo (até 20), a sequência de resultados e o histórico no mesmo mapa.
function context(match, history, game) {
  const prev = (history || []).filter((m) => m.game === game && !m.prog && m.at < match.at - 500).slice(-20);
  const avg = stats.summarize(prev);
  const decided = [...prev, match].filter((m) => RESULTS.includes(m.res));
  let streak = null;
  for (let i = decided.length - 1; i >= 0; i--) {
    if (!streak) streak = { kind: decided[i].res, n: 0 };
    if (decided[i].res !== streak.kind) break;
    streak.n++;
  }
  if (!RESULTS.includes(match.res)) streak = null;
  const map = stats.mapOf(match);
  const onMap = map ? prev.filter((m) => (stats.mapOf(m) || '').toLowerCase() === map.toLowerCase()) : [];
  const avgDeaths = avg.kdN ? avg.deaths / avg.kdN : null;
  return { prev, avg, avgDeaths, streak, map, mapStats: onMap.length >= 2 ? stats.summarize([...onMap, match]) : null };
}

// O que treinar, por jogo e pelo motivo da dica.
const FOCUS = {
  cs2: {
    deaths: 'Na próxima, jogue perto do time e use uma granada antes de entrar no bomb, em vez de dar peek sozinho.',
    kills: 'Aqueça 10 minutos de mira antes da próxima (aim_botz ou mata-mata) e mire na altura da cabeça.',
    good: 'Repita o que funcionou: mesma posição e mesmo ritmo nas próximas.',
    map: 'Antes de jogar de novo esse mapa, veja 2 ou 3 smokes básicas dele e combine com o time.',
  },
  valorant: {
    deaths: 'Na próxima, use as habilidades do agente para entrar e evite duelar sozinho.',
    kills: 'Pare antes de atirar (counter-strafe) e deixe a mira na altura da cabeça.',
    hs: 'Mire na altura da cabeça o tempo todo e atire parado; os primeiros tiros são os mais certos.',
    good: 'Repita o que funcionou: mesmo agente e mesmo ritmo nas próximas.',
    map: 'Antes de jogar de novo esse mapa, veja uma rotação e os lineups básicos do seu agente.',
  },
  tf2: {
    deaths: 'Fique mais perto do Medic e das caixas de vida; recue quando a vida passar da metade.',
    kills: 'Escolha um alvo e acompanhe o time no ataque, em vez de flanquear sozinho.',
    good: 'Continue com a mesma classe e o mesmo ritmo.',
    map: 'Nesse mapa, procure as rotas de flanco e os pontos de vida.',
  },
  default: {
    deaths: 'Na próxima, jogue com mais calma e perto do time; menos mortes ajudam mais que mais abates.',
    kills: 'Aqueça a mira por alguns minutos antes de jogar e foque em acertar os primeiros tiros.',
    good: 'Repita o que funcionou nesta partida.',
    map: 'Antes de jogar esse mapa de novo, veja um guia rápido das rotas principais.',
  },
};
const focus = (game, why) => (FOCUS[game] && FOCUS[game][why]) || FOCUS.default[why];

// Dica rápida, sem internet. Retorna { title, text, facts, mood }.
function localTip(match, ctx, game) {
  const facts = [];
  const a = ctx.avg, enough = a.kdN >= 3;
  const kd = hasKd(match) ? kdOf(match) : null;
  if (kd != null) facts.push(`K/D ${stats.fmtNum(kd)}${enough ? ` (média ${stats.fmtNum(a.kd)})` : ''}`);
  if (match.hs != null) facts.push(`${Math.round(match.hs)}% na cabeça${a.hs != null ? ` (média ${Math.round(a.hs)}%)` : ''}`);
  if (match.acs != null) facts.push(`ACS ${Math.round(match.acs)}${a.acs != null ? ` (média ${Math.round(a.acs)})` : ''}`);
  if (ctx.streak && ctx.streak.n >= 2) facts.push(`${ctx.streak.n}ª ${ctx.streak.kind === 'V' ? 'vitória' : ctx.streak.kind === 'D' ? 'derrota' : 'empate'} seguida`);
  if (ctx.mapStats && ctx.mapStats.decided >= 3) facts.push(`${ctx.map}: ${stats.fmtPct(ctx.mapStats.winRate)} de vitórias`);

  const s = ctx.streak;
  if (s && s.kind === 'D' && s.n >= 3) {
    return { title: `${s.n} derrotas seguidas`, text: `${s.n} derrotas seguidas. Faça uma pausa de 5 minutos, beba água e volte: cansaço e raiva pesam mais que a mira.`, facts, mood: 'bad' };
  }
  if (kd != null && enough && a.kd != null && kd < a.kd * 0.75 && ctx.avgDeaths != null && match.d >= ctx.avgDeaths * 1.25) {
    return { title: 'Morreu mais que o normal', text: `Você morreu ${match.d} vezes, contra ${stats.fmtNum(ctx.avgDeaths, 1)} na sua média. ${focus(game, 'deaths')}`, facts, mood: 'bad' };
  }
  if (match.hs != null && a.hs != null && a.kdN >= 3 && match.hs < a.hs - 6) {
    return { title: 'Poucos tiros na cabeça', text: `${Math.round(match.hs)}% dos tiros na cabeça, abaixo dos seus ${Math.round(a.hs)}%. ${focus(game, 'hs') || focus(game, 'kills')}`, facts, mood: 'bad' };
  }
  if (kd != null && enough && a.avgKills != null && match.k < a.avgKills * 0.7) {
    return { title: 'Poucos abates', text: `${match.k} abates, abaixo da sua média de ${stats.fmtNum(a.avgKills, 1)}. ${focus(game, 'kills')}`, facts, mood: 'bad' };
  }
  if (ctx.mapStats && ctx.mapStats.decided >= 3 && ctx.mapStats.winRate < 0.4 && match.res === 'D') {
    return { title: `${ctx.map} está difícil`, text: `${stats.fmtPct(ctx.mapStats.winRate)} de vitórias em ${ctx.mapStats.decided} partidas na ${ctx.map}. ${focus(game, 'map')}`, facts, mood: 'bad' };
  }
  if (s && s.kind === 'V' && s.n >= 3) {
    return { title: `${s.n} vitórias seguidas`, text: `${s.n} vitórias seguidas! ${focus(game, 'good')}`, facts, mood: 'good' };
  }
  if (kd != null && enough && a.kd != null && kd >= a.kd * 1.25) {
    return { title: 'Acima da sua média', text: `K/D ${stats.fmtNum(kd)}, acima da sua média de ${stats.fmtNum(a.kd)}. ${focus(game, 'good')}`, facts, mood: 'good' };
  }
  if (kd != null && !enough) {
    return { title: 'Coach aprendendo', text: `${match.k} abates e ${match.d} mortes. Depois de 3 partidas registradas, eu comparo cada uma com a sua média.`, facts, mood: 'neutral' };
  }
  if (kd == null) {
    return { title: RES_LABEL[match.res] || 'Partida registrada', text: 'Partida registrada. Com abates e mortes, eu consigo comparar com a sua média.', facts, mood: 'neutral' };
  }
  return { title: 'Na sua média', text: `Partida na sua média (K/D ${stats.fmtNum(kd)}). ${focus(game, match.res === 'D' ? 'deaths' : 'good')}`, facts, mood: 'neutral' };
}

// Pedido para o Claude: só os números do Pedro, e a resposta curta (cabe no aviso e no HUD).
function coachPrompt(match, ctx, gameName) {
  const parts = [];
  if (RESULTS.includes(match.res)) parts.push(RES_LABEL[match.res]);
  if (hasKd(match)) parts.push(`${match.k}/${match.a ?? '?'}/${match.d} (abates/assistências/mortes, K/D ${stats.fmtNum(kdOf(match))})`);
  if (ctx.map) parts.push(`mapa ${ctx.map}`);
  if (MODES[match.mode]) parts.push(`modo ${MODES[match.mode]}`);
  if (Array.isArray(match.score)) parts.push(`placar ${match.score[0]}-${match.score[1]}`);
  if (match.agent) parts.push(`agente ${match.agent}`);
  if (match.mvps) parts.push(`${match.mvps} MVP`);
  if (match.hs != null) parts.push(`${Math.round(match.hs)}% dos tiros na cabeça`);
  if (match.acs != null) parts.push(`ACS ${Math.round(match.acs)}`);
  if (match.best) parts.push(`melhor sequência ${match.best}`);
  const lines = [`Você é o coach do Pedro em ${gameName}. Ele acabou de terminar uma partida. Dados (só dele, tirados do jogo):`];
  lines.push(`- Esta partida: ${parts.join(', ') || 'sem números'}.`);
  const a = ctx.avg;
  if (a.n) {
    const avg = [`${a.n} ${a.n === 1 ? 'partida' : 'partidas'}`];
    if (a.kd != null) avg.push(`K/D ${stats.fmtNum(a.kd)}`, `${stats.fmtNum(a.avgKills, 1)} abates e ${stats.fmtNum(ctx.avgDeaths, 1)} mortes por partida`);
    if (a.winRate != null) avg.push(`${stats.fmtPct(a.winRate)} de vitórias`);
    if (a.hs != null) avg.push(`${Math.round(a.hs)}% na cabeça`);
    if (a.acs != null) avg.push(`ACS ${Math.round(a.acs)}`);
    lines.push(`- Média das partidas anteriores: ${avg.join(', ')}.`);
  } else lines.push('- É a primeira partida registrada neste jogo.');
  if (ctx.mapStats && ctx.mapStats.decided) lines.push(`- Neste mapa: ${ctx.mapStats.n} partidas, ${stats.fmtPct(ctx.mapStats.winRate)} de vitórias.`);
  if (ctx.streak && ctx.streak.n >= 2) lines.push(`- Sequência: ${ctx.streak.n} ${ctx.streak.kind === 'V' ? 'vitórias' : ctx.streak.kind === 'D' ? 'derrotas' : 'empates'} seguidas.`);
  lines.push('Responda em português do Brasil com no máximo 2 frases curtas (até 40 palavras): o que foi bem ou mal comparando com a média, e 1 coisa prática e específica para a próxima partida. Não invente números nem fatos que não estão acima. Sem saudação, sem listas, sem markdown.');
  return lines.join('\n');
}

// Limpa a resposta do Claude para caber no aviso e no HUD.
function cleanTip(text) {
  let t = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_#>`]+/g, '').replace(/^\s*[-•]\s*/gm, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(coach|dica)\s*:\s*/i, '').replace(/^["“]|["”]$/g, '').trim();
  if (t.length > 320) {
    const cut = t.slice(0, 320), end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
    t = end > 120 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
  }
  return t || null;
}

// Texto para conversar mais no Claude sobre a partida (botão do painel).
function followUp(match, ctx, gameName, tipText) {
  return `${coachPrompt(match, ctx, gameName).split('\nResponda')[0]}\n${tipText ? `O coach do app disse: "${tipText}"\n` : ''}Me explique melhor o que eu posso melhorar com base nesses números e me passe um treino de 10 minutos para fazer antes da próxima partida.`;
}

module.exports = { context, localTip, coachPrompt, cleanTip, followUp, FOCUS };
