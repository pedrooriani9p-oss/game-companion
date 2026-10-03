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

// Valorant (cliente da Riot no PC)
const val = require('../src/live/valorant');
assert.deepStrictEqual(val.parseLockfile('Riot Client:1234:51234:s3nh4:https'), { name: 'Riot Client', pid: 1234, port: 51234, password: 's3nh4', protocol: 'https' });
assert.strictEqual(val.parseLockfile(''), null);
assert.strictEqual(val.mapName('/Game/Maps/Triad/Triad'), 'Haven');
assert.strictEqual(val.mapName('/Game/Maps/Ascent/Ascent', { '/Game/Maps/Ascent/Ascent': 'Ascent' }), 'Ascent');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
// Formato antigo (tudo num nível) e novo (aninhado) da presença.
const flatP = val.decodePresence(b64({ sessionLoopState: 'INGAME', matchMap: '/Game/Maps/Bonsai/Bonsai', queueId: 'competitive', partyOwnerMatchScoreAllyTeam: 7, partyOwnerMatchScoreEnemyTeam: 4 }));
const nestedP = val.decodePresence(b64({ isValid: true, matchPresenceData: { sessionLoopState: 'INGAME', matchMap: '/Game/Maps/Bonsai/Bonsai', queueId: 'competitive' }, partyPresenceData: { partyOwnerMatchScoreAllyTeam: 7, partyOwnerMatchScoreEnemyTeam: 4 } }));
for (const pr of [flatP, nestedP]) {
  const st = val.liveFromPresence(pr);
  assert.deepStrictEqual([st.loop, st.map, st.queueLabel, st.ally, st.enemy, st.tips.length > 0], ['INGAME', 'Split', 'Competitivo', 7, 4, true]);
}
assert.strictEqual(val.decodePresence('%%%'), null);
const vlive = new val.ValorantLive();
assert.strictEqual(vlive.update(flatP).ended, null);
const endedV = vlive.update(val.decodePresence(b64({ sessionLoopState: 'MENUS', queueId: 'competitive' }))).ended;
assert.strictEqual(endedV.map, 'Split', 'fim da partida percebido');
assert.deepStrictEqual(val.parseShooterLog('x https://glz-br-1.na.a.pvp.net/session y\nLogShooter: Display: CI server version: release-11.06-shipping-7-3592541\n'),
  { region: 'br', shard: 'na', version: 'release-11.06-shipping-7-3592541' });
const PUUID = 'aaaa-bbbb';
const details = {
  matchInfo: { matchId: 'm1', mapId: '/Game/Maps/Bonsai/Bonsai', queueID: 'competitive', gameStartMillis: 1000, gameLengthMillis: 2000 },
  players: [{ subject: PUUID, teamId: 'Blue', characterId: 'ABC', stats: { score: 4800, roundsPlayed: 20, kills: 19, deaths: 12, assists: 6 } }, { subject: 'other', teamId: 'Red', characterId: 'X', stats: {} }],
  teams: [{ teamId: 'Blue', won: true, roundsWon: 13 }, { teamId: 'Red', won: false, roundsWon: 7 }],
  roundResults: [{ playerStats: [{ subject: PUUID, damage: [{ headshots: 3, bodyshots: 6, legshots: 1 }] }] }],
};
const vm = val.summarizeMatch(details, PUUID, { agents: { abc: 'Jett' } });
assert.deepStrictEqual([vm.res, vm.k, vm.d, vm.a, vm.at], ['V', 19, 12, 6, 3000]);
assert.strictEqual(vm.note, 'Split · Competitivo, placar 13-7, agente Jett, 240 ACS, 30% na cabeça (registrado pelo app do PC)');
assert.strictEqual(val.summarizeMatch(details, 'ninguém'), null);
const pm = val.matchFromPresence(val.liveFromPresence(flatP), 5);
assert.deepStrictEqual([pm.res, pm.k, pm.note], ['V', null, 'Split · Competitivo, placar 7-4 (registrado pelo app do PC, sem K/D)']);

