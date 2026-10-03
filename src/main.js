const { app, BrowserWindow, globalShortcut, ipcMain, shell, screen, desktopCapturer, clipboard, Tray, Menu, nativeImage, net } = require('electron');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const os = require('os');
const { FpsMeter } = require('./fps');
const { checkLatest } = require('./updater');
const { identifyForeground, buildLibrary, slug } = require('./detect');
const { Cs2Live, gsiConfig } = require('./cs2');
const https = require('https');
const { Tail } = require('./tail');
const valorant = require('./live/valorant');
const { MinecraftLog, gameDirFromCmdline } = require('./live/minecraft');
const { Tf2Console, personaFromLoginUsers } = require('./live/tf2');
const stardew = require('./live/stardew');
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
const ZOOM = { normal: 1, grande: 1.15 };
const zoom = () => ZOOM[(store && store.state.settings && store.state.settings.size) || 'normal'] || 1;
const scaled = (sz) => ({ width: Math.round(sz.width * zoom()), height: Math.round(sz.height * zoom()) });
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
  const full = scaled(FULL);
  win = new BrowserWindow({
    ...full,
    show: !hidden,
    x: workArea.x + workArea.width - full.width - 20,
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
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(zoom()));
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
        const appId = Number((text.match(/"appid"\s+"(\d+)"/) || [])[1]) || null;
        steam.push({ name: parseAcfName(text), installdir: dir, lib, appId });
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
      found = fg || (found && { ...found, id: `x-${slug(found.name)}`, auto: true, appId: Number(found.id.slice(6)) || undefined });
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
    syncFps(); syncLive();
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
  const size = scaled(on ? COMPACT : FULL);
  // Algumas plataformas ignoram setSize em janela não redimensionável.
  win.setResizable(true);
  // Mantém o painel dentro da tela quando ele cresce (tamanho Grande).
  const b = { ...win.getBounds(), ...size }, wa = screen.getDisplayMatching(win.getBounds()).workArea;
  b.x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - b.width));
  b.y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - b.height));
  win.setBounds(b);
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
    if (!src || src.thumbnail.isEmpty()) { notify('Não consegui tirar o print da tela.'); return; }
    // Deixa o print também na área de transferência (API nova do Electron, com a antiga de reserva).
    try {
      const { ClipboardItem } = require('electron');
      if (ClipboardItem) await clipboard.write([new ClipboardItem({ 'image/png': new Blob([src.thumbnail.toPNG()], { type: 'image/png' }) })]);
      else clipboard.writeImage(src.thumbnail);
    } catch {}
    notify('📷 Print tirado. Lendo o placar na janela do Claude...');
    const w = openClaude({ focus: false });
    const frame = await findAppFrame(w.webContents);
    if (!frame) { notify('Print copiado. Abra a janela do Claude (Ctrl+Shift+W), faça login se pedir, e cole com Ctrl+V em Partidas.'); return; }
    const dataUrl = 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(92).toString('base64');
    await frame.executeJavaScript(`window.gcPasteScore(${JSON.stringify(dataUrl)})`);
    notify('Placar enviado. Confira os números na janela do Claude (Ctrl+Shift+W) e aperte Registrar partida.');
  } catch {
    notify('Não consegui enviar o print. Ele ficou copiado: cole com Ctrl+V em Partidas.');
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
  // O modo ao vivo do jogo fecha a sessão: destaques no resumo e, nos jogos de progresso, uma anotação no Diário.
  const last = store.state.sessions[store.state.sessions.length - 1];
  const fin = liveMod && liveMod.finish ? liveMod.finish(last && last.end === null ? Date.now() - last.start : 0) : null;
  if (fin && fin.highlights && fin.highlights.length) extra.highlights = fin.highlights;
  if (fin && fin.diary && currentGame) registerMatch(currentGame.id, { at: Date.now(), prog: true, note: fin.diary }, { toast: false });
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
  send('cs2-match', m);
  registerMatch('cs2', m);
}
// Guarda uma partida (ou anotação do Diário, com prog) para mandar à página do Claude.
function registerMatch(game, m, { toast = true } = {}) {
  store.state.pendingMatches = [...(store.state.pendingMatches || []), { game, ...m }];
  store.save();
  const nums = m.k == null ? '' : m.a == null ? `, ${m.k} abates e ${m.d} mortes` : `, ${m.k}/${m.a}/${m.d}`;
  if (toast) notify(`🏁 Partida registrada: ${RES[m.res] || 'sem resultado'}${nums}. ${m.note.split(' (')[0]}`);
  deliverPending();
}
// Manda as partidas guardadas para a página do Claude (onde ficam o histórico e as análises).
let delivering = false;
let quitting = false;
app.on('before-quit', () => { quitting = true; });
async function deliverPending() {
  if (quitting || delivering || !(store.state.pendingMatches || []).length) return;
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


// ---------- Modo ao vivo de outros jogos (Valorant, Minecraft, TF2, Stardew) ----------
const appData = () => process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const subdirs = (base) => { try { return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(base, d.name)); } catch { return []; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const newest = (files) => files.map((f) => [f, mtime(f)]).filter((x) => x[1]).sort((a, b) => b[1] - a[1]).map((x) => x[0])[0] || null;
const money = (n) => Number(n || 0).toLocaleString('pt-BR');
const minutes = (ms) => fmtMinutes(ms / 1000);
// Anotação do Diário: frase terminada com pontuação e a marca de que veio do app.
const diaryNote = (text) => `${text}${/[.!?]$/.test(text) ? '' : '.'} (registrado pelo app do PC)`;
function fmtMinutes(sec) { return sec >= 3600 ? `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min` : `${Math.max(1, Math.floor(sec / 60))} min`; }
// Últimos (ou primeiros) bytes de um arquivo, sem ler tudo: registros de jogos com mods ficam enormes.
function readTail(f, bytes = 65536, fromStart = false) {
  try { const st = fs.statSync(f), len = Math.min(st.size, bytes), b = Buffer.alloc(len), fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, len, fromStart ? 0 : st.size - len); fs.closeSync(fd); return b.toString('utf8'); } catch { return ''; }
}

function getJson(url, { headers = {}, insecure = false, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, rejectUnauthorized: !insecure, timeout }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

let liveMod = null;   // { id, stop(), card(), finish(ms) }
let liveCard = null;
function sendLive() { liveCard = liveMod ? liveMod.card() : null; send('live', liveCard); }
function syncLive() {
  const id = currentGame && currentGame.id;
  if (liveMod && liveMod.id === id) return;
  if (liveMod) { liveMod.stop(); liveMod = null; }
  const make = { valorant: valorantLive, minecraft: minecraftLive, cobblemon: minecraftLive, tf2: tf2Live, stardew: stardewLive }[id];
  if (make) { try { liveMod = make(id); } catch { liveMod = null; } }
  sendLive();
}

// --- Valorant: presença do próprio jogador no Riot Client e, no fim, os detalhes da partida ---
const VAL_PLATFORM = Buffer.from(JSON.stringify({ platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown' })).toString('base64');
let valNamesCache = null;
async function valNames() {
  if (valNamesCache && (valNamesCache.ok || Date.now() - valNamesCache.at < 10 * 60000)) return valNamesCache;
  const out = { maps: {}, agents: {}, ok: false, at: Date.now() };
  try {
    const [maps, agents] = await Promise.all([getJson('https://valorant-api.com/v1/maps'), getJson('https://valorant-api.com/v1/agents?isPlayableCharacter=true')]);
    for (const m of maps.data || []) if (m.mapUrl) out.maps[m.mapUrl] = m.displayName;
    for (const a of agents.data || []) out.agents[String(a.uuid).toLowerCase()] = a.displayName;
    out.ok = true;
  } catch {}
  valNamesCache = out;
  return out;
}
function valorantLive(id) {
  const vl = new valorant.ValorantLive();
  const lockPath = path.join(localAppData(), 'Riot Games', 'Riot Client', 'Config', 'lockfile');
  const sess = { matches: 0, wins: 0, k: 0, d: 0, withKd: 0 };
  const reported = new Set(store.state.valReported || []);
  let lock = null, puuid = null, state = null, agent = null, agentFor = null, agentTry = 0, msg = 'Procurando o cliente da Riot...', tip = 0, stopped = false, remote = null;
  const local = (p) => getJson(`https://127.0.0.1:${lock.port}${p}`, { insecure: true, headers: { Authorization: 'Basic ' + Buffer.from(`riot:${lock.password}`).toString('base64') } });
  async function auth() {
    const ent = await local('/entitlements/v1/token');
    if (!remote) {
      remote = valorant.parseShooterLog(readText(path.join(localAppData(), 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log')));
      if (!remote.version) { try { remote.version = (await getJson('https://valorant-api.com/v1/version')).data.riotClientVersion; } catch {} }
    }
    if (!remote.region) throw new Error('sem região');
    return { headers: { Authorization: `Bearer ${ent.accessToken}`, 'X-Riot-Entitlements-JWT': ent.token, 'X-Riot-ClientPlatform': VAL_PLATFORM, 'X-Riot-ClientVersion': remote.version || '' }, puuid: ent.subject };
  }
  // Só o agente do próprio Pedro (nada dos outros jogadores).
  async function fetchAgent() {
    try {
      const a = await auth(), glz = `https://glz-${remote.region}-1.${remote.shard}.a.pvp.net`;
      const cur = await getJson(`${glz}/core-game/v1/players/${a.puuid}`, { headers: a.headers });
      if (agentFor === cur.MatchID) return;
      const match = await getJson(`${glz}/core-game/v1/matches/${cur.MatchID}`, { headers: a.headers });
      const me = (match.Players || []).find((x) => x.Subject === a.puuid);
      const names = await valNames();
      agent = me ? names.agents[String(me.CharacterID).toLowerCase()] || null : null; agentFor = cur.MatchID;
      sendLive();
    } catch {}
  }
  async function fetchMatch(ended, endedAt, tries = 0) {
    try {
      const a = await auth(), pd = `https://pd.${remote.shard}.a.pvp.net`;
      const hist = await getJson(`${pd}/match-history/v1/history/${a.puuid}?startIndex=0&endIndex=3`, { headers: a.headers });
      const names = await valNames();
      for (const h of hist.History || []) {
        if (reported.has(h.MatchID) || h.GameStartTime < endedAt - 2 * 3600000) continue;
        const d = await getJson(`${pd}/match-details/v1/matches/${h.MatchID}`, { headers: a.headers });
        if (d.matchInfo && ended.mapUrl && d.matchInfo.mapId !== ended.mapUrl) continue;
        const m = valorant.summarizeMatch(d, a.puuid, names);
        if (!m) continue;
        reported.add(h.MatchID); store.state.valReported = [...reported].slice(-50);
        return done(m);
      }
      throw new Error('ainda não apareceu');
    } catch {
      if (tries < 3) setTimeout(() => fetchMatch(ended, endedAt, tries + 1), 20000);
      else done(valorant.matchFromPresence(ended, endedAt));
    }
  }
  function done(m) {
    sess.matches++; if (m.res === 'V') sess.wins++;
    if (m.k != null) { sess.withKd++; sess.k += m.k; sess.d += m.d || 0; }
    registerMatch('valorant', m);
    if (!stopped) sendLive();
  }
  async function tick() {
    const l = valorant.parseLockfile(readText(lockPath));
    if (!l) { lock = null; state = null; msg = 'Abra o Valorant pelo Riot Client para ligar o modo ao vivo.'; return sendLive(); }
    lock = l;
    try {
      if (!puuid) puuid = (await local('/chat/v1/session')).puuid;
      const pres = ((await local('/chat/v4/presences')).presences || []).find((p) => p.puuid === puuid && p.product === 'valorant');
      const names = await valNames();
      const { state: s, ended } = vl.update(pres ? valorant.decodePresence(pres.private) : null, names.maps);
      if (s && state && s.map !== state.map) tip = 0;
      state = s; msg = s ? '' : 'Entre no Valorant para ver o mapa e o placar aqui.';
      if (s && s.loop === 'INGAME' && !agent && Date.now() - agentTry > 60000) { agentTry = Date.now(); fetchAgent(); }
      if (s && s.loop !== 'INGAME') { agent = null; agentFor = null; agentTry = 0; }
      if (ended) { const at = Date.now(); setTimeout(() => fetchMatch(ended, at), 15000); }
    } catch { state = null; msg = 'Não consegui falar com o cliente da Riot. Ele está aberto?'; }
    sendLive();
  }
  tick();
  const timer = setInterval(tick, 4000);
  const tipTimer = setInterval(() => { tip++; }, 90000);
  return {
    id,
    stop() { stopped = true; clearInterval(timer); clearInterval(tipTimer); },
    card() {
      const s = state, ingame = s && s.loop === 'INGAME';
      const stats = [];
      if (ingame) stats.push(['Placar', `${s.ally} x ${s.enemy}`], ['Agente', agent || '–']);
      stats.push(['Partidas na sessão', String(sess.matches)]);
      if (sess.matches) stats.push(['Vitórias', String(sess.wins)]);
      if (sess.withKd) stats.push(['K/D', `${sess.k}/${sess.d}`]);
      return {
        game: id, title: 'Valorant ao vivo', sub: s ? [s.stateLabel, s.map, s.loop !== 'MENUS' ? s.queueLabel : ''].filter(Boolean).join(' · ') : '',
        stats, tip: s && s.tips.length ? s.tips[tip % s.tips.length] : '', msg,
        compact: ingame ? `${s.map} ${s.ally}-${s.enemy}${agent ? ` · ${agent}` : ''}` : '',
      };
    },
    finish() {
      // Fechou o jogo direto da tela final: busca a partida mesmo assim.
      if (vl.lastIngame) { const e = vl.lastIngame; vl.lastIngame = null; fetchMatch(e, Date.now(), 1); }
      const h = sess.matches ? [`${sess.matches} ${sess.matches === 1 ? 'partida' : 'partidas'}, ${sess.wins} ${sess.wins === 1 ? 'vitória' : 'vitórias'}`] : [];
      if (sess.withKd) h.push(`K/D ${sess.k}/${sess.d}`);
      return { highlights: h };
    },
  };
}

// --- Minecraft e Cobblemon: registro do jogo (logs/latest.log) ---
function minecraftLogCandidates() {
  const ad = appData(), home = process.env.USERPROFILE || os.homedir();
  const out = [path.join(ad, '.minecraft', 'logs', 'latest.log')];
  for (const base of [path.join(home, 'curseforge', 'minecraft', 'Instances'), path.join(ad, 'ModrinthApp', 'profiles'), path.join(ad, 'com.modrinth.theseus', 'profiles'), path.join(ad, 'ATLauncher', 'instances'), path.join(ad, '.technic', 'modpacks')]) {
    for (const d of subdirs(base)) out.push(path.join(d, 'logs', 'latest.log'));
  }
  for (const d of subdirs(path.join(ad, 'PrismLauncher', 'instances'))) out.push(path.join(d, '.minecraft', 'logs', 'latest.log'), path.join(d, 'minecraft', 'logs', 'latest.log'));
  return out;
}
function minecraftLive(id) {
  const log = new MinecraftLog();
  let tail = null, file = null, msg = 'Procurando o registro do Minecraft...';
  function onLines(lines) {
    for (const l of lines) {
      const e = log.line(l);
      if (!e) continue;
      if (e.type === 'death') notify(`💀 Você morreu: ${e.cause} (${e.count}ª morte da sessão)`);
      if (e.type === 'advancement') notify(`🏆 Conquista: ${e.name}`);
      if (e.type === 'catch') notify(`🎉 Capturou ${e.name}! (${e.count} na sessão)`);
    }
    sendLive();
  }
  async function pick() {
    const dirs = (await javaCmdlines(await listProcesses())).map(gameDirFromCmdline).filter(Boolean);
    const fromCmd = dirs.map((d) => path.join(d, 'logs', 'latest.log')).find((f) => mtime(f));
    const f = fromCmd || newest(minecraftLogCandidates());
    if (!f) { msg = 'Não achei o registro do Minecraft (pasta logs). O modo ao vivo liga quando o jogo criar o arquivo.'; return sendLive(); }
    if (f === file) return;
    if (tail) tail.stop();
    file = f; msg = '';
    for (const l of `${readTail(f, 1 << 20, true)}\n${readTail(f, 1 << 20)}`.split('\n')) log.line(l, { replay: true });
    tail = new Tail(f, onLines).start();
    sendLive();
  }
  pick();
  const timer = setInterval(pick, 30000);
  return {
    id,
    stop() { clearInterval(timer); if (tail) tail.stop(); },
    card() {
      const lastDeath = log.deaths[log.deaths.length - 1], lastAdv = log.advancements[log.advancements.length - 1];
      const stats = [['Mortes', String(log.deaths.length)], ['Conquistas', String(log.advancements.length)]];
      if (id === 'cobblemon' || log.catches.length) stats.push(['Capturas', String(log.catches.length)]);
      const lines = [];
      if (lastDeath) lines.push(`Última morte (${new Date(lastDeath.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}): ${lastDeath.cause}`);
      if (lastAdv) lines.push(`Última conquista: ${lastAdv.name}`);
      if (log.catches.length) lines.push(`Capturados: ${log.catches.slice(-5).map((x) => x.name).join(', ')}`);
      return { game: id, title: `${id === 'cobblemon' ? 'Cobblemon' : 'Minecraft'} ao vivo`, sub: log.world ? `mundo ${log.world}` : '', stats, lines, msg,
        compact: `💀 ${log.deaths.length}${log.catches.length ? ` · 🎉 ${log.catches.length}` : ''}` };
    },
    finish(ms) {
      const h = log.highlights();
      return { highlights: h, diary: h.length ? diaryNote(`Sessão de ${minutes(ms)}${log.world ? ` no mundo ${log.world}` : ''}: ${h.join('; ')}`) : null };
    },
  };
}

// --- TF2: console salvo com -condebug ---
function tf2Live(id) {
  let con = null, tail = null, msg = 'Procurando o console do TF2...', seen = false;
  const sess = { k: 0, d: 0, best: 0 };
  const help = 'Para ligar: na Steam, clique com o botão direito no TF2, Propriedades, Opções de inicialização, escreva -condebug e abra o TF2 de novo.';
  (async () => {
    const libs = await steamLibraries();
    const me = personaFromLoginUsers(readText(path.join(libs[0] || '', 'config', 'loginusers.vdf')));
    con = new Tf2Console(me);
    const file = libs.map((l) => path.join(l, 'steamapps', 'common', 'Team Fortress 2', 'tf', 'console.log')).find((f) => mtime(f));
    if (!file) { msg = help; return sendLive(); }
    const maps = [...readTail(file).matchAll(/^Map: (\S+)\r?$/gm)];
    if (maps.length) con.reset(maps[maps.length - 1][1]);
    msg = me ? `Esperando o console do TF2. Se nada mudar durante a partida, falta o -condebug. ${help}` : 'Não achei seu nome da Steam para contar os abates.';
    tail = new Tail(file, (lines) => {
      for (const l of lines) {
        const e = con.line(l);
        if (!seen) { seen = true; msg = ''; }
        if (!e) continue;
        if (e.type === 'kill') { sess.k++; sess.best = Math.max(sess.best, e.streak); if (e.streak % 5 === 0) notify(`🔥 Sequência de ${e.streak} abates!`); }
        if (e.type === 'death') sess.d++;
        if (e.type === 'map' && e.previous) registerMatch('tf2', e.previous);
      }
      sendLive();
    }).start();
    sendLive();
  })();
  return {
    id,
    stop() { if (tail) tail.stop(); },
    card() {
      const c = con || {};
      const stats = con ? [['Abates', String(c.kills)], ['Mortes', String(c.deaths)], ['K/D', (c.kills / Math.max(1, c.deaths)).toFixed(2).replace('.', ',')], ['Sequência', `${c.streak} (melhor ${c.best})`]] : [];
      const lines = [];
      const w = con && con.top(con.weapons), nem = con && con.top(con.killers);
      if (w) lines.push(`Mais abates com: ${w.name} (${w.n})`);
      if (nem && nem.n >= 2) lines.push(`Quem mais te matou: ${nem.name} (${nem.n})`);
      return { game: id, title: 'TF2 ao vivo', sub: c.map || '', stats, lines, msg, compact: con && c.map ? `${c.map} · ${c.kills}/${c.deaths}` : '' };
    },
    finish() {
      const s = con && con.summary();
      if (s) registerMatch('tf2', s);
      return { highlights: sess.k + sess.d ? [`${sess.k} abates, ${sess.d} mortes`, `melhor sequência ${sess.best}`] : [] };
    },
  };
}

// --- Stardew: o save do dia (SaveGameInfo) ---
function stardewLive(id) {
  const savesDir = path.join(appData(), 'StardewValley', 'Saves');
  let file = null, seenAt = 0, first = null, cur = null, days = 0, ups = [], msg = '';
  function check() {
    const f = newest(subdirs(savesDir).map((d) => path.join(d, 'SaveGameInfo')));
    if (!f) { msg = 'Não achei os saves do Stardew. Eles aparecem depois do primeiro dia dormido.'; return sendLive(); }
    const m = mtime(f);
    if (f === file && m === seenAt) return;
    const info = stardew.parseSaveInfo(readText(f));
    if (!info) return;
    const changed = f === file;
    file = f; seenAt = m; msg = '';
    if (!first || !changed) { first = info; cur = info; return sendLive(); }
    const diff = stardew.diffSaves(cur, info);
    cur = info;
    if (diff && diff.newDay) {
      days++; ups.push(...diff.ups);
      notify(`🌙 Dia salvo: ${diff.money >= 0 ? '+' : ''}${money(diff.money)} g.${diff.ups.length ? ` Subiu: ${diff.ups.join(', ')}.` : ''} Agora: ${stardew.dateLabel(info)}.`);
    }
    sendLive();
  }
  check();
  const timer = setInterval(check, 5000);
  return {
    id,
    stop() { clearInterval(timer); },
    card() {
      if (!cur) return { game: id, title: 'Stardew ao vivo', sub: '', stats: [], msg };
      const gained = (cur.money ?? 0) - (first.money ?? 0);
      return {
        game: id, title: 'Stardew ao vivo', sub: [cur.farm && `Fazenda ${cur.farm}`, stardew.dateLabel(cur)].filter(Boolean).join(' · '),
        stats: [['Dinheiro', `${money(cur.money)} g`], ['Na sessão', `${gained >= 0 ? '+' : ''}${money(gained)} g`], ['Dias', String(days)]],
        lines: [stardew.SKILLS.map(([k, label]) => `${label} ${cur.levels[k]}`).join(' · ')],
        tip: cur.season != null ? stardew.SEASON_TIPS[cur.season][days % 2] : '', msg,
        compact: `${money(cur.money)} g`,
      };
    },
    finish(ms) {
      if (!days || !cur) return { highlights: [] };
      const gained = (cur.money ?? 0) - (first.money ?? 0);
      const h = [`${days} ${days === 1 ? 'dia' : 'dias'} (${stardew.dateLabel(first)} até ${stardew.dateLabel(cur)})`, `${gained >= 0 ? '+' : ''}${money(gained)} g`];
      if (ups.length) h.push(`subiu ${ups.join(', ')}`);
      return { highlights: h, diary: diaryNote(`Sessão de ${minutes(ms)}: ${h.join('; ')}`) };
    },
  };
}

// ---------- Avisos no canto da tela ----------
let toastWin = null;
function toastWindow() {
  if (toastWin && !toastWin.isDestroyed()) return toastWin;
  const { workArea } = screen.getPrimaryDisplay();
  const W = 380, H = 260;
  toastWin = new BrowserWindow({
    width: W, height: H, x: workArea.x + workArea.width - W - 12, y: workArea.y + workArea.height - H - 12,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  toastWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toastWin.setIgnoreMouseEvents(true);
  toastWin.loadFile(path.join(__dirname, 'renderer', 'toast.html'));
  return toastWin;
}
function notify(text) {
  const panelOpen = win && !win.isDestroyed() && win.isVisible() && !compact;
  if (panelOpen || (store.state.settings && store.state.settings.cornerToasts === false)) return send('toast', text);
  const t = toastWindow();
  const show = () => {
    t.webContents.send('toast', text);
    t.showInactive();
    clearTimeout(t.hideTimer); t.hideTimer = setTimeout(() => { if (!t.isDestroyed()) t.hide(); }, 7000);
  };
  if (t.webContents.isLoading()) t.webContents.once('did-finish-load', show); else show();
}

// ---------- Capa do jogo (arte da Steam) ----------
const coverCache = {};
function steamAppIdFor(g) {
  if (!g) return null;
  if (g.steamAppId || g.appId) return g.steamAppId || g.appId;
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = library.find((l) => l.appId && norm(l.name) === norm(g.name));
  return hit ? hit.appId : null;
}
// Procura a arte que a Steam já guardou no PC; se não tiver, baixa da loja e guarda.
async function coverFor(g) {
  const appId = steamAppIdFor(g);
  if (!appId) return null;
  if (appId in coverCache) return coverCache[appId];
  let buf = null;
  const libs = await steamLibraries();
  const cache = libs[0] ? path.join(libs[0], 'appcache', 'librarycache') : null;
  if (cache) {
    const names = ['library_hero.jpg', 'header.jpg'];
    const direct = names.flatMap((n) => [path.join(cache, `${appId}_${n}`), path.join(cache, String(appId), n)]);
    const nested = subdirs(path.join(cache, String(appId))).flatMap((d) => names.map((n) => path.join(d, n)));
    const file = [...direct, ...nested].find((f) => mtime(f));
    if (file) buf = fs.readFileSync(file);
  }
  const saved = path.join(app.getPath('userData'), 'covers', `${appId}.jpg`);
  if (!buf && mtime(saved)) buf = fs.readFileSync(saved);
  if (!buf) {
    for (const n of ['library_hero.jpg', 'header.jpg']) {
      try {
        const r = await net.fetch(`https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/${n}`);
        if (!r.ok) continue;
        buf = Buffer.from(await r.arrayBuffer());
        fs.mkdirSync(path.dirname(saved), { recursive: true }); fs.writeFileSync(saved, buf);
        break;
      } catch {}
    }
  }
  if (!buf) return (coverCache[appId] = null);
  // Reduz para não pesar no painel.
  const img = nativeImage.createFromBuffer(buf);
  const small = img.isEmpty() ? null : img.getSize().width > 760 ? img.resize({ width: 760, quality: 'good' }) : img;
  return (coverCache[appId] = small ? `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}` : null);
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
  ipcMain.handle('get-state', () => ({ games, currentGame, state: store.state, mode: { clickThrough, compact }, cs2: cs2.state, cs2Status, live: liveCard, settings: store.state.settings, version: app.getVersion() }));
  ipcMain.handle('cover', (_e, g) => coverFor(g).catch(() => null));
  ipcMain.handle('set-setting', (_e, key, value) => {
    if (!['opacity', 'size', 'cornerToasts', 'sound'].includes(key)) return;
    store.state.settings = { ...store.state.settings, [key]: value };
    store.save();
    if (key === 'size') { win.webContents.setZoomFactor(zoom()); setCompact(compact); }
  });
  // Encaixa o painel num canto da tela onde ele está.
  ipcMain.handle('snap', (_e, corner) => {
    const b = win.getBounds(), wa = screen.getDisplayMatching(b).workArea, m = 20;
    const x = corner.endsWith('l') ? wa.x + m : wa.x + wa.width - b.width - m;
    const y = corner.startsWith('t') ? wa.y + m : wa.y + wa.height - b.height - m;
    win.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.handle('get-autostart', () => startsWithWindows());
  ipcMain.handle('set-autostart', (_e, on) => { app.setLoginItemSettings({ openAtLogin: Boolean(on), path: loginExe(), args: ['--hidden'] }); buildTrayMenu(); return startsWithWindows(); });
  ipcMain.handle('check-update', async () => { const u = await checkLatest(UPDATE_REPO, app.getVersion()); if (u) send('update', u); return u; });
  ipcMain.handle('rate-session', (_e, start, rating, note) => { store.rateSession(start, rating, note); store.save(); });
  ipcMain.handle('quit', () => app.quit());
  // "Não é um jogo": esse programa não é mais reconhecido sozinho.
  ipcMain.handle('ignore-game', () => {
    if (!currentGame || !currentGame.auto || !currentGame.exe[0]) return;
    store.state.ignoredExe = [...new Set([...(store.state.ignoredExe || []), currentGame.exe[0].toLowerCase()])];
    finishSession({ quiet: true });
    currentGame = null; send('game-changed', null); syncFps(); syncLive(); store.save();
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
    syncFps(); syncLive();
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
  if (liveMod) liveMod.stop();
});
