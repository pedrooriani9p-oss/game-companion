// Valorant ao vivo pelo cliente da Riot que roda no PC (a mesma API local que o próprio cliente usa).
// Só lê os dados do próprio Pedro; não toca no jogo nem no anti-cheat. Lógica pura, testável com Node.

// Nomes internos dos mapas (o jogo manda "/Game/Maps/Triad/Triad", por exemplo).
const MAP_CODES = {
  ascent: 'Ascent', bonsai: 'Split', triad: 'Haven', duality: 'Bind', port: 'Icebox', foxtrot: 'Breeze', canyon: 'Fracture',
  pitt: 'Pearl', jam: 'Lotus', juliett: 'Sunset', infinity: 'Abyss', rook: 'Corrode', range: 'Campo de treino',
  hurm_alley: 'District', hurm_yard: 'Piazza', hurm_bowl: 'Kasbah', hurm_helix: 'Drift', hurm_hightide: 'Glitch',
};
const QUEUES = {
  competitive: 'Competitivo', unrated: 'Sem classificação', swiftplay: 'Partida rápida', spikerush: 'Disputa da Spike',
  deathmatch: 'Mata-mata', ggteam: 'Escalada', onefa: 'Replicação', hurm: 'Mata-mata em equipe', premier: 'Premier',
  newmap: 'Mapa novo', snowball: 'Guerra de bolas de neve', '': 'Personalizada',
};
const MAP_TIPS = {
  Ascent: ['Controle o Meio (Mid): ele abre o caminho para o A e para o B.', 'As portas do A e do B podem ser fechadas: use isso para atrasar o ataque.', 'No B, a smoke no Mercado corta a rotação dos defensores.'],
  Bind: ['Os teleportes fazem barulho: dá para fingir que vai e voltar.', 'No A, smoke no Céu (Heaven) e no Hookah do B antes de entrar.', 'Não há Meio: a rotação é por teleporte ou pelo spawn.'],
  Haven: ['São três bombs: rotacione rápido e confie nas informações.', 'O Garagem (C) e o Meio dão acesso para o B e o C.', 'Na defesa, alguém precisa segurar o Long A sozinho no começo.'],
  Split: ['O Meio com as cordas liga os dois bombs: controle ele.', 'No B, o Céu dos defensores vê quase todo o bomb.', 'Use as cordas sem barulho para pegar o inimigo de surpresa.'],
  Icebox: ['No B, o Amarelo (contêineres) é o ponto-chave para plantar.', 'As tirolesas fazem barulho: cuidado ao usar.', 'No A, plante atrás das caixas para não ser visto do Céu.'],
  Breeze: ['Mapa grande: armas de longe (Vandal, Operator) brilham aqui.', 'As portas do Meio podem ser fechadas por um botão.', 'No A, cuidado com a Caverna e o Céu ao mesmo tempo.'],
  Fracture: ['Os atacantes nascem dos dois lados: ataquem em pinça.', 'A tirolesa do meio leva rápido de um lado ao outro.', 'Na defesa, fique atento às costas: o ataque pode vir por trás.'],
  Pearl: ['Sem truques: controle do Meio decide a rodada.', 'No B, o Long é enorme; use smoke para cruzar.', 'No A, o Arte (Art) e o Elo (Link) são as entradas principais.'],
  Lotus: ['Três bombs e portas giratórias que fazem barulho ao abrir.', 'No A, a parede do Tronco pode ser quebrada para abrir caminho.', 'No C, o Cascata dá uma entrada rápida.'],
  Sunset: ['O Meio (Mercado) dá acesso aos dois bombs.', 'No B, smoke no Boulevard antes de entrar.', 'No A, cuidado com o Elo (Link) e o Céu.'],
  Abyss: ['Não há paredes nas bordas: cair do mapa mata.', 'No A, use a torre para ver a entrada inteira.', 'No B, cuidado com o Céu dos defensores.'],
  Corrode: ['Controle o Meio para dividir a defesa.', 'Use as smokes para cortar as linhas de visão longas.', 'Comunique sempre onde viu inimigos.'],
};
const STATES = { MENUS: 'No menu', PREGAME: 'Seleção de agentes', INGAME: 'Em partida' };

// Arquivo lockfile do Riot Client: "Riot Client:<pid>:<porta>:<senha>:https".
function parseLockfile(text) {
  const p = String(text || '').trim().split(':');
  if (p.length < 5) return null;
  return { name: p[0], pid: Number(p[1]), port: Number(p[2]), password: p[3], protocol: p[4] };
}

// "/Game/Maps/Triad/Triad" -> "Haven". names: tabela de nomes vinda da internet (opcional).
function mapName(url, names = {}) {
  if (!url) return '';
  if (names[url]) return names[url];
  const code = String(url).split('/').filter(Boolean).pop() || '';
  return MAP_CODES[code.toLowerCase()] || code;
}