// Minecraft e Cobblemon (logs/latest.log)
const { MinecraftLog, gameDirFromCmdline } = require('../src/live/minecraft');
const mc = new MinecraftLog();
mc.line('[18:00:01] [main/INFO]: Setting user: PedroMC', { replay: true });
mc.line('[18:00:09] [Server thread/INFO]: Preparing level "Mundo do Pedro"', { replay: true });
assert.deepStrictEqual([mc.player, mc.world], ['PedroMC', 'Mundo do Pedro']);
let ev = mc.line('[18:05:00] [Server thread/INFO]: PedroMC was slain by Zombie', { now: 1000 });
assert.deepStrictEqual([ev.type, ev.cause, ev.count], ['death', 'was slain by Zombie', 1]);
assert.strictEqual(mc.line('[18:05:00] [Render thread/INFO]: [System] [CHAT] PedroMC was slain by Zombie', { now: 1200 }), null, 'mesma morte no chat conta uma vez');
assert.strictEqual(mc.line('[18:06:00] [Render thread/INFO]: [System] [CHAT] <PedroMC> morreu de rir kkk', { now: 9000 }), null, 'conversa não é morte');
assert.strictEqual(mc.line('[18:06:30] [Render thread/INFO]: [System] [CHAT] PedroMC caiu de um lugar alto', { now: 20000 }).type, 'death', 'mensagem em português');
assert.strictEqual(mc.line('[18:07:00] [Render thread/INFO]: [System] [CHAT] PedroMC has made the advancement [Diamonds!]', { now: 30000 }).name, 'Diamonds!');
assert.strictEqual(mc.line('[18:08:00] [Render thread/INFO]: [System] [CHAT] You caught a Pikachu!', { now: 40000 }).name, 'Pikachu');
assert.strictEqual(mc.line('[18:09:00] [Render thread/INFO]: [System] [CHAT] OutraPessoa was slain by Zombie', { now: 50000 }), null, 'morte de outro jogador');
assert.deepStrictEqual(mc.highlights(), ['2 mortes', 'conquistas: Diamonds!', '1 capturas (Pikachu)']);
assert.strictEqual(gameDirFromCmdline('javaw -Xmx4G --username Pedro --gameDir "C:\\Users\\p\\curseforge\\minecraft\\Instances\\Cobblemon" --assetsDir x'), 'C:\\Users\\p\\curseforge\\minecraft\\Instances\\Cobblemon');
assert.strictEqual(gameDirFromCmdline('javaw --gameDir C:\\mc\\inst --x'), 'C:\\mc\\inst');

// TF2 (console com -condebug)
const { Tf2Console, personaFromLoginUsers } = require('../src/live/tf2');
assert.strictEqual(personaFromLoginUsers('"users"\n{\n\t"76561198000000001"\n\t{\n\t\t"AccountName"\t\t"a"\n\t\t"PersonaName"\t\t"Velho"\n\t\t"MostRecent"\t\t"0"\n\t}\n\t"76561198000000002"\n\t{\n\t\t"PersonaName"\t\t"p H n"\n\t\t"MostRecent"\t\t"1"\n\t}\n}'), 'p H n');
const tf = new Tf2Console('p H n');
assert.deepStrictEqual(tf.line('Map: ctf_2fort'), { type: 'map', map: 'ctf_2fort', previous: null });
assert.strictEqual(tf.line('p H n killed Bob with scattergun.').streak, 1);
assert.strictEqual(tf.line('p H n killed Ana with tf_projectile_rocket. (crit)').weapon, 'Lança-foguetes');
assert.strictEqual(tf.line('p H n killed Leo with scattergun.').streak, 3);
assert.strictEqual(tf.line('Bob killed p H n with sniperrifle.').by, 'Bob');
tf.line('Bob killed p H n with sniperrifle. (crit)');
assert.strictEqual(tf.line('Ana killed Leo with minigun.'), null, 'abate entre outros');
tf.line('p H n suicided.');
assert.deepStrictEqual([tf.kills, tf.deaths, tf.best, tf.streak, tf.crits], [3, 3, 3, 0, 1]);
const tfMap = tf.line('Map: pl_badwater');
assert.deepStrictEqual([tfMap.previous.k, tfMap.previous.d, tfMap.previous.res], [3, 3, '']);
assert.strictEqual(tfMap.previous.note, 'ctf_2fort, melhor sequência 3, mais abates com Espingarda, quem mais te matou: Bob (2) (registrado pelo app do PC)');
assert.strictEqual(tf.summary(), null, 'mapa novo sem nada ainda');

