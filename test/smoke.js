// Testes rápidos da lógica pura: node test/smoke.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const core = require('../src/core');

const games = core.loadGames(path.join(__dirname, '..', 'data'));
assert(games.length >= 10, 'lista de jogos carregada');
for (const g of games) {
  assert(g.id && g.name && Array.isArray(g.exe) && Array.isArray(g.tips) && Array.isArray(g.guides), `campos de ${g.id}`);
  g.guides.forEach((u) => assert(u.startsWith('https://'), `guia https em ${g.id}`));
}
assert.strictEqual(new Set(games.map((g) => g.id)).size, games.length, 'ids únicos');

// Detecção por executável (Windows tasklist CSV)
const tasklist = '"System Idle Process","0","Services","0","8 K"\r\n"cs2.exe","1234","Console","1","2.000.000 K"\r\n';
const procs = core.parseProcessList(tasklist, 'win32');
assert.deepStrictEqual(procs, ['System Idle Process', 'cs2.exe']);
assert.strictEqual(core.detectGame(procs, games).id, 'cs2');
assert.strictEqual(core.detectGame(['CS2.EXE'], games).id, 'cs2', 'sem diferenciar maiúsculas');
assert.strictEqual(core.detectGame(['explorer.exe'], games), null);
assert.deepStrictEqual(core.parseProcessList('/usr/bin/bash\n  /opt/x/cs2.exe\n', 'linux'), ['bash', 'cs2.exe']);

// Detecção pela Steam
assert.strictEqual(core.parseRegValue('\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x2da\r\n', 'RunningAppID'), 730);
assert.strictEqual(core.parseRegValue('    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n', 'SteamPath'), 'c:/program files (x86)/steam');
assert.strictEqual(core.parseRegValue('    RunningAppID    REG_DWORD    0x0\r\n', 'RunningAppID'), 0);
assert.strictEqual(core.parseAcfName('"AppState"\n{\n\t"appid"\t\t"413150"\n\t"name"\t\t"Stardew Valley"\n}'), 'Stardew Valley');
assert.deepStrictEqual(core.parseLibraryFolders('"0"\n{\n\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n}\n"1"\n{\n\t"path"\t\t"D:\\\\SteamLibrary"\n}'),
  ['C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary']);
assert.strictEqual(core.detectGame([], games, { appId: 413150, name: 'Stardew Valley' }).id, 'stardew');
assert.strictEqual(core.detectGame([], games, { appId: 999999, name: 'Aniimo' }).id, 'aniimo', 'por nome');
const unknown = core.detectGame([], games, { appId: 123, name: 'Jogo Novo' });
assert.strictEqual(unknown.id, 'steam-123'); assert.strictEqual(unknown.name, 'Jogo Novo');
assert.strictEqual(core.detectGame([], games, { appId: 0, name: null }), null);

// Minecraft com e sem Cobblemon, R6
assert.strictEqual(core.detectGame(['javaw.exe'], games).id, 'minecraft');
assert.strictEqual(core.detectGame(['javaw.exe'], games, null, ['C:\\Users\\p\\curseforge\\Instances\\Cobblemon Official\\ java ...']).id, 'cobblemon');
assert.strictEqual(core.detectGame(['RainbowSix_BE.exe'], games).id, 'r6');

// Formatação
assert.strictEqual(core.formatDuration(65), '01:05');
assert.strictEqual(core.formatDuration(3725), '1:02:05');

// Armazenamento
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gc-')), 'data.json');
const s1 = new core.Store(file);
assert.strictEqual(s1.state.reminders.length, 2, 'lembretes padrão');
s1.addPlaytime('cs2', 5); s1.addPlaytime('cs2', 5);
s1.startSession('cs2', 1000); s1.endSession(2000);
s1.save();
const s2 = new core.Store(file);
assert.strictEqual(s2.state.playtime.cs2, 10);
assert.deepStrictEqual(s2.state.sessions, [{ gameId: 'cs2', start: 1000, end: 2000 }]);

// FPS (PresentMon)
const { FpsMeter } = require('../src/fps');
const fm = new FpsMeter();
fm.push('Application,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,MsBetweenPresents\r\n', 0);
fm.push(Array(200).fill('cs2.exe,1,0x1,DXGI,0,0,1,Hardware: Independent Flip,6.94').join('\r\n') + '\r\ncs2.exe,1,0x1,DXGI,0,0,1,x,20', 1000);
const r = fm.read(1000);
assert(r && r.fps >= 140 && r.fps <= 146, `fps ${r && r.fps}`);
fm.push('\r\n', 1000);
assert(fm.read(1000).low1 <= fm.read(1000).fps, '1% mais lento');
assert.strictEqual(new FpsMeter().read(), null);
const fm2 = new FpsMeter(); fm2.push('Application,FrameTime,CPUBusy\n' + 'a,16.6,1\n'.repeat(70), 5); assert.strictEqual(fm2.read(5).fps, 60, 'cabeçalho v2');

// Atualização
const { newer } = require('../src/updater');
assert(newer('v0.3.0', '0.2.0')); assert(newer('1.0.0', '0.9.9')); assert(!newer('v0.2.0', '0.2.0')); assert(!newer('0.1.9', '0.2.0'));

// Fim de sessão com FPS e nota
const s3 = new core.Store(path.join(path.dirname(file), 'd3.json'));
s3.startSession('x-hades', 10);
const ended = s3.endSession(130010, { fpsAvg: 144, fpsLow: 90 });
assert.deepStrictEqual(ended, { gameId: 'x-hades', start: 10, end: 130010, fpsAvg: 144, fpsLow: 90 });
assert.strictEqual(s3.endSession(140000), null, 'sem sessão aberta');
assert(s3.rateSession(10, 'good', 'rodou liso')); assert.strictEqual(s3.state.sessions[0].rating, 'good');
assert(!s3.rateSession(999, 'bad'));

