// Lógica pura (sem Electron), para poder testar com Node.
const fs = require('fs');
const path = require('path');

function loadGames(dataDir) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'games.json'), 'utf8'));
}

const normalize = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// steamApp: { appId, name } do jogo que a Steam diz estar rodando (ou null).
// cmdlines: linhas de comando dos processos Java, para diferenciar modpacks (ex.: Cobblemon).
// Ordem: Steam por appId, Steam por nome, depois nome do executável.
// Jogo da Steam fora da lista vira uma entrada genérica, para contar o tempo mesmo assim.
function detectGame(processNames, games, steamApp = null, cmdlines = []) {
  if (steamApp && steamApp.appId) {
    const byId = games.find((g) => g.steamAppId === steamApp.appId);
    if (byId) return byId;
    const byName = steamApp.name && games.find((g) => normalize(g.name) === normalize(steamApp.name));
    if (byName) return byName;
  }
  const running = new Set(processNames.map((p) => p.toLowerCase()));
  const joined = cmdlines.join('\n').toLowerCase();
  const byExe = games.find((g) => g.exe.some((e) => running.has(e.toLowerCase()))
    && (!g.cmdlineMatch || joined.includes(g.cmdlineMatch.toLowerCase())));
  if (byExe) return byExe;
  if (steamApp && steamApp.appId) {
    return { id: `steam-${steamApp.appId}`, name: steamApp.name || `Jogo Steam ${steamApp.appId}`, tips: [], guides: [], exe: [] };
  }
  return null;
}

// Lê um valor da saída de `reg query` (ex.: RunningAppID    REG_DWORD    0x2da).
function parseRegValue(output, key) {
  const m = output.match(new RegExp(`${key}\\s+REG_\\w+\\s+(.+)`, 'i'));
  if (!m) return null;
  const v = m[1].trim();
  return /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : v;
}

// Nome do jogo no arquivo appmanifest_<id>.acf da Steam.
function parseAcfName(text) {
  const m = text.match(/"name"\s+"([^"]+)"/);
  return m ? m[1] : null;
}

// Pastas de biblioteca listadas em steamapps/libraryfolders.vdf.
function parseLibraryFolders(text) {
  return [...text.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, '\\'));
}

// Converte a saída de `tasklist /fo csv /nh` (Windows) ou `ps -A -o comm=` em nomes de processos.
function parseProcessList(output, platform) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (platform === 'win32') {
    return lines.map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean);
  }
  return lines.map((l) => path.basename(l.trim()));
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

const DEFAULT_STATE = {
  notes: {},        // { gameId: "texto" }
  playtime: {},     // { gameId: segundos }
  names: {},        // { gameId: nome }, para jogos da Steam fora da lista
  sessions: [],     // [{ gameId, start, end, fpsAvg?, fpsLow?, rating?, note? }]
  cs2Matches: [],   // partidas do CS2 registradas pelo modo ao vivo
  ignoredExe: [],   // programas marcados como "não é um jogo"
  pendingMatches: [], // partidas ainda não enviadas para a janela do Claude
  history: [],      // todas as partidas, para a aba Evolução: [{ game, at, res, k, a, d, map, ... }]
  goals: [],        // metas: [{ id, game, type, target, doneAt?, warnedWeek? }]
  lastWeekly: 0,    // segunda-feira do último aviso de resumo da semana
  coachTips: [],    // dicas do coach depois de cada partida: [{ id, game, at, local, ai, status }]
  settings: {
    opacity: 90, size: 'normal', cornerToasts: true, sound: true,
    hud: false, hudCorner: 'tl', hudItems: { fps: true, perf: true, session: true, clock: false, timer: true, cs2: true, live: true, coach: true, net: true },
    turboPower: false, turboAlerts: true, dailyLimitMin: 0,
    clips: false, clipSeconds: 30, clipAuto: true, clipQuality: '720',
    coach: true, coachAi: true,
    voice: true, voiceVolume: 80, voiceEvents: { buy: true, timers: true, coach: true, net: true, goals: true, fps: false },
    net: true, netHost: '1.1.1.1',
    autoUpdate: true,
  },
  reminders: [
    { id: 'agua', label: 'Beber água', everyMin: 30, enabled: true },
    { id: 'postura', label: 'Pausa e alongar', everyMin: 60, enabled: true }
  ]
};

class Store {
  constructor(file) {
    this.file = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.state = { ...structuredClone(DEFAULT_STATE), ...saved };
      // Ajustes novos ganham o valor padrão sem perder os que o Pedro já mudou.
      this.state.settings = { ...DEFAULT_STATE.settings, ...(saved.settings || {}) };
      this.state.settings.hudItems = { ...DEFAULT_STATE.settings.hudItems, ...((saved.settings || {}).hudItems || {}) };
      this.state.settings.voiceEvents = { ...DEFAULT_STATE.settings.voiceEvents, ...((saved.settings || {}).voiceEvents || {}) };
    } catch {
      this.state = structuredClone(DEFAULT_STATE);
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }
  addPlaytime(gameId, seconds) {
    this.state.playtime[gameId] = (this.state.playtime[gameId] || 0) + seconds;
  }
  startSession(gameId, now = Date.now()) {
    this.state.sessions.push({ gameId, start: now, end: null });
  }
  // extra: dados do fim da sessão (FPS médio, FPS mais baixo). Retorna a sessão encerrada.
  endSession(now = Date.now(), extra = {}) {
    const s = this.state.sessions[this.state.sessions.length - 1];
    let ended = null;
    if (s && s.end === null) { s.end = now; Object.assign(s, extra); ended = s; }
    this.state.sessions = this.state.sessions.slice(-1000);
    return ended;
  }
  // Guarda uma partida no histórico da Evolução. Retorna false quando ela já estava lá (mesmo jogo e horário).
  addMatch(game, m) {
    if (!game || !m || !m.at || m.prog) return false;
    const list = this.state.history || (this.state.history = []);
    if (list.some((x) => x.game === game && Math.abs(x.at - m.at) < 1000)) return false;
    const keep = {};
    for (const k of ['at', 'res', 'k', 'a', 'd', 'map', 'mapLabel', 'mode', 'score', 'mvps', 'agent', 'acs', 'hs', 'best', 'src']) if (m[k] != null && m[k] !== '') keep[k] = m[k];
    if (keep.res == null) keep.res = '';
    if (m.note && !keep.map && !keep.mapLabel) keep.note = String(m.note).slice(0, 200);
    list.push({ game, ...keep });
    list.sort((a, b) => a.at - b.at);
    if (list.length > 3000) list.splice(0, list.length - 3000);
    return true;
  }
  // Nota que o Pedro dá para a sessão no resumo (bom, ok, ruim) e um comentário opcional.
  rateSession(start, rating, note = '') {
    const s = this.state.sessions.find((x) => x.start === start);
    if (s) { s.rating = rating; if (note) s.note = String(note).slice(0, 300); }
    return Boolean(s);
  }
}

module.exports = { loadGames, detectGame, parseRegValue, parseAcfName, parseLibraryFolders, normalize, parseProcessList, formatDuration, Store, DEFAULT_STATE };
