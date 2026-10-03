// Estatísticas da aba Evolução (histórico de partidas, mapas, recordes, metas e semana).
// Lógica pura, sem Electron, para poder testar com Node.
const RESULTS = ['V', 'D', 'E'];
const RES_LABEL = { V: 'Vitória', D: 'Derrota', E: 'Empate' };
const hasKd = (m) => m.k != null && m.d != null;
const ratio = (k, d) => k / Math.max(1, d);

// Meia-noite (hora local) do dia de `t`, e a segunda-feira da semana.
function dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function addDays(t, n) { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); }
function weekStart(t) {
  const d = new Date(dayStart(t));
  return addDays(d.getTime(), -((d.getDay() + 6) % 7));
}

// Números no jeito brasileiro (1,25 · 61% · 12h 05m).
const fmtNum = (v, digits = 2) => (v == null ? '–' : v.toFixed(digits).replace('.', ','));
const fmtPct = (r) => (r == null ? '–' : `${Math.round(r * 100)}%`);
function fmtHours(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  if (s < 3600) return `${Math.max(s ? 1 : 0, Math.round(s / 60))} min`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const fmtDate = (t) => new Date(t).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

function summarize(list) {
  const decided = list.filter((m) => RESULTS.includes(m.res));
  const wins = decided.filter((m) => m.res === 'V').length;
  const losses = decided.filter((m) => m.res === 'D').length;
  const withKd = list.filter(hasKd);
  const kills = withKd.reduce((a, m) => a + m.k, 0);
  const deaths = withKd.reduce((a, m) => a + m.d, 0);
  const avg = (key) => { const v = list.filter((m) => m[key] != null); return v.length ? v.reduce((a, m) => a + m[key], 0) / v.length : null; };
  return {
    n: list.length, decided: decided.length, wins, losses, draws: decided.length - wins - losses,
    winRate: decided.length ? wins / decided.length : null,
    kills, deaths, kdN: withKd.length,
    kd: withKd.length ? ratio(kills, deaths) : null,
    avgKills: withKd.length ? kills / withKd.length : null,
    hs: avg('hs'), acs: avg('acs'),
  };
}

// Nome do mapa: o campo mapLabel/map, ou o começo da nota das partidas registradas pelo app ("Mirage · Competitivo, ...").
function mapOf(m) {
  if (m.mapLabel || m.map) return String(m.mapLabel || m.map);
  const head = /registrado pelo app do PC/.test(m.note || '') ? String(m.note).split(' · ')[0].split(',')[0].trim() : '';
  return head && head.length <= 30 ? head : null;
}

function byMap(list) {
  const groups = new Map();
  for (const m of list) {
    const label = mapOf(m);
    if (!label) continue;
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label, list: [] });
    groups.get(key).list.push(m);
  }
  return [...groups.values()].map((g) => ({ map: g.label, ...summarize(g.list) }))
    .sort((a, b) => b.n - a.n || a.map.localeCompare(b.map));
}

// Melhor e pior mapa (mínimo de 3 partidas): por % de vitórias quando o jogo tem resultado, senão por K/D.
function bestWorst(rows, min = 3) {
  const useWin = rows.some((r) => r.decided >= min);
  const val = (r) => (useWin ? (r.decided >= min ? r.winRate : null) : (r.kdN >= min ? r.kd : null));
  const ok = rows.filter((r) => val(r) != null);
  const metric = useWin ? 'win' : 'kd';
  if (ok.length < 2) return { best: null, worst: null, metric };
  const sorted = [...ok].sort((a, b) => val(b) - val(a) || b.n - a.n);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  return val(best) === val(worst) ? { best: null, worst: null, metric } : { best: best.map, worst: worst.map, metric };
}

// K/D de cada partida (as últimas `max`) com a média das últimas `win` partidas.
function kdSeries(list, max = 30, win = 5) {
  const pts = list.filter(hasKd).slice(-max).map((m) => ({ at: m.at, res: m.res || '', k: m.k, d: m.d, kd: ratio(m.k, m.d) }));
  pts.forEach((p, i) => {
    const w = pts.slice(Math.max(0, i - win + 1), i + 1);
    p.avg = ratio(w.reduce((a, x) => a + x.k, 0), w.reduce((a, x) => a + x.d, 0));
  });
  return pts;
}