// Stardew (SaveGameInfo)
const sd = require('../src/live/stardew');
const save = (money, day, farming) => `<?xml version="1.0"?><Farmer><items><Item><name>Parsnip</name></Item></items><name>Pedro</name><farmName>Vale Feliz</farmName><money>${money}</money><totalMoneyEarned>9000</totalMoneyEarned><farmingLevel>${farming}</farmingLevel><miningLevel>1</miningLevel><foragingLevel>2</foragingLevel><fishingLevel>0</fishingLevel><combatLevel>1</combatLevel><dayOfMonthForSaveGame>${day}</dayOfMonthForSaveGame><seasonForSaveGame>1</seasonForSaveGame><yearForSaveGame>2</yearForSaveGame></Farmer>`;
const d5 = sd.parseSaveInfo(save(1500, 5, 2)), d6 = sd.parseSaveInfo(save(2750, 6, 3));
assert.deepStrictEqual([d5.farm, d5.money, d5.day, d5.season, d5.year, d5.levels.farmingLevel], ['Vale Feliz', 1500, 5, 1, 2, 2]);
assert.strictEqual(sd.dateLabel(d6), 'Verão 6, ano 2');
assert.deepStrictEqual(sd.diffSaves(d5, d6), { money: 1250, ups: ['Cultivo 3'], newDay: true });
assert.strictEqual(sd.diffSaves(d6, d6).newDay, false);
assert.strictEqual(sd.parseSaveInfo('lixo'), null);

// Arquivo que cresce (Tail)
const { Tail } = require('../src/tail');
const tfile = path.join(path.dirname(file), 'log.txt');
fs.writeFileSync(tfile, 'antiga\n');
const got = [];
const tl = new Tail(tfile, (ls) => got.push(...ls));
fs.appendFileSync(tfile, 'nova 1\nnova');
tl.read();
fs.appendFileSync(tfile, ' 2\n');
tl.read();
fs.writeFileSync(tfile, 'recomeçou\n');
tl.read();
assert.deepStrictEqual(got, ['nova 1', 'nova 2', 'recomeçou']);

