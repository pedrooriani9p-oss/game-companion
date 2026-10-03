// Reconhecimento de jogos fora da lista. Lógica pura, testável com Node.
const path = require('path');

// Programas que nunca são jogos, mesmo em tela cheia.
const NOT_GAMES = new Set([
  'explorer.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'opera_gx.exe', 'brave.exe', 'vivaldi.exe',
  'discord.exe', 'spotify.exe', 'vlc.exe', 'mpc-hc64.exe', 'potplayermini64.exe', 'obs64.exe', 'obs32.exe', 'streamlabs obs.exe',
  'steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe', 'battle.net.exe', 'eadesktop.exe', 'origin.exe', 'upc.exe',
  'ubisoftconnect.exe', 'galaxyclient.exe', 'riotclientservices.exe', 'riotclientux.exe', 'xboxpcapp.exe', 'gamebar.exe',
  'code.exe', 'notepad.exe', 'notepad++.exe', 'winword.exe', 'excel.exe', 'powerpnt.exe', 'teams.exe', 'ms-teams.exe',
  'whatsapp.exe', 'telegram.exe', 'zoom.exe', 'claude.exe', 'game companion.exe', 'electron.exe', 'applicationframehost.exe',
  'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'lockapp.exe', 'taskmgr.exe', 'mmc.exe',
  'cmd.exe', 'powershell.exe', 'windowsterminal.exe', 'conhost.exe', 'nvidia app.exe', 'nvidia share.exe', 'radeonsoftware.exe',
  'msiafterburner.exe', 'rtss.exe', 'wallpaper64.exe', 'wallpaper32.exe', 'mspaint.exe', 'photos.exe', 'acrobat.exe', 'acrord32.exe',
  'microsoft.photos.exe', 'mpv.exe', 'kodi.exe', 'stremio.exe', 'netflix.exe', 'msteams.exe', 'obs.exe', 'medal.exe', 'overwolf.exe',
  'wemod.exe', 'playnite.desktopapp.exe', 'playnite.fullscreenapp.exe', 'lghub.exe', 'icue.exe', 'armourycrate.exe', 'gameoverlayui.exe',
  'textinputhost.exe', 'screenclippinghost.exe', 'snippingtool.exe', 'sharex.exe', 'anydesk.exe', 'teamviewer.exe', 'parsecd.exe',
  'msedgewebview2.exe', 'arc.exe', 'zen.exe', 'whatsapp.root.exe', 'gamecompanion.exe',
]);

// Pastas onde as lojas instalam jogos. O nome do jogo é a pasta logo depois.
const GAME_DIRS = [
  /\\steamapps\\common\\([^\\]+)/i, /\\Epic Games\\([^\\]+)/i, /\\XboxGames\\([^\\]+)/i, /\\Riot Games\\([^\\]+)/i,
  /\\EA Games\\([^\\]+)/i, /\\Ubisoft Game Launcher\\games\\([^\\]+)/i, /\\GOG Galaxy\\Games\\([^\\]+)/i, /\\GOG Games\\([^\\]+)/i,
  /\\Rockstar Games\\([^\\]+)/i, /\\Amazon Games\\Library\\([^\\]+)/i, /\\itch\\apps\\([^\\]+)/i,
];
const LAUNCHER_FOLDERS = /^(launcher|riot client|epic games launcher|directx|steamworks shared|steamvr|common redist)$/i;

const slug = (name) => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'jogo';

// Nome mais legível a partir do nome do arquivo ou da pasta (ex.: "Palworld-Win64-Shipping" -> "Palworld").
function prettyName(raw) {
  return String(raw).replace(/\.exe$/i, '').replace(/[-_](win64|win32|shipping|x64|dx11|dx12|vulkan|game|client|retail)\b/gi, '')
    .replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Jogos instalados pelas lojas: [{ name, dir }] com a pasta de instalação.
// steam: [{ name, installdir, lib }], epic: textos dos arquivos .item, gog: saída de `reg query ... /s`.
function buildLibrary({ steam = [], epic = [], gog = '' } = {}) {
  const lib = [];
  for (const s of steam) if (s.name && s.installdir && s.lib) lib.push({ name: s.name, dir: path.win32.join(s.lib, 'steamapps', 'common', s.installdir) });
  for (const text of epic) {
    try { const j = JSON.parse(text); if (j.DisplayName && j.InstallLocation) lib.push({ name: j.DisplayName, dir: j.InstallLocation }); } catch {}
  }
  let cur = {};
  for (const line of String(gog).split(/\r?\n/)) {
    if (/^HKEY_/i.test(line.trim())) { if (cur.name && cur.dir) lib.push(cur); cur = {}; continue; }
    const m = line.match(/^\s+(gameName|path)\s+REG_\w+\s+(.+)$/i);
    if (m) cur[m[1].toLowerCase() === 'gamename' ? 'name' : 'dir'] = m[2].trim();
  }
  if (cur.name && cur.dir) lib.push(cur);
  return lib;
}

// fg: janela em primeiro plano { exe (caminho completo ou nome), title, fullscreen, description }.
// ignored: programas que o Pedro marcou como "não é um jogo".
// Retorna { id, name, exe } para um jogo fora da lista, ou null.
function identifyForeground(fg, library = [], ignored = []) {
  if (!fg || !fg.exe) return null;
  const exeName = path.win32.basename(fg.exe);
  const lower = exeName.toLowerCase();
  if (NOT_GAMES.has(lower) || (ignored || []).includes(lower)) return null;
  const full = String(fg.exe);
  const make = (name) => ({ id: `x-${slug(name)}`, name, exe: [exeName], tips: [], guides: [], auto: true });
  const inLib = library.find((g) => g.dir && full.toLowerCase().startsWith(String(g.dir).toLowerCase().replace(/\\?$/, '\\')));
  if (inLib) return make(inLib.name);
  for (const re of GAME_DIRS) {
    const m = full.match(re);
    if (m && !LAUNCHER_FOLDERS.test(m[1])) return make(prettyName(m[1]));
  }
  if (fg.fullscreen) {
    const desc = fg.description && !/^(application|launcher|game|unreal engine|unity)$/i.test(fg.description.trim()) ? fg.description.trim() : '';
    const title = fg.title && fg.title.length <= 60 ? fg.title.trim() : '';
    return make(desc || title || prettyName(exeName));
  }
  return null;
}

module.exports = { identifyForeground, buildLibrary, prettyName, slug, NOT_GAMES };