// K/D das últimas `n` partidas contra as `n` anteriores.
function trend(list, n = 10) {
  const kd = list.filter(hasKd);
  if (kd.length < n + 3) return null;
  const recent = summarize(kd.slice(-n)).kd, before = summarize(kd.slice(-2 * n, -n)).kd;
  return { recent, before, diff: recent - before, n: Math.min(n, kd.length - n) };
}

function records(list, sessions = []) {
  const kd = list.filter(hasKd);
  const mostKills = kd.reduce((b, m) => (!b || m.k > b.k ? m : b), null);
  const bestKd = kd.filter((m) => m.k + m.d >= 10).reduce((b, m) => (!b || ratio(m.k, m.d) > ratio(b.k, b.d) ? m : b), null);
  let streak = 0, best = 0, bestAt = null;
  for (const m of [...list].sort((a, b) => a.at - b.at)) {
    if (!RESULTS.includes(m.res)) continue;
    if (m.res === 'V') { streak++; if (streak > best) { best = streak; bestAt = m.at; } } else streak = 0;
  }
  const longest = sessions.filter((s) => s.end).reduce((b, s) => (!b || s.end - s.start > b.end - b.start ? s : b), null);
  return { mostKills, bestKd, winStreak: best >= 2 ? { n: best, at: bestAt } : null, longestSession: longest };
}

// Segundos jogados entre `from` e `to` (sessões abertas contam até agora).
function playSeconds(sessions, from, to, game = null, now = Date.now()) {
  let sec = 0;
  for (const s of sessions) {
    if (game && s.gameId !== game) continue;
    const a = Math.max(s.start, from), b = Math.min(s.end || now, to);
    if (b > a) sec += (b - a) / 1000;
  }
  return sec;
}

function dailyPlaytime(sessions, { game = null, days = 7, now = Date.now() } = {}) {
  const today = dayStart(now);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    out.push({ day, sec: playSeconds(sessions, day, addDays(day, 1), game, now) });
  }
  return out;
}

function periodStats(history, sessions, { game = null, from, to, now = Date.now() }) {
  const list = history.filter((m) => !m.prog && (!game || m.game === game) && m.at >= from && m.at < to);
  return { ...summarize(list), sec: playSeconds(sessions, from, to, game, now) };
}

// Esta semana (desde segunda) contra a semana passada, jogo por jogo.
function weekly(history, sessions, now = Date.now()) {
  const cur = weekStart(now), prev = addDays(cur, -7);
  const ids = new Set([
    ...history.filter((m) => !m.prog && m.at >= prev).map((m) => m.game),
    ...sessions.filter((s) => (s.end || now) >= prev).map((s) => s.gameId),
  ]);
  return [...ids].map((game) => ({
    game,
    cur: periodStats(history, sessions, { game, from: cur, to: now + 1, now }),
    prev: periodStats(history, sessions, { game, from: prev, to: cur, now }),
  })).filter((r) => r.cur.sec >= 60 || r.prev.sec >= 60 || r.cur.n || r.prev.n)
    .sort((a, b) => (b.cur.sec + b.prev.sec) - (a.cur.sec + a.prev.sec));
}

// Uma frase sobre a semana que acabou, para o aviso de segunda-feira. null quando não houve jogo.
function lastWeekLine(history, sessions, now, nameOf = (id) => id) {
  const cur = weekStart(now), prev = addDays(cur, -7), before = addDays(prev, -7);
  const total = playSeconds(sessions, prev, cur, null, now);
  if (total < 600) return null;
  const rows = weekly(history, sessions, cur - 1).filter((r) => r.cur.n || r.cur.sec);
  let line = `📊 Semana passada: ${fmtHours(total)} de jogo.`;
  const top = rows.filter((r) => r.cur.n).sort((a, b) => b.cur.n - a.cur.n)[0];
  if (top) {
    const s = top.cur, old = periodStats(history, sessions, { game: top.game, from: before, to: prev, now });
    const parts = [`${s.n} ${s.n === 1 ? 'partida' : 'partidas'}`];
    if (s.winRate != null) parts.push(`${fmtPct(s.winRate)} de vitórias`);
    if (s.kd != null) parts.push(`K/D ${fmtNum(s.kd)}${old.kd != null ? ` (${s.kd >= old.kd ? '▲' : '▼'} ${fmtNum(Math.abs(s.kd - old.kd))})` : ''}`);
    line += ` ${nameOf(top.game)}: ${parts.join(', ')}.`;
  }
  return line;
}