// ---------- Evolução ----------
const stats = require('../src/stats');
{
  // Datas fixas na hora local: quarta 08/10/2025 15:00.
  const now = new Date(2025, 9, 8, 15, 0).getTime();
  const at = (dDay, h = 20) => new Date(2025, 9, dDay, h, 0).getTime();
  assert.strictEqual(new Date(stats.weekStart(now)).getDay(), 1, 'semana começa na segunda');
  assert.strictEqual(new Date(stats.weekStart(now)).getDate(), 6);
  assert.strictEqual(stats.fmtHours(3600 + 5 * 60), '1h 05m');
  assert.strictEqual(stats.fmtHours(600), '10 min');
  const history = [
    { game: 'cs2', at: at(1), res: 'V', k: 20, a: 4, d: 10, map: 'de_mirage', mapLabel: 'Mirage' },
    { game: 'cs2', at: at(2), res: 'V', k: 15, a: 2, d: 15, map: 'de_mirage', mapLabel: 'Mirage' },
    { game: 'cs2', at: at(3), res: 'D', k: 8, a: 1, d: 16, map: 'de_inferno', mapLabel: 'Inferno' },
    { game: 'cs2', at: at(4), res: 'V', k: 25, a: 3, d: 12, map: 'de_mirage', mapLabel: 'Mirage' },
    { game: 'cs2', at: at(5), res: 'D', k: 10, a: 5, d: 18, map: 'de_inferno', mapLabel: 'Inferno' },
    { game: 'cs2', at: at(6), res: 'D', k: 12, a: 2, d: 17, map: 'de_inferno', mapLabel: 'Inferno' },
    { game: 'cs2', at: at(7), res: 'V', k: 30, a: 6, d: 9, map: 'de_mirage', mapLabel: 'Mirage' },
    { game: 'cs2', at: at(8, 10), res: '', k: 22, a: 0, d: 20, note: 'Dust2 · Mata-mata (registrado pelo app do PC)' },
    { game: 'stardew', at: at(7), prog: true, note: 'diário' },
  ];
  const s = stats.summarize(history.filter((m) => m.game === 'cs2'));
  assert.strictEqual(s.n, 8); assert.strictEqual(s.decided, 7); assert.strictEqual(s.wins, 4);
  assert.strictEqual(s.kills, 142); assert.strictEqual(s.deaths, 117);
  assert(Math.abs(s.kd - 142 / 117) < 1e-9);
  const maps = stats.byMap(history.filter((m) => m.game === 'cs2'));
  assert.deepStrictEqual(maps.map((r) => [r.map, r.n]), [['Mirage', 4], ['Inferno', 3], ['Dust2', 1]], 'mapa também pela nota');
  assert.deepStrictEqual(stats.bestWorst(maps), { best: 'Mirage', worst: 'Inferno', metric: 'win' });
  const series = stats.kdSeries(history.filter((m) => m.game === 'cs2'));
  assert.strictEqual(series.length, 8);
  assert(Math.abs(series[1].avg - 35 / 25) < 1e-9, 'média móvel');
  const rec = stats.records(history.filter((m) => m.game === 'cs2'), [{ gameId: 'cs2', start: at(2, 19), end: at(2, 23) }]);
  assert.strictEqual(rec.mostKills.k, 30);
  assert.strictEqual(rec.bestKd.k, 30);
  assert.strictEqual(rec.winStreak.n, 2);
  assert.strictEqual(rec.longestSession.end - rec.longestSession.start, 4 * 3600000);
  const sessions = [
    { gameId: 'cs2', start: at(6, 20), end: at(6, 22) },            // segunda: 2 h
    { gameId: 'cs2', start: at(7, 23), end: at(8, 1) },             // vira o dia: 1 h na terça, 1 h na quarta
    { gameId: 'stardew', start: at(8, 13), end: null },             // aberta: conta até agora (2 h)
    { gameId: 'cs2', start: at(1, 20), end: at(1, 23) },            // semana passada: 3 h
  ];
  const days = stats.dailyPlaytime(sessions, { game: 'cs2', days: 3, now });
  assert.deepStrictEqual(days.map((d) => d.sec / 3600), [2, 1, 1]);
  assert.strictEqual(stats.playSeconds(sessions, stats.weekStart(now), now + 1, null, now) / 3600, 6);
  const wk = stats.weekly(history, sessions, now);
  const cs = wk.find((r) => r.game === 'cs2');
  assert.strictEqual(cs.cur.sec / 3600, 4); assert.strictEqual(cs.prev.sec / 3600, 3);
  assert.strictEqual(cs.cur.n, 3); assert.strictEqual(cs.prev.n, 5);
  // Metas
  const kdGoal = stats.goalProgress({ type: 'kd', game: 'cs2', target: 1.2 }, history, sessions, now);
  assert.strictEqual(kdGoal.done, true); assert.strictEqual(kdGoal.valueText, '1,21');
  const winGoal = stats.goalProgress({ type: 'win', game: 'cs2', target: 60 }, history, sessions, now);
  assert.strictEqual(winGoal.done, false); assert.strictEqual(winGoal.valueText, '57%');
  const hours = stats.goalProgress({ type: 'hours', game: null, target: 5 }, history, sessions, now);
  assert.strictEqual(hours.over, true); assert.strictEqual(hours.valueText, '6,0');
  const few = stats.goalProgress({ type: 'kd', game: 'tf2', target: 1 }, history, sessions, now);
  assert.strictEqual(few.enough, false); assert.strictEqual(few.done, false);
  // Tudo junto, como a aba mostra
  const ev = stats.evolution({ history, sessions, goals: [{ id: '1', type: 'kd', game: 'cs2', target: 1.2 }], game: null, days: 7, now, nameOf: (id) => ({ cs2: 'Counter-Strike 2', stardew: 'Stardew Valley' }[id] || id) });
  assert.strictEqual(ev.game, 'cs2', 'escolhe o jogo com partidas');
  assert.strictEqual(ev.summary.n, 7, 'últimos 7 dias (02 a 08)');
  assert.strictEqual(ev.playtime.length, 7);
  assert.strictEqual(ev.games[0].id, 'stardew', 'mais recente primeiro');
  assert(ev.prev && ev.prev.n === 1, '7 dias anteriores (25/09 a 01/10)');
  const report = stats.claudeReport(ev, now);
  assert(/Counter-Strike 2/.test(report) && /Mirage/.test(report) && /3 coisas/.test(report), 'relatório para o Claude');
  // Aviso de segunda-feira
  const monday = new Date(2025, 9, 13, 9, 0).getTime();
  const closed = sessions.map((x) => (x.end ? x : { ...x, end: at(8, 15) }));
  const line = stats.lastWeekLine(history, closed, monday, (id) => ({ cs2: 'CS2' }[id] || id));
  assert.strictEqual(line, '📊 Semana passada: 6h 00m de jogo. CS2: 3 partidas, 50% de vitórias, K/D 1,39 (▲ 0,29).');
  assert.strictEqual(stats.lastWeekLine([], [], monday), null);
}

