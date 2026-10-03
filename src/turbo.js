// PC turbo: o que está pesando, por que o FPS caiu e o plano de energia. Lógica pura, testável com Node.

// Programas que não aparecem na lista para fechar: Windows, drivers, antivírus, Steam e anti-cheats
// (fechar qualquer um deles derruba o jogo ou o PC).
const PROTECTED = new Set([
  'system', 'system idle process', 'idle', 'registry', 'secure system', 'memory compression', 'vmmem', 'smss.exe', 'csrss.exe',
  'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'lsaiso.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe', 'fontdrvhost.exe',
  'audiodg.exe', 'spoolsv.exe', 'searchindexer.exe', 'searchhost.exe', 'searchapp.exe', 'startmenuexperiencehost.exe',
  'shellexperiencehost.exe', 'runtimebroker.exe', 'sihost.exe', 'taskhostw.exe', 'ctfmon.exe', 'conhost.exe', 'dllhost.exe',
  'wmiprvse.exe', 'msmpeng.exe', 'nissrv.exe', 'mpdefendercoreservice.exe', 'securityhealthservice.exe', 'securityhealthsystray.exe',
  'textinputhost.exe', 'smartscreen.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wudfhost.exe', 'dashost.exe', 'taskmgr.exe',
  'applicationframehost.exe', 'systemsettings.exe', 'lockapp.exe', 'widgets.exe', 'phoneexperiencehost.exe', 'crossdevicesvc.exe',
  'presentmon.exe', 'game companion.exe', 'electron.exe', 'nvcontainer.exe', 'nvdisplay.container.exe', 'nvidia web helper.exe',
  'nvidia share.exe', 'nvidia overlay.exe', 'amdrsserv.exe', 'atiesrxx.exe', 'atieclxx.exe', 'radeonsoftware.exe', 'igfxem.exe',
  'steam.exe', 'steamservice.exe', 'steamwebhelper.exe', 'gameoverlayui.exe', 'gameoverlayui64.exe',
  'vgc.exe', 'vgtray.exe', 'vgk.sys', 'riotclientservices.exe', 'riotclientux.exe', 'riotclientcrashhandler.exe',
  'easyanticheat.exe', 'easyanticheat_eos.exe', 'beservice.exe', 'beservice_x64.exe', 'faceit.exe', 'faceitservice.exe',
  'epicgameslauncher.exe', 'eosoverlayrenderer-win64-shipping.exe', 'upc.exe', 'uplaywebcore.exe', 'ubisoftconnect.exe',
  'eadesktop.exe', 'eabackgroundservice.exe', 'battle.net.exe', 'agent.exe', 'xboxpcapp.exe', 'gamingservices.exe',
  'gamebar.exe', 'gamebarftserver.exe', 'javaw.exe', 'java.exe',
]);
const isProtected = (name) => PROTECTED.has(String(name).toLowerCase()) || /^(easyanticheat|beservice|battleye|gamecompanion)/i.test(name);

// Junta os processos com o mesmo nome (Chrome abre dezenas) e devolve os que mais pesam.
// list: [{ name, cpu (%), memRss (KB) }]. exclude: nomes do jogo atual (não aparecem).
function topProcesses(list, { exclude = [], limit = 8, cpuCount = 1 } = {}) {
  const skip = new Set(exclude.map((e) => String(e).toLowerCase()));
  const groups = new Map();
  for (const p of list || []) {
    const name = String(p.name || '').trim();
    if (!name || isProtected(name) || skip.has(name.toLowerCase())) continue;
    const key = name.toLowerCase();
    const g = groups.get(key) || { name, cpu: 0, ramMb: 0, count: 0 };
    g.cpu += Number(p.cpu) || 0; g.ramMb += (Number(p.memRss) || 0) / 1024; g.count++;
    groups.set(key, g);
  }
  // Alguns sistemas contam o uso por núcleo (pode passar de 100%): divide pelo número de núcleos.
  const scale = [...groups.values()].some((g) => g.cpu > 100) ? Math.max(1, cpuCount) : 1;
  return [...groups.values()]
    .map((g) => ({ name: g.name, label: friendly(g.name), cpu: Math.round((g.cpu / scale) * 10) / 10, ramMb: Math.round(g.ramMb), count: g.count }))
    .filter((g) => g.cpu >= 0.5 || g.ramMb >= 150)
    .sort((a, b) => b.cpu - a.cpu || b.ramMb - a.ramMb)
    .slice(0, limit);
}

