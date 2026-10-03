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

console.log('OK: todos os testes passaram');