// Histórico no Store (sem duplicar, sem anotações do Diário)
{
  const st = new core.Store(path.join(os.tmpdir(), `gc-hist-${Date.now()}.json`));
  assert.strictEqual(st.addMatch('cs2', { at: 1000, res: 'V', k: 1, d: 2, map: 'de_nuke', note: 'x' }), true);
  assert.strictEqual(st.addMatch('cs2', { at: 1500, res: 'V' }), false, 'mesma partida');
  assert.strictEqual(st.addMatch('valorant', { at: 1500, res: 'D' }), true, 'outro jogo');
  assert.strictEqual(st.addMatch('stardew', { at: 2000, prog: true, note: 'dia' }), false);
  assert.deepStrictEqual(st.state.history[0], { game: 'cs2', at: 1000, res: 'V', k: 1, d: 2, map: 'de_nuke' });
  assert.strictEqual(st.state.settings.hudItems.fps, true, 'ajustes novos com padrão');
}

// ---------- Dica de compra do CS2 ----------
{
  const { buyAdvice } = require('../src/cs2');
  const base = { mode: 'competitive', team: 'T', phase: 'live', round: 5, money: 4800, lossStreak: 0 };
  assert.strictEqual(buyAdvice(base).kind, 'full');
  assert.strictEqual(buyAdvice({ ...base, round: 0, money: 800 }).kind, 'pistol');
  assert.strictEqual(buyAdvice({ ...base, round: 11, money: 1500 }).kind, 'all-in');
  assert.strictEqual(buyAdvice({ ...base, money: 3000, lossStreak: 0 }).kind, 'eco', '3000 + 1400 passa de 4300');
  assert.strictEqual(buyAdvice({ ...base, team: 'CT', money: 2200, lossStreak: 0 }).kind, 'force');
  assert.strictEqual(buyAdvice({ ...base, team: 'CT', money: 1200, lossStreak: 0 }).kind, 'eco');
  assert.strictEqual(buyAdvice({ ...base, mode: 'deathmatch' }), null);
  assert.strictEqual(buyAdvice({ ...base, watching: true }), null);
  assert.strictEqual(buyAdvice({ ...base, mode: 'scrimcomp2v2', round: 8 }).kind, 'pistol', 'Wingman troca de lado na 9ª');
}

// ---------- PC turbo ----------
const turbo = require('../src/turbo');
{
  const list = [
    { name: 'chrome.exe', cpu: 12, memRss: 300 * 1024 }, { name: 'chrome.exe', cpu: 9, memRss: 500 * 1024 },
    { name: 'svchost.exe', cpu: 30, memRss: 100 * 1024 }, { name: 'cs2.exe', cpu: 60, memRss: 4000 * 1024 },
    { name: 'Discord.exe', cpu: 2, memRss: 400 * 1024 }, { name: 'tiny.exe', cpu: 0.1, memRss: 10 * 1024 },
    { name: 'vgc.exe', cpu: 5, memRss: 50 * 1024 }, { name: 'EasyAntiCheat_EOS.exe', cpu: 3, memRss: 20 * 1024 },
  ];
  const top = turbo.topProcesses(list, { exclude: ['cs2.exe'] });
  assert.deepStrictEqual(top.map((p) => [p.label, p.cpu, p.ramMb, p.count]), [['Google Chrome', 21, 800, 2], ['Discord', 2, 400, 1]]);
  assert.strictEqual(turbo.topProcesses([{ name: 'a.exe', cpu: 400, memRss: 0 }], { cpuCount: 8 })[0].cpu, 50, 'uso por núcleo vira total');
  const d1 = turbo.diagnoseDrop({ sys: { cpu: 70, gpu: 60 }, top });
  assert.strictEqual(d1.cause, 'app'); assert(/Google Chrome/.test(d1.text));
  assert.strictEqual(turbo.diagnoseDrop({ sys: { cpu: 40, gpu: 99 }, top: [] }).cause, 'gpu');
  assert.strictEqual(turbo.diagnoseDrop({ sys: { cpu: 95, gpu: 50 }, top: [] }).cause, 'cpu');
  assert.strictEqual(turbo.diagnoseDrop({ sys: { cpu: 50, gpu: 50, gpuTemp: 88 }, top }).cause, 'heat');
  assert.strictEqual(turbo.diagnoseDrop({ sys: { cpu: 50, gpu: 50, ramUsed: 15, ramTotal: 16 }, top: [] }).cause, 'ram');
  assert.strictEqual(turbo.diagnoseDrop({ sys: { cpu: 30, gpu: 40 }, top: [] }).cause, 'unknown');
  // Queda: 2 min a 140 FPS, depois duas amostras a 70.
  const det = new turbo.DropDetector();
  let t0 = 0, drop = null;
  for (let i = 0; i < 40; i++) { t0 += 2000; assert.strictEqual(det.push(140 + (i % 3), t0), null); }
  t0 += 2000; assert.strictEqual(det.push(70, t0), null, 'uma amostra só não conta');
  t0 += 2000; drop = det.push(72, t0);
  assert.deepStrictEqual(drop, { from: 141, to: 72 });
  t0 += 2000; assert.strictEqual(det.push(60, t0), null, 'espera 1 min para avisar de novo');
  const det2 = new turbo.DropDetector();
  for (let i = 0; i < 40; i++) det2.push(25, i * 2000);
  assert.strictEqual(det2.push(10, 82000) || det2.push(10, 84000), null, 'FPS já baixo não vira aviso');
  assert.strictEqual(turbo.parseScheme('GUID do Esquema de Energia: 381b4222-f694-41f0-9685-ff5bb260df2e  (Equilibrado)'), '381b4222-f694-41f0-9685-ff5bb260df2e');
  assert(turbo.hasScheme('Existing Power Schemes\n8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c (High performance)', turbo.HIGH_PERF));
}

