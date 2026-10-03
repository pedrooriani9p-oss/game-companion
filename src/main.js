const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, desktopCapturer, clipboard, Tray, Menu, nativeImage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const os = require('os');
const { FpsMeter } = require('./fps');
const { checkLatest } = require('./updater');
const { identifyForeground, buildLibrary, slug } = require('./detect');
const { Cs2Live, gsiConfig } = require('./cs2');
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

function createWindow({ hidden = false } = {}) {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...FULL,
    show: !hidden,
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

async function steamLibraries() {
  if (process.platform !== 'win32') return [];
  const steamPath = await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  if (!steamPath) return [];
  let libs = [steamPath];
  try {
    libs = libs.concat(parseLibraryFolders(fs.readFileSync(path.join(steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8')));
  } catch {}
  return [...new Set(libs.map((l) => path.normalize(l)))];
}

async function steamAppName(appId) {
  for (const lib of await steamLibraries()) {
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

// ---------- Qualquer jogo: lojas instaladas e janela em primeiro plano ----------
let library = [];
async function refreshLibrary() {
  if (process.platform !== 'win32') return;
  const steam = [];
  for (const lib of await steamLibraries()) {
    try {
      for (const f of fs.readdirSync(path.join(lib, 'steamapps')).filter((x) => /^appmanifest_\d+\.acf$/.test(x))) {
        const text = fs.readFileSync(path.join(lib, 'steamapps', f), 'utf8');
        const dir = (text.match(/"installdir"\s+"([^"]+)"/) || [])[1];
        steam.push({ name: parseAcfName(text), installdir: dir, lib });
      }
    } catch {}
  }
  const epic = [];
  const epicDir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  try { for (const f of fs.readdirSync(epicDir).filter((x) => x.endsWith('.item'))) epic.push(fs.readFileSync(path.join(epicDir, f), 'utf8')); } catch {}
  const gog = await new Promise((resolve) => execFile('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out)));
  library = buildLibrary({ steam, epic, gog });
}

// Um PowerShell fica aberto e informa a cada 3 s qual programa está em primeiro plano e se está em tela cheia.
let foreground = null;
let fgProc = null;
const FG_SCRIPT = String.raw`
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class GcFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
}
"@
while ($true) {
  try {
    $h = [GcFg]::GetForegroundWindow(); $fpid = 0; [void][GcFg]::GetWindowThreadProcessId($h, [ref]$fpid)
    $r = New-Object GcFg+RECT; [void][GcFg]::GetWindowRect($h, [ref]$r)
    $mi = New-Object GcFg+MONITORINFO; $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
    [void][GcFg]::GetMonitorInfo([GcFg]::MonitorFromWindow($h, 2), [ref]$mi)
    $sb = New-Object Text.StringBuilder 256; [void][GcFg]::GetWindowText($h, $sb, 256)
    $p = Get-Process -Id $fpid -ErrorAction SilentlyContinue
    $exe = $null; $desc = $null
    try { $exe = $p.Path } catch {}
    if ($exe) { try { $desc = (Get-Item -LiteralPath $exe).VersionInfo.FileDescription } catch {} } elseif ($p) { $exe = "$($p.ProcessName).exe" }
    $full = ($r.L -le $mi.rcMonitor.L) -and ($r.T -le $mi.rcMonitor.T) -and ($r.R -ge $mi.rcMonitor.R) -and ($r.B -ge $mi.rcMonitor.B)
    [Console]::Out.WriteLine((@{ exe = $exe; title = $sb.ToString(); fullscreen = $full; description = $desc } | ConvertTo-Json -Compress))
  } catch { [Console]::Out.WriteLine('{}') }
  Start-Sleep -Seconds 3
}`;
function startForegroundWatch() {
  if (process.platform !== 'win32') return;
  const encoded = Buffer.from(FG_SCRIPT, 'utf16le').toString('base64');
  fgProc = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
  let buf = '';
  fgProc.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/); buf = lines.pop();
    for (const l of lines) { try { foreground = JSON.parse(l); } catch {} }
  });
  fgProc.on('exit', () => { fgProc = null; setTimeout(startForegroundWatch, 10000); });
}

let manualGame = false;
async function pollGame() {
  if (manualGame) {
    if (currentGame) store.addPlaytime(currentGame.id, POLL_MS / 1000);
    store.save();
    return;
  }
  const [procs, steamApp] = await Promise.all([listProcesses(), steamRunningApp()]);
  let found = detectGame(procs, games, steamApp, await javaCmdlines(procs));
  // Fora da lista: continua no jogo reconhecido enquanto o programa dele estiver aberto; senão olha a janela da frente.
  if (!found || found.id.startsWith('steam-')) {
    const running = new Set(procs.map((p) => p.toLowerCase()));
    const exe = currentGame && currentGame.auto && currentGame.exe[0];
    if (exe && running.has(exe.toLowerCase())) found = currentGame;
    else {
      const fg = identifyForeground(foreground, library, store.state.ignoredExe);
      // Jogo da Steam fora da lista: mesmo id que a janela daria (x-nome), para não abrir duas sessões.
      found = fg || (found && { ...found, id: `x-${slug(found.name)}`, auto: true });
    }
  }
  if (currentGame) store.addPlaytime(currentGame.id, POLL_MS / 1000);
  // Mesmo jogo, agora com o nome do programa (veio da Steam sem ele): já dá para medir o FPS.
  if (found && currentGame && found.id === currentGame.id && found.exe.length && !currentGame.exe.length) { currentGame = found; syncFps(); }
  if ((found && found.id) !== (currentGame && currentGame.id)) {
    if (currentGame) finishSession();
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
// Jogos fora da lista vão como #x-<nome>~<Nome> e a página cria o jogo na hora.
const webUrl = () => (!currentGame ? WEB_URL : currentGame.auto ? `${WEB_URL}#${currentGame.id}~${encodeURIComponent(currentGame.name)}` : `${WEB_URL}#${currentGame.id}`);
const AUTH_HOSTS = /(^|\.)(claude\.ai|anthropic\.com|accounts\.google\.com|google\.com|appleid\.apple\.com|apple\.com)$/;
function openClaude({ focus = true, show = true } = {}) {
  if (claudeWin && !claudeWin.isDestroyed()) {
    const want = webUrl();
    // Só troca de jogo quando o Pedro abre a janela; o envio escondido de partidas não mexe na página dele.
    if (!show) return claudeWin;
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
  claudeWin.once('ready-to-show', () => { if (!show) return; if (focus) claudeWin.show(); else claudeWin.showInactive(); });
  claudeWin.webContents.on('did-finish-load', () => { deliverPending(); });
  claudeWin.on('closed', () => { claudeWin = null; });
  claudeWin.loadURL(webUrl());
  return claudeWin;
}
const openWeb = () => openClaude();

// Procura, entre os quadros da página do Claude, o do Game Companion (o artifact roda num iframe).
async function findAppFrame(wc, timeoutMs = 25000, fn = 'gcPasteScore') {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const f of wc.mainFrame.framesInSubtree) {
      try { if (await f.executeJavaScript(`typeof window.${fn} === "function"`)) return f; } catch {}
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

// ---------- Resumo da sessão (tempo, FPS) ----------
let sessionFps = [];
let sessionLow = null;
function sampleFps() {
  const r = fps.meter && fps.meter.read();
  if (!r || !currentGame) return;
  sessionFps.push(r.fps); if (sessionFps.length > 20000) sessionFps.shift();
  if (r.low1 != null) sessionLow = sessionLow == null ? r.low1 : Math.min(sessionLow, r.low1);
}
function finishSession({ quiet = false } = {}) {
  const extra = sessionFps.length ? { fpsAvg: Math.round(sessionFps.reduce((a, b) => a + b, 0) / sessionFps.length), fpsLow: sessionLow } : {};
  sessionFps = []; sessionLow = null;
  const s = store.endSession(Date.now(), extra);
  if (!quiet && s && s.end - s.start >= 120000) {
    const name = store.state.names[s.gameId] || (games.find((g) => g.id === s.gameId) || {}).name || s.gameId;
    send('session-summary', { ...s, name });
    if (win && !win.isVisible()) win.showInactive();
  }
}

// ---------- CS2 ao vivo (Game State Integration) ----------
const CS2_PORT = 3971;
const cs2 = new Cs2Live();
let cs2Seen = 0;
let cs2Status = 'off';
function cs2Token() {
  if (!store.state.cs2Token) { store.state.cs2Token = crypto.randomBytes(12).toString('hex'); store.save(); }
  return store.state.cs2Token;
}
// Coloca o arquivo de configuração na pasta do CS2. O jogo só lê ao abrir.
async function installCs2Config() {
  const cfgText = gsiConfig(CS2_PORT, cs2Token());
  for (const lib of await steamLibraries()) {
    const dir = path.join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');
    if (!fs.existsSync(dir)) continue;
    const file = path.join(dir, 'gamestate_integration_gamecompanion.cfg');
    try {
      const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (old !== cfgText) { fs.writeFileSync(file, cfgText); cs2Status = 'installed-restart'; } else if (cs2Status === 'off') cs2Status = 'installed';
    } catch { cs2Status = 'error'; }
    send('cs2-status', cs2Status);
    return;
  }
  cs2Status = 'not-found'; send('cs2-status', cs2Status);
}
function startCs2Server() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/cs2') { res.writeHead(404); return res.end(); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end();
      let p; try { p = JSON.parse(body); } catch { return; }
      if (!p.auth || p.auth.token !== cs2Token()) return;
      cs2Seen = Date.now(); cs2Status = 'live';
      const { state, match } = cs2.update(p);
      send('cs2', state);
      if (match) onCs2Match(match);
    });
  });
  server.on('error', () => { cs2Status = 'port-busy'; send('cs2-status', cs2Status); });
  server.listen(CS2_PORT, '127.0.0.1');
  setInterval(() => { if (cs2Seen && Date.now() - cs2Seen > 30000) { cs2Seen = 0; cs2.update(null); send('cs2', null); } }, 5000);
}
const RES = { V: 'Vitória', D: 'Derrota', E: 'Empate' };
function onCs2Match(m) {
  store.state.cs2Matches = [...(store.state.cs2Matches || []), m].slice(-100);
  store.state.pendingMatches = [...(store.state.pendingMatches || []), { game: 'cs2', ...m }];
  store.save();
  send('cs2-match', m);
  send('toast', `🏁 Partida registrada: ${RES[m.res] || 'sem resultado'}${m.k != null ? `, ${m.k}/${m.a}/${m.d}` : ''}. ${m.note.split(' (')[0]}`);
  deliverPending();
}
// Manda as partidas guardadas para a página do Claude (onde ficam o histórico e as análises).
let delivering = false;
async function deliverPending() {
  if (delivering || !(store.state.pendingMatches || []).length) return;
  delivering = true;
  try {
    const w = openClaude({ show: false });
    const frame = await findAppFrame(w.webContents, 30000, 'gcAddMatch');
    if (!frame) return;
    for (const m of [...store.state.pendingMatches]) {
      const ok = await frame.executeJavaScript(`window.gcAddMatch(${JSON.stringify(m)})`).catch(() => false);
      if (!ok) break;
      store.state.pendingMatches = store.state.pendingMatches.filter((x) => x.at !== m.at);
      store.save();
    }
  } finally { delivering = false; }
}

// ---------- Ícone perto do relógio ----------
let tray = null;
const loginExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const startsWithWindows = () => app.getLoginItemSettings({ path: loginExe(), args: ['--hidden'] }).openAtLogin;
function togglePanel() { if (win.isVisible()) win.hide(); else win.showInactive(); }
function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar ou esconder o painel', click: togglePanel },
    { label: 'Abrir o Claude', click: () => openClaude() },
    { label: 'Print do placar', click: captureScoreboard },
    { type: 'separator' },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: startsWithWindows(),
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, path: loginExe(), args: ['--hidden'] }); buildTrayMenu(); } },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]));
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('Game Companion');
  tray.on('click', togglePanel);
  buildTrayMenu();
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
  ipcMain.handle('get-state', () => ({ games, currentGame, state: store.state, mode: { clickThrough, compact }, cs2: cs2.state, cs2Status }));
  ipcMain.handle('rate-session', (_e, start, rating, note) => { store.rateSession(start, rating, note); store.save(); });
  ipcMain.handle('quit', () => app.quit());
  // "Não é um jogo": esse programa não é mais reconhecido sozinho.
  ipcMain.handle('ignore-game', () => {
    if (!currentGame || !currentGame.auto || !currentGame.exe[0]) return;
    store.state.ignoredExe = [...new Set([...(store.state.ignoredExe || []), currentGame.exe[0].toLowerCase()])];
    finishSession({ quiet: true });
    currentGame = null; send('game-changed', null); syncFps(); store.save();
  });
  ipcMain.handle('save-note', (_e, gameId, text) => { store.state.notes[gameId] = text; store.save(); });
  ipcMain.handle('save-reminders', (_e, reminders) => { store.state.reminders = reminders; store.save(); });
  ipcMain.handle('set-game', (_e, gameId) => {
    // Seleção manual (vazio volta para detecção automática).
    if (currentGame) finishSession();
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

// Só um Game Companion aberto: abrir de novo mostra o painel que já está rodando.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
app.on('second-instance', () => { if (win) { win.showInactive(); } });

app.whenReady().then(() => {
  if (!primary) return;
  games = loadGames(DATA_DIR);
  store = new Store(path.join(app.getPath('userData'), 'data.json'));
  createWindow({ hidden: process.argv.includes('--hidden') });
  registerIpc();
  registerShortcuts();
  createTray();
  startForegroundWatch();
  refreshLibrary(); setInterval(refreshLibrary, 10 * 60 * 1000);
  startCs2Server(); installCs2Config();
  // Partidas que ficaram sem enviar da última vez.
  setTimeout(deliverPending, 20000);
  setInterval(sampleFps, 2000);
  pollGame();
  setInterval(pollGame, POLL_MS);
  // Procura versão nova ao abrir e a cada 6 horas.
  const checkUpdate = async () => { const u = await checkLatest(UPDATE_REPO, app.getVersion()); if (u) send('update', u); };
  setTimeout(checkUpdate, 15000); setInterval(checkUpdate, 6 * 3600 * 1000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopFps();
  if (fgProc) { try { fgProc.kill(); } catch {} }
  if (store) { finishSession({ quiet: true }); store.save(); }
});
