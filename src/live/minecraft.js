// Minecraft e Cobblemon ao vivo pelo registro do jogo (logs/latest.log). Lógica pura, testável com Node.

// Começos de mensagens de morte em inglês e em português (o texto depois do nome do jogador).
const DEATH = new RegExp('^(' + [
  'was (slain|shot|killed|blown up|fireballed|pummeled|impaled|stung|squashed|squished|poked|pricked|struck|frozen|obliterated|skewered|doomed|burnt|roasted|sniped|spitballed)',
  'drowned', 'died', 'blew up', 'hit the ground too hard', 'fell (from|off|out|into|while)', 'burned to death', 'went (up in flames|off with a bang)',
  'walked into', 'tried to swim in lava', 'starved to death', 'suffocated', 'withered away', 'froze to death', 'experienced kinetic energy',
  'discovered the floor was lava', "didn't want to live", 'left the confines',
  'foi (morto|morta|baleado|baleada|explodido|explodida|empalado|empalada|picado|picada|esmagado|esmagada|atingido|atingida|espetado|espetada|congelado|congelada|eliminado|eliminada|obliterado|obliterada|queimado|queimada|perfurado|perfurada|lançado|lançada|derrubado|derrubada)',
  'morreu', 'se afogou', 'afogou-se', 'explodiu', 'caiu', 'atingiu o chão', 'pegou fogo', 'virou cinzas', 'tentou nadar na lava', 'sufocou', 'definhou', 'congelou',
  'descobriu que o chão era lava', 'entrou em', 'sentiu a energia', 'não quis mais viver',
].join('|') + ')', 'i');
const ADVANCEMENT = /^(has made the advancement|has completed the challenge|has reached the goal|.*(progresso|desafio|objetivo|conquista|avanço)) \[(.+)\]$/i;
const CATCH = /(You (?:caught|captured)|Você capturou) (?:a |an |um |uma )?(.+?)!?$/i;

class MinecraftLog {
  constructor() { this.player = null; this.world = null; this.deaths = []; this.advancements = []; this.catches = []; this.recent = new Map(); }
  // replay: linhas antigas do arquivo (só para descobrir o jogador e o mundo).
  line(raw, { replay = false, now = Date.now() } = {}) {
    const l = String(raw).replace(/\r$/, '');
    let m = l.match(/Setting user: (\S+)/);
    if (m) { this.player = m[1]; return null; }
    m = l.match(/Preparing level "(.+)"/) || l.match(/Connecting to ([^,\s]+), \d+/);
    if (m) { this.world = m[1]; return null; }
    if (replay) return null;
    // Mensagem do chat (cliente) ou do servidor integrado (um jogador).
    m = l.match(/\[CHAT\] (.+)$/) || l.match(/\[Server thread\/INFO\]: (.+)$/);
    if (!m) return null;
    const msg = m[1].trim();
    if (msg.startsWith('<')) return null; // conversa de jogador
    // A mesma mensagem aparece no servidor e no chat: conta uma vez só.
    if (this.recent.has(msg) && now - this.recent.get(msg) < 5000) return null;
    this.recent.set(msg, now);
    if (this.recent.size > 50) this.recent.delete(this.recent.keys().next().value);
    const c = msg.match(CATCH);
    if (c) { this.catches.push({ at: now, name: c[2] }); return { type: 'catch', name: c[2], count: this.catches.length }; }
    if (!this.player || !msg.startsWith(this.player + ' ')) return null;
    const rest = msg.slice(this.player.length + 1);
    const a = rest.match(ADVANCEMENT);
    if (a) { this.advancements.push({ at: now, name: a[3] }); return { type: 'advancement', name: a[3] }; }
    if (DEATH.test(rest)) { this.deaths.push({ at: now, cause: rest }); return { type: 'death', cause: rest, count: this.deaths.length }; }
    return null;
  }
  highlights() {
    const h = [];
    if (this.deaths.length) h.push(`${this.deaths.length} ${this.deaths.length === 1 ? 'morte' : 'mortes'}`);
    if (this.advancements.length) h.push(`conquistas: ${this.advancements.map((x) => x.name).join(', ')}`);
    if (this.catches.length) h.push(`${this.catches.length} capturas (${[...new Set(this.catches.map((x) => x.name))].slice(0, 6).join(', ')})`);
    return h;
  }
}

// Pasta do jogo na linha de comando do Java (--gameDir "C:\...").
function gameDirFromCmdline(cmd) {
  const m = String(cmd).match(/--gameDir\s+(?:"([^"]+)"|(\S+))/);
  return m ? m[1] || m[2] : null;
}

module.exports = { MinecraftLog, gameDirFromCmdline, DEATH };