// ---------- Duração do vídeo dos clipes (WebM) ----------
{
  const { fixDuration, readDuration } = require('../src/webm');
  // WebM mínimo como o do Chromium: EBML, Segment de tamanho desconhecido, Info sem Duration, um Cluster.
  const el = (id, data) => { const size = Buffer.from([0x80 | data.length]); return Buffer.concat([Buffer.from(id), size, data]); };
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from('webm')));
  const info = el([0x15, 0x49, 0xa9, 0x66], Buffer.concat([el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), el([0x4d, 0x80], Buffer.from('Chrome'))]));
  const cluster = Buffer.concat([Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0xe7, 0x81, 0x00])]);
  const seg = Buffer.concat([Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), info, cluster]);
  const file = Buffer.concat([ebml, seg]);
  assert.strictEqual(readDuration(file), null);
  const fixed = fixDuration(file, 31500);
  assert.strictEqual(readDuration(fixed), 31500);
  assert.strictEqual(fixed.length, file.length + 11 + 7, 'Duration (11 bytes) e o tamanho do Info em 8 bytes');
  assert(fixed.subarray(fixed.length - cluster.length).equals(cluster), 'resto do vídeo intacto');
  assert.strictEqual(readDuration(fixDuration(fixed, 12000)), 12000, 'troca a duração que já existe');
  assert(fixDuration(Buffer.from('não é vídeo'), 1000).equals(Buffer.from('não é vídeo')), 'arquivo estranho fica igual');
}

// ---------- Duração do vídeo dos clipes (MP4 em pedaços, como o do Chromium) ----------
{
  const { fixMp4Duration, readMp4Duration, mp4MediaDuration } = require('../src/mp4');
  const frag = fs.readFileSync(path.join(__dirname, 'fixtures', 'frag.mp4'));
  assert.strictEqual(readMp4Duration(frag), 0, 'vem sem duração');
  assert.strictEqual(mp4MediaDuration(frag), 2000, 'soma das amostras: 2 s');
  const fixed = fixMp4Duration(frag, 2000);
  assert.strictEqual(readMp4Duration(fixed), 2000);
  assert.strictEqual(fixed.length, frag.length + 20, 'ganha só o mehd');
  assert(fixed.subarray(fixed.length - 1000).equals(frag.subarray(frag.length - 1000)), 'vídeo intacto');
  assert.strictEqual(mp4MediaDuration(fixed), 2000, 'continua legível');
  assert.strictEqual(readMp4Duration(fixMp4Duration(fixed, 1500)), 1500, 'troca o mehd que já existe');
  assert(fixMp4Duration(Buffer.from('xx'), 10).equals(Buffer.from('xx')));
}

console.log('OK: todos os testes passaram');