// ---------- Metas ----------
const GOAL_TYPES = {
  kd: { label: 'K/D nas últimas 20 partidas', short: 'K/D', higher: true, digits: 2 },
  win: { label: '% de vitórias nas últimas 20 partidas', short: 'vitórias', higher: true, pct: true },
  kills: { label: 'Média de abates nas últimas 20 partidas', short: 'abates por partida', higher: true, digits: 1 },
  matches: { label: 'Partidas nesta semana', short: 'partidas na semana', higher: true, digits: 0 },
  hours: { label: 'Horas de jogo nesta semana (no máximo)', short: 'horas na semana', higher: false, digits: 1 },
};
const fmtGoal = (type, v) => (v == null ? '–' : GOAL_TYPES[type].pct ? `${Math.round(v)}%` : fmtNum(v, GOAL_TYPES[type].digits ?? 1));

function goalProgress(goal, history, sessions, now = Date.now()) {
  const t = GOAL_TYPES[goal.type];
  if (!t) return null;
  const mine = history.filter((m) => !m.prog && (!goal.game || m.game === goal.game)).sort((a, b) => a.at - b.at);
  const last = summarize(mine.slice(-20));
  let value = null, enough = true;
  if (goal.type === 'kd') { value = last.kd; enough = last.kdN >= 5; }
  if (goal.type === 'win') { value = last.winRate == null ? null : last.winRate * 100; enough = last.decided >= 5; }
  if (goal.type === 'kills') { value = last.avgKills; enough = last.kdN >= 5; }
  if (goal.type === 'matches') value = mine.filter((m) => m.at >= weekStart(now)).length;
  if (goal.type === 'hours') value = playSeconds(sessions, weekStart(now), now + 1, goal.game || null, now) / 3600;
  const target = Number(goal.target) || 0;
  const done = t.higher && enough && value != null && value >= target;
  const over = !t.higher && value != null && value > target;
  const pct = !target || value == null ? 0 : Math.max(0, Math.min(1, value / target));
  return { value, target, pct, done, over, enough, label: t.label, valueText: fmtGoal(goal.type, value), targetText: fmtGoal(goal.type, target) };
}

// ---------- Tudo que a aba Evolução mostra ----------
function evolution({ history = [], sessions = [], goals = [], game = null, days = 30, now = Date.now(), nameOf = (id) => id }) {
  const all = history.filter((m) => !m.prog).sort((a, b) => a.at - b.at);
  // Jogos com partidas ou tempo, os mais recentes primeiro.
  const last = {};
  all.forEach((m) => { last[m.game] = Math.max(last[m.game] || 0, m.at); });
  sessions.forEach((s) => { if ((s.end || now) - s.start >= 60000) last[s.gameId] = Math.max(last[s.gameId] || 0, s.end || now); });
  const games = Object.keys(last).sort((a, b) => last[b] - last[a])
    .map((id) => ({ id, name: nameOf(id), matches: all.filter((m) => m.game === id).length }));
  if (!game || !last[game]) game = (games.find((g) => g.matches) || games[0] || {}).id || null;
  const from = days ? addDays(dayStart(now), -(days - 1)) : 0;
  const prevFrom = days ? addDays(from, -days) : 0;
  const mineAll = all.filter((m) => m.game === game);
  const list = mineAll.filter((m) => m.at >= from);
  const sess = sessions.filter((s) => s.gameId === game);
  const summary = { ...summarize(list), sec: playSeconds(sess, from, now + 1, null, now) };
  const prev = days ? { ...summarize(mineAll.filter((m) => m.at >= prevFrom && m.at < from)), sec: playSeconds(sess, prevFrom, from, null, now) } : null;
  const maps = byMap(list);
  return {
    game, name: game ? nameOf(game) : null, days, games,
    summary, prev,
    hasKd: mineAll.some(hasKd), hasResults: mineAll.some((m) => RESULTS.includes(m.res)),
    series: kdSeries(list), trend: trend(list),
    playtime: dailyPlaytime(sess, { days: days && days <= 14 ? days : 30, now }),
    maps, mapPick: bestWorst(maps),
    records: records(mineAll, sess),
    recent: list.slice(-8).reverse(),
    goals: goals.map((g) => ({ ...g, gameName: g.game ? nameOf(g.game) : 'Todos os jogos', progress: goalProgress(g, history, sessions, now) })),
    week: weekly(history, sessions, now).map((r) => ({ ...r, name: nameOf(r.game) })),
  };
}

