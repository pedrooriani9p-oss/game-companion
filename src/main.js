const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, desktopCapturer, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const os = require('os');
const { FpsMeter } = require('./fps');
const { checkLatest } = require('./updater');
const path = require('path');
const si = require('systeminformation');
const fs = require('fs');
const { loadGames, detectGame, parseProcessList, parseRegValue, parseAcfName, parseLibraryFolders, Store } = require('./core');

const DATA_DIR = path.join(__dirname, '..', 'data');
const POLL_MS = 5000;
// Versão no navegador (dicas com IA, partidas, treino). O #id do jogo abre a página já no jogo certo.
const WEB_URL = 'https://claude.ai/artifact/Ho5efgDtKM6hrW9ib6Yvcm';
const FULL = { width: 380, height: 560 };
const COMPACT = { width: 380, height: 64 };
// Repositório no GitHub com as versões publicadas ("dono/nome"). Vazio desliga o aviso de atualização.
const UPDATE_REPO = 'pedrooriani9p-oss/game-companion';
// O login do Google recusa navegadores "embutidos"; sem a marca do Electron a janela do Claude se apresenta como Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|game-companion)\/\S+/gi, '');

let win;
let store;
let games = [];
let currentGame = null;
let clickThrough = false;
let compact = false;

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...FULL,
    x: workArea.x + workArea.width - FULL.width - 20,
    y: workArea.y + 20,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  });
  // Nível "screen-saver" fica por cima de jogos em tela cheia sem borda.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function listProcesses() {
  return new Promise((resolve) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['tasklist', ['/fo', 'csv', '/nh']]
      : ['ps', ['-A', '-o', 'comm=']];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      resolve(err ? [] : parseProcessList(out, process.platform));
    });
  });
}

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      resolve(err ? null : parseRegValue(out, value));
    });
  });
}

// A Steam grava o appId do jogo aberto em HKCU\Software\Valve\Steam\RunningAppID.
const steamNames = {};
async function steamRunningApp() {
  if (process.platform !== 'win32') return null;
  const appId = await regQuery('HKCU\\Software\\Valve\\Steam', 'RunningAppID');
  if (!appId) return null;
  if (!(appId in steamNames)) steamNames[appId] = await steamAppName(appId);
  return { appId, name: steamNames[appId] };
}