// Nome amigável para os programas mais comuns.
const FRIENDLY = {
  'chrome.exe': 'Google Chrome', 'msedge.exe': 'Microsoft Edge', 'firefox.exe': 'Firefox', 'opera.exe': 'Opera', 'opera_gx.exe': 'Opera GX',
  'brave.exe': 'Brave', 'discord.exe': 'Discord', 'spotify.exe': 'Spotify', 'obs64.exe': 'OBS', 'teams.exe': 'Teams', 'ms-teams.exe': 'Teams',
  'onedrive.exe': 'OneDrive', 'whatsapp.exe': 'WhatsApp', 'code.exe': 'VS Code', 'wallpaper64.exe': 'Wallpaper Engine', 'wallpaper32.exe': 'Wallpaper Engine',
  'medal.exe': 'Medal', 'overwolf.exe': 'Overwolf', 'icue.exe': 'iCUE', 'lghub.exe': 'Logitech G HUB', 'razer synapse 3.exe': 'Razer Synapse',
};
const friendly = (name) => FRIENDLY[String(name).toLowerCase()] || String(name).replace(/\.exe$/i, '');

// Por que o FPS caiu: olha o PC no momento da queda.
// sys: { cpu, gpu, cpuTemp, gpuTemp, ramUsed, ramTotal, vramUsed, vramTotal }. top: saída de topProcesses.
function diagnoseDrop({ sys = {}, top = [] } = {}) {
  const hog = top.find((p) => p.cpu >= 15);
  if ((sys.cpuTemp || 0) >= 90 || (sys.gpuTemp || 0) >= 85) {
    const which = (sys.gpuTemp || 0) >= 85 ? `placa de vídeo a ${Math.round(sys.gpuTemp)}°C` : `processador a ${Math.round(sys.cpuTemp)}°C`;
    return { cause: 'heat', text: `PC quente (${which}): ele reduz a velocidade para esfriar. Limpe a poeira e deixe o ar circular.` };
  }
  if (hog) return { cause: 'app', app: hog.name, text: `${friendly(hog.name)} estava usando ${Math.round(hog.cpu)}% do processador. Feche enquanto joga.` };
  if (sys.gpu != null && sys.gpu >= 95) return { cause: 'gpu', text: 'A placa de vídeo estava no limite. Baixe sombras, resolução ou o anti-aliasing.' };
  if (sys.cpu != null && sys.cpu >= 90) return { cause: 'cpu', text: 'O processador estava no limite. Feche programas abertos e baixe a qualidade de física e multidões.' };
  if (sys.ramTotal && sys.ramUsed / sys.ramTotal >= 0.9) return { cause: 'ram', text: 'A memória RAM estava quase cheia. Feche o navegador e outros programas.' };
  if (sys.vramTotal && sys.vramUsed / sys.vramTotal >= 0.95) return { cause: 'vram', text: 'A memória da placa de vídeo encheu. Baixe a qualidade das texturas.' };
  return { cause: 'unknown', text: 'Sem causa clara no PC: pode ser o próprio jogo, a internet ou o disco.' };
}

// Detecta queda de FPS: amostras a cada 2 s; a referência é a mediana dos últimos 2 minutos.
class DropDetector {
  constructor({ ratio = 0.7, minBase = 30, need = 2, cooldownMs = 60000 } = {}) {
    Object.assign(this, { ratio, minBase, need, cooldownMs });
    this.samples = []; this.low = 0; this.lastDrop = 0;
  }
  reset() { this.samples = []; this.low = 0; }
  baseline() {
    const old = this.samples.slice(0, -3).map((s) => s.fps).sort((a, b) => a - b);
    return old.length >= 10 ? old[Math.floor(old.length / 2)] : null;
  }
  // Retorna { from, to } quando acabou de detectar uma queda.
  push(fpsValue, now = Date.now()) {
    if (fpsValue == null) return null;
    const base = this.baseline();
    this.samples.push({ fps: fpsValue, at: now });
    while (this.samples.length && now - this.samples[0].at > 120000) this.samples.shift();
    if (base == null || base < this.minBase) return null;
    if (fpsValue < base * this.ratio) this.low++; else this.low = 0;
    if (this.low >= this.need && now - this.lastDrop > this.cooldownMs) {
      this.lastDrop = now; this.low = 0;
      return { from: Math.round(base), to: Math.round(fpsValue) };
    }
    return null;
  }
}

// Plano de energia "Alto desempenho" do Windows e o GUID na saída do powercfg.
const HIGH_PERF = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const parseScheme = (out) => ((String(out).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || '').toLowerCase() || null;
const hasScheme = (listOut, guid) => String(listOut).toLowerCase().includes(guid);

module.exports = { PROTECTED, isProtected, topProcesses, friendly, diagnoseDrop, DropDetector, HIGH_PERF, parseScheme, hasScheme };