// O "private" da presença é um JSON em base64. Versões novas aninham os campos; juntamos tudo num nível.
function flatten(obj, out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, out);
    else if (!(k in out)) out[k] = v;
  }
  return out;
}
function decodePresence(b64) {
  try { return flatten(JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'))); } catch { return null; }
}

// Presença do próprio jogador -> o que o painel mostra.
function liveFromPresence(p, names = {}) {
  if (!p) return null;
  const loop = p.sessionLoopState || p.partyOwnerSessionLoopState || 'MENUS';
  const mapUrl = p.matchMap || p.partyOwnerMatchMap || '';
  const map = loop === 'MENUS' ? '' : mapName(mapUrl, names);
  const queue = p.queueId ?? '';
  const custom = p.provisioningFlow === 'CustomGame';
  const ally = Number(p.partyOwnerMatchScoreAllyTeam ?? 0), enemy = Number(p.partyOwnerMatchScoreEnemyTeam ?? 0);
  return {
    loop, stateLabel: STATES[loop] || loop, map, mapUrl, queue, queueLabel: custom ? 'Personalizada' : QUEUES[queue] ?? queue,
    ally, enemy, tips: MAP_TIPS[map] || [],
  };
}

// Percebe o fim da partida (saiu de "Em partida" para o menu).
class ValorantLive {
  constructor() { this.state = null; this.lastIngame = null; }
  update(p, names) {
    const s = liveFromPresence(p, names);
    let ended = null;
    if (s && s.loop === 'INGAME') this.lastIngame = s;
    if (s && s.loop === 'MENUS' && this.lastIngame) { ended = this.lastIngame; this.lastIngame = null; }
    this.state = s;
    return { state: s, ended };
  }
}

// Região e versão no registro do jogo (ShooterGame.log).
function parseShooterLog(text) {
  const m = String(text).match(/https:\/\/glz-([a-z0-9]+)-1\.([a-z0-9]+)\.a\.pvp\.net/);
  const v = String(text).match(/CI server version:\s*(\S+)/);
  return { region: m ? m[1] : null, shard: m ? m[2] : null, version: v ? v[1] : null };
}

// Detalhes da partida (match-details) -> partida para o histórico. agents: { uuid: nome }.
function summarizeMatch(d, puuid, { agents = {}, maps = {} } = {}) {
  const info = d && d.matchInfo;
  const me = d && (d.players || []).find((x) => x.subject === puuid);
  if (!info || !me) return null;
  const queue = info.queueID ?? info.queueId ?? '';
  const map = mapName(info.mapId, maps);
  const st = me.stats || {};
  const teams = d.teams || [];
  const mine = teams.find((t) => t.teamId === me.teamId), other = teams.find((t) => t.teamId !== me.teamId);
  const pts = (t) => (t ? (queue === 'hurm' ? t.numPoints ?? t.roundsWon : t.roundsWon) : null);
  let res = '';
  if (queue !== 'deathmatch' && mine && other) res = mine.won ? 'V' : other.won ? 'D' : 'E';
  let hs = 0, shots = 0;
  for (const r of d.roundResults || []) {
    const ps = (r.playerStats || []).find((x) => x.subject === puuid);
    for (const dmg of (ps && ps.damage) || []) { hs += dmg.headshots || 0; shots += (dmg.headshots || 0) + (dmg.bodyshots || 0) + (dmg.legshots || 0); }
  }
  const acs = st.roundsPlayed ? Math.round(st.score / st.roundsPlayed) : null;
  const agent = agents[String(me.characterId).toLowerCase()] || '';
  const parts = [`${map} · ${QUEUES[queue] ?? queue}`];
  if (queue !== 'deathmatch' && pts(mine) != null && pts(other) != null) parts.push(`placar ${pts(mine)}-${pts(other)}`);
  if (agent) parts.push(`agente ${agent}`);
  if (acs != null) parts.push(`${acs} ACS`);
  if (shots) parts.push(`${Math.round((hs / shots) * 100)}% na cabeça`);
  return {
    at: info.gameStartMillis ? info.gameStartMillis + (info.gameLengthMillis || 0) : Date.now(),
    res, k: st.kills ?? null, a: st.assists ?? null, d: st.deaths ?? null,
    note: `${parts.join(', ')} (registrado pelo app do PC)`, map, matchId: info.matchId,
    mode: QUEUES[queue] ?? queue, agent: agent || null, acs, hs: shots ? Math.round((hs / shots) * 100) : null,
    score: queue !== 'deathmatch' && pts(mine) != null && pts(other) != null ? [pts(mine), pts(other)] : null,
  };
}

// Quando não deu para buscar os detalhes: usa o placar da presença.
function matchFromPresence(s, at = Date.now()) {
  const res = s.queue === 'deathmatch' ? '' : s.ally > s.enemy ? 'V' : s.ally < s.enemy ? 'D' : 'E';
  return { at, res, k: null, a: null, d: null, map: s.map, mode: s.queueLabel, score: s.queue === 'deathmatch' ? null : [s.ally, s.enemy], note: `${s.map} · ${s.queueLabel}${s.queue === 'deathmatch' ? '' : `, placar ${s.ally}-${s.enemy}`} (registrado pelo app do PC, sem K/D)` };
}

module.exports = { parseLockfile, mapName, decodePresence, flatten, liveFromPresence, ValorantLive, parseShooterLog, summarizeMatch, matchFromPresence, MAP_TIPS, QUEUES };