async function steamAppName(appId) {
  const steamPath = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (!steamPath) return null;
  let libs = [steamPath];
  try {
    libs = libs.concat(parseLibraryFolders(fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
  } catch {}
  for (const lib of libs) {
    try {
      return parseAcfName(fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${appId}.acf`), 'utf8'));
    } catch {}
  }
  return null;
}

// Linhas de comando do Java (Minecraft com mods), lidas só quando javaw.exe está aberto.
function javaCmdlines(procs) {
  if (process.platform !== 'win32' || !procs.some((p) => p.toLowerCase() === 'javaw.exe')) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"name='javaw.exe'\" | ForEach-Object { $_.CommandLine }"],
    { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? [] : out.split(/\r?\n/).filter(Boolean)));
  });
}

let manualGame = false;
async function pollGame() {
  if (manualGame) {
    if (currentGame) store.addPlaytime(currentGame.id, POLL_MS / 1000);
    store.save();
    return;
  }
  const [procs, steamApp] = await Promise.all([listProcesses(), steamRunningApp()]);
  const found = detectGame(procs, games, steamApp, await javaCmdlines(procs));
  if (currentGame) store.addPlaytime(currentGame.id, POLL_MS / 1000);
  if ((found && found.id) !== (currentGame && currentGame.id)) {
    if (currentGame) store.endSession();
    if (found) { store.startSession(found.id); store.state.names[found.id] = found.name; }
    currentGame = found;
    send('game-changed', currentGame);
    syncFps();
  }
  store.save();
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setClickThrough(on) {
  clickThrough = on;
  win.setIgnoreMouseEvents(on, { forward: true });
  send('mode', { clickThrough, compact });
}

function setCompact(on) {
  compact = on;
  const size = on ? COMPACT : FULL;
  // Algumas plataformas ignoram setSize em janela não redimensionável.
  win.setResizable(true);
  win.setBounds({ ...win.getBounds(), ...size });
  win.setResizable(false);
  send('mode', { clickThrough, compact });
}

// ---------- Janela do Claude (versão com perguntas, placar e imagens) ----------
let claudeWin = null;
const webUrl = () => (currentGame && !currentGame.id.startsWith('steam-') ? `${WEB_URL}#${currentGame.id}` : WEB_URL);
const AUTH_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|accounts\.google\.com|google\.com|appleid\.apple\.com|apple\.com)$/;
function openClaude({ focus = true } = {}) {
  if (claudeWin && !claudeWin.isDestroyed()) {
    const want = webUrl();
    if (claudeWin.webContents.getURL().split('#')[0] === WEB_URL && claudeWin.webContents.getURL() !== want) claudeWin.loadURL(want);
    if (focus) { claudeWin.show(); claudeWin.focus(); } else claudeWin.showInactive();
    return claudeWin;
  }
  const { workArea } = screen.getPrimaryDisplay();
  claudeWin = new BrowserWindow({
    width: Math.min(1280, workArea.width - 40), height: Math.min(860, workArea.height - 40),
    title: 'Game Companion · Claude', autoHideMenuBar: true, show: false, backgroundColor: '#12151d',
    webPreferences: { partition: 'persist:claude', backgroundThrottling: false }
  });
  // Login (Google, Apple) abre dentro do app; outros links vão para o navegador.
  claudeWin.webContents.setWindowOpenHandler(({ url }) => {
    try { if (AUTH_HOSTS.test(new URL(url).hostname)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: 'persist:claude' } } }; } catch {}
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  claudeWin.once('ready-to-show', () => { if (focus) claudeWin.show(); else claudeWin.showInactive(); });
  claudeWin.on('closed', () => { claudeWin = null; });
  claudeWin.loadURL(webUrl());
  return claudeWin;
}
const openWeb = () => openClaude();

// Procura, entre os quadros da página do Claude, o do Game Companion (o artifact roda num iframe).
async function findAppFrame(wc, timeoutMs = 25000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of wc.mainFrame.framesInSubtree) {
      try { if (await f.executeJavaScript('typeof window.gcPasteScore === "function"')) return f; } catch {}
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

// ---------- Print do placar com atalho ----------
let shotBusy = false;
async function captureScoreboard() {
  if (shotBusy) return;
  shotBusy = true;
  try {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) { send('toast', 'Não consegui tirar o print da tela.'); return; }
    // Deixa o print também na área de transferência (API nova do Electron, com a antiga de reserva).
    try {
      const { ClipboardItem } = require('electron');
      if (ClipboardItem) await clipboard.write([new ClipboardItem({ 'image/png': new Blob([src.thumbnail.toPNG()], { type: 'image/png' }) })]);
      else clipboard.writeImage(src.thumbnail);
    } catch {}
    send('toast', '📷 Print tirado. Lendo o placar na janela do Claude...');
    const w = openClaude({ focus: false });
    const frame = await findAppFrame(w.webContents);
    if (!frame) { send('toast', 'Print copiado. Abra a janela do Claude (Ctrl+Shift+W), faça login se pedir, e cole com Ctrl+V em Partidas.'); return; }
    const dataUrl = 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(92).toString('base64');
    await frame.executeJavaScript(`window.gcPasteScore(${JSON.stringify(dataUrl)})`);
    send('toast', 'Placar enviado. Confira os números na janela do Claude (Ctrl+Shift+W) e aperte Registrar partida.');
  } catch {
    send('toast', 'Não consegui enviar o print. Ele ficou copiado: cole com Ctrl+V em Partidas.');
  } finally { shotBusy = false; }
}

// ---------- FPS com PresentMon ----------
// O PresentMon (Intel, livre) lê os quadros do jogo pelo Windows. Precisa de administrador na primeira vez.
const fps = { proc: null, meter: null, exe: null, file: null, pos: 0, timer: null, status: 'off', admin: false };
const presentMonPath = () => (app.isPackaged ? path.join(process.resourcesPath, 'PresentMon.exe') : path.join(__dirname, '..', 'vendor', 'PresentMon.exe'));
function stopFps() {
  clearInterval(fps.timer); fps.timer = null;
  if (fps.proc) { try { fps.proc.kill(); } catch {} fps.proc = null; }
  if (fps.exe) execFile(presentMonPath(), ['--terminate_existing_session', '--session_name', 'GameCompanion'], { windowsHide: true }, () => {});
  fps.exe = null; fps.meter = null; fps.status = 'off';
}
function startFps(exe, asAdmin = false) {
  stopFps();
  if (process.platform !== 'win32' || !exe || !fs.existsSync(presentMonPath())) { fps.status = 'unavailable'; return; }
  fps.exe = exe; fps.meter = new FpsMeter(); fps.status = 'starting';
  fps.file = path.join(os.tmpdir(), 'game-companion-fps.csv'); fps.pos = 0;
  try { fs.rmSync(fps.file, { force: true }); } catch {}
  const args = ['--process_name', exe, '--output_file', fps.file, '--v1_metrics', '--no_console_stats', '--stop_existing_session', '--session_name', 'GameCompanion', '--terminate_on_proc_exit'];
  if (asAdmin) args.push('--restart_as_admin');
  fps.proc = spawn(presentMonPath(), args, { windowsHide: true });
  const started = Date.now();
  fps.proc.on('exit', (code) => {
    fps.proc = null;
    // Saiu logo de cara sem ter escrito nada: falta permissão de administrador.
    if (!asAdmin && Date.now() - started < 4000 && code !== 0 && fps.exe === exe) fps.status = 'needs-admin';
  });
  fps.proc.on('error', () => { fps.status = 'unavailable'; });
  // Lê só o que foi acrescentado ao arquivo desde a última leitura.
  fps.timer = setInterval(() => {
    fs.stat(fps.file, (err, st) => {
      if (err || st.size <= fps.pos) return;
      const stream = fs.createReadStream(fps.file, { start: fps.pos, end: st.size - 1, encoding: 'utf8' });
      fps.pos = st.size;
      stream.on('data', (c) => { if (fps.meter) { fps.meter.push(c); fps.status = 'on'; } });
    });
  }, 500);
}
function syncFps() {
  const exe = currentGame && currentGame.exe && currentGame.exe.find((e) => e.toLowerCase() !== 'javaw.exe') || (currentGame && currentGame.exe && currentGame.exe[0]);
  if (exe !== fps.exe) { if (exe) startFps(exe, fps.admin); else stopFps(); }
}

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (win.isVisible()) win.hide(); else win.showInactive();
  });
  globalShortcut.register('CommandOrControl+Shift+X', () => setClickThrough(!clickThrough));
  globalShortcut.register('CommandOrControl+Shift+M', () => setCompact(!compact));
  globalShortcut.register('CommandOrControl+Shift+W', openWeb);
  globalShortcut.register('CommandOrControl+Shift+P', captureScoreboard);
}

function registerIpc() {
  ipcMain.handle('get-state', () => ({ games, currentGame, state: store.state, mode: { clickThrough, compact } }));
  ipcMain.handle('save-note', (_e, gameId, text) => { store.state.notes[gameId] = text; store.save(); });
  ipcMain.handle('save-reminders', (_e, reminders) => { store.state.reminders = reminders; store.save(); });
  ipcMain.handle('set-game', (_e, gameId) => {
    // Seleção manual (vazio volta para detecção automática).
    if (currentGame) store.endSession();
    manualGame = Boolean(gameId);
    currentGame = games.find((g) => g.id === gameId) || null;
    if (currentGame) store.startSession(currentGame.id);
    send('game-changed', currentGame);
    syncFps();
  });
  ipcMain.handle('open-url', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.handle('set-compact', (_e, on) => setCompact(on));
  ipcMain.handle('open-web', () => openWeb());
  ipcMain.handle('open-web-external', () => shell.openExternal(webUrl()));
  ipcMain.handle('capture-score', () => captureScoreboard());
  ipcMain.handle('fps', () => ({ status: fps.status, ...(fps.meter && fps.meter.read()) }));
  ipcMain.handle('fps-admin', () => { fps.admin = true; const exe = fps.exe; fps.exe = null; if (exe) startFps(exe, true); });
  ipcMain.handle('open-update', (_e, url) => { if (/^https:\/\/github\.com\//.test(url)) shell.openExternal(url); });
  ipcMain.handle('hide', () => win.hide());
  ipcMain.handle('show', () => win.showInactive());
  ipcMain.handle('system-stats', async () => {
    const [load, mem, temp, gfx] = await Promise.all([
      si.currentLoad(), si.mem(), si.cpuTemperature(), si.graphics().catch(() => ({ controllers: [] }))
    ]);
    const gpu = gfx.controllers.find((c) => c.utilizationGpu != null) || gfx.controllers[0] || {};
    return {
      cpu: Math.round(load.currentLoad),
      cpuTemp: temp.main || null,
      ramUsed: mem.active / 1024 ** 3,
      ramTotal: mem.total / 1024 ** 3,
      gpuName: gpu.model || null,
      gpu: gpu.utilizationGpu ?? null,
      gpuTemp: gpu.temperatureGpu ?? null,
      vramUsed: gpu.memoryUsed != null ? gpu.memoryUsed / 1024 : null,
      vramTotal: gpu.memoryTotal != null ? gpu.memoryTotal / 1024 : null
    };
  });
}

app.whenReady().then(() => {
  games = loadGames(DATA_DIR);
  store = new Store(path.join(app.getPath('userData'), 'data.json'));
  createWindow();
  registerIpc();
  registerShortcuts();
  pollGame();
  setInterval(pollGame, POLL_MS);
  // Procura versão nova ao abrir e a cada 6 horas.
  const checkUpdate = async () => { const u = await checkLatest(UPDATE_REPO, app.getVersion()); if (u) send('update', u); };
  setTimeout(checkUpdate, 15000); setInterval(checkUpdate, 6 * 3600 * 1000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopFps();
  if (store) { store.endSession(); store.save(); }
});