// Texto que vai para o Claude quando o Pedro pede dicas a partir da Evolução.
function claudeReport(ev, now = Date.now()) {
  const s = ev.summary, lines = [];
  const period = ev.days ? `últimos ${ev.days} dias` : 'todas as partidas guardadas';
  lines.push(`Quero uma análise da minha evolução no ${ev.name} (dados do app do PC, ${period}).`);
  if (s.n) {
    const parts = [`${s.n} partidas`];
    if (s.decided) parts.push(`${s.wins} vitórias, ${s.losses} derrotas${s.draws ? `, ${s.draws} empates` : ''} (${fmtPct(s.winRate)} de vitórias)`);
    if (s.kd != null) parts.push(`K/D ${fmtNum(s.kd)}, média de ${fmtNum(s.avgKills, 1)} abates`);
    if (s.hs != null) parts.push(`${Math.round(s.hs)}% de tiros na cabeça`);
    if (s.acs != null) parts.push(`ACS médio ${Math.round(s.acs)}`);
    lines.push(`- Resumo: ${parts.join('; ')}.`);
  }
  if (ev.trend) lines.push(`- Tendência: K/D das últimas ${ev.trend.n} partidas ${fmtNum(ev.trend.recent)}, contra ${fmtNum(ev.trend.before)} nas ${ev.trend.n} anteriores.`);
  if (ev.maps.length) {
    lines.push(`- Mapas: ${ev.maps.slice(0, 8).map((r) => `${r.map} ${r.n} ${r.n === 1 ? 'partida' : 'partidas'}${r.decided ? `, ${fmtPct(r.winRate)} de vitórias` : ''}${r.kd != null ? `, K/D ${fmtNum(r.kd)}` : ''}`).join('; ')}.`);
  }
  lines.push(`- Tempo de jogo: ${fmtHours(s.sec)} no período.`);
  const goals = ev.goals.filter((g) => !g.game || g.game === ev.game);
  if (goals.length) lines.push(`- Minhas metas: ${goals.map((g) => `${g.progress.label} ${GOAL_TYPES[g.type].higher ? '≥' : '≤'} ${g.progress.targetText} (agora ${g.progress.valueText})`).join('; ')}.`);
  if (ev.recent.length) {
    lines.push(`- Últimas partidas: ${ev.recent.map((m) => `${fmtDate(m.at)} ${RES_LABEL[m.res] || 'sem resultado'}${hasKd(m) ? ` ${m.k}/${m.a ?? '?'}/${m.d}` : ''}${mapOf(m) ? ` em ${mapOf(m)}` : ''}`).join('; ')}.`);
  }
  if (!s.n) lines.push('- Ainda não tenho partidas registradas neste período.');
  lines.push('Com base nisso, me diga em poucas linhas o que está melhorando, o que está piorando e 3 coisas específicas para eu treinar esta semana.');
  return lines.join('\n');
}

module.exports = {
  dayStart, addDays, weekStart, fmtNum, fmtPct, fmtHours, fmtDate, summarize, mapOf, byMap, bestWorst, kdSeries, trend,
  records, playSeconds, dailyPlaytime, periodStats, weekly, lastWeekLine, GOAL_TYPES, fmtGoal, goalProgress, evolution, claudeReport,
};