// Qualquer jogo: janela da frente e biblioteca das lojas
const det = require('../src/detect');
const lib = det.buildLibrary({
  steam: [{ name: 'Hollow Knight', installdir: 'Hollow Knight', lib: 'D:\\SteamLibrary' }],
  epic: [JSON.stringify({ DisplayName: 'Fortnite', InstallLocation: 'C:\\Program Files\\Epic Games\\Fortnite' }), '{quebrado'],
  gog: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924\r\n    gameName    REG_SZ    The Witcher 3\r\n    path    REG_SZ    C:\\GOG Games\\The Witcher 3\r\n',
});
assert.deepStrictEqual(lib.map((g) => g.name), ['Hollow Knight', 'Fortnite', 'The Witcher 3']);
const hk = det.identifyForeground({ exe: 'D:\\SteamLibrary\\steamapps\\common\\Hollow Knight\\hollow_knight.exe', title: 'Hollow Knight', fullscreen: false }, lib);
assert.deepStrictEqual([hk.id, hk.name, hk.exe[0], hk.auto], ['x-hollow-knight', 'Hollow Knight', 'hollow_knight.exe', true]);
assert.strictEqual(det.identifyForeground({ exe: 'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe' }, lib).name, 'Fortnite');
assert.strictEqual(det.identifyForeground({ exe: 'E:\\Jogos\\steamapps\\common\\Palworld\\Pal\\Binaries\\Win64\\Palworld-Win64-Shipping.exe' }, []).name, 'Palworld', 'pasta da Steam sem biblioteca');
assert.strictEqual(det.identifyForeground({ exe: 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe', fullscreen: true }, []), null, 'launcher não é jogo');
assert.strictEqual(det.identifyForeground({ exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', fullscreen: true }, []), null, 'navegador em tela cheia');
assert.strictEqual(det.identifyForeground({ exe: 'C:\\Jogos\\Celeste\\Celeste.exe', fullscreen: false, title: 'Celeste' }, []), null, 'janela comum fora das pastas');
assert.strictEqual(det.identifyForeground({ exe: 'C:\\Jogos\\Celeste\\Celeste.exe', fullscreen: true, title: 'Celeste', description: 'Celeste' }, []).id, 'x-celeste', 'tela cheia');
assert.strictEqual(det.identifyForeground({ exe: 'C:\\Jogos\\Celeste\\Celeste.exe', fullscreen: true, title: 'Celeste' }, [], ['celeste.exe']), null, 'marcado como não é jogo');
assert.strictEqual(det.identifyForeground(null, lib), null);
assert.strictEqual(det.slug('Pokémon: Edição Ouro!'), 'pokemon-edicao-ouro');
assert.strictEqual(det.prettyName('Palworld-Win64-Shipping.exe'), 'Palworld');

// CS2 ao vivo (Game State Integration)
const { Cs2Live, gsiConfig } = require('../src/cs2');
const live = new Cs2Live();
const me = '76561198000000001';
const payload = (phase, ct, t, player) => ({
  provider: { steamid: me, timestamp: 1700000000 },
  map: { name: 'de_mirage', mode: 'competitive', phase, round: ct + t, team_ct: { score: ct }, team_t: { score: t } },
  round: { phase: 'live' }, player,
});
const mine = (k, a, d) => ({ steamid: me, name: 'p H n', team: 'T', state: { health: 100, money: 3400 }, match_stats: { kills: k, assists: a, deaths: d, mvps: 2 } });
let u = live.update(payload('live', 5, 7, mine(12, 3, 8)));
assert.strictEqual(u.match, null);
assert.deepStrictEqual([u.state.mapLabel, u.state.ctScore, u.state.tScore, u.state.kills, u.state.money, u.state.watching], ['Mirage', 5, 7, 12, 3400, false]);
assert(u.state.tips.length > 0, 'dicas do mapa');
// Morto, assistindo um colega: continua com os números do Pedro.
u = live.update(payload('live', 5, 8, { steamid: '765611980000999', name: 'amigo', team: 'T', state: { health: 80, money: 900 }, match_stats: { kills: 30, assists: 0, deaths: 1 } }));
assert.deepStrictEqual([u.state.kills, u.state.watching, u.state.health], [12, true, null]);
u = live.update(payload('gameover', 9, 13, mine(21, 4, 12)));
assert(u.match, 'partida no fim do jogo');
assert.deepStrictEqual([u.match.res, u.match.k, u.match.a, u.match.d], ['V', 21, 4, 12]);
assert(u.match.note.startsWith('Mirage · Competitivo, placar 13-9, 2 MVP'), u.match.note);
assert.strictEqual(live.update(payload('gameover', 9, 13, mine(21, 4, 12))).match, null, 'não registra duas vezes');
assert.strictEqual(live.update(null).state, null);
const dmLive = new Cs2Live();
const dmEnd = dmLive.update({ ...payload('gameover', 0, 0, mine(30, 2, 18)), map: { name: 'de_dust2', mode: 'deathmatch', phase: 'gameover', round: 0 } }).match;
assert.deepStrictEqual([dmEnd.res, dmEnd.k, dmEnd.note.split(' (')[0]], ['', 30, 'Dust2 · Mata-mata, 2 MVP'], 'mata-mata sem resultado');
const cfg = gsiConfig(3971, 'abc');
assert(cfg.includes('"uri" "http://127.0.0.1:3971/cs2"') && cfg.includes('"token" "abc"') && cfg.includes('"player_match_stats" "1"'));

console.log('OK: todos os testes passaram');
