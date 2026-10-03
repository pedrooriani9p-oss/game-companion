// TF2 ao vivo pelo console salvo em arquivo (opção de inicialização -condebug). Lógica pura, testável com Node.

const WEAPONS = {
  scattergun: 'Espingarda', pistol_scout: 'Pistola', bat: 'Taco', tf_projectile_rocket: 'Lança-foguetes', rocketlauncher_directhit: 'Direct Hit',
  shotgun_soldier: 'Escopeta', shotgun_primary: 'Escopeta', shotgun_pyro: 'Escopeta', shotgun_hwg: 'Escopeta', flamethrower: 'Lança-chamas',
  tf_projectile_pipe: 'Lança-granadas', tf_projectile_pipe_remote: 'Bombas adesivas', minigun: 'Metralhadora giratória', fists: 'Punhos',
  obj_sentrygun: 'Sentinela', obj_sentrygun2: 'Sentinela', obj_sentrygun3: 'Sentinela', obj_minisentry: 'Minissentinela', wrench: 'Chave inglesa',
  syringegun_medic: 'Pistola de seringas', bonesaw: 'Serra', sniperrifle: 'Rifle de precisão', smg: 'Submetralhadora', tf_projectile_arrow: 'Arco',
  knife: 'Faca', revolver: 'Revólver', deflect_rocket: 'Foguete refletido', world: 'Queda ou ambiente', player: 'Queda ou ambiente',
};
const weaponName = (w) => WEAPONS[w] || String(w).replace(/^tf_(projectile_)?/, '').replace(/_/g, ' ');

class Tf2Console {
  constructor(me) { this.me = me; this.reset(null); }
  reset(map) { this.map = map; this.kills = 0; this.deaths = 0; this.streak = 0; this.best = 0; this.crits = 0; this.killers = {}; this.weapons = {}; this.started = Date.now(); }
  // Retorna um evento ou null. 'map' traz o resumo do mapa anterior em "previous".
  line(raw) {
    const l = String(raw).replace(/\r$/, '').trim();
    let m = l.match(/^Map: (\S+)$/);
    if (m) {
      if (m[1] === this.map) return null;
      const previous = this.summary();
      this.reset(m[1]);
      return { type: 'map', map: m[1], previous };
    }
    if (!this.me) return null;
    if (l === `${this.me} suicided.`) { this.deaths++; this.streak = 0; return { type: 'death', by: null }; }
    m = l.match(/^(.+) killed (.+) with (.+?)\.( \(crit\))?$/);
    if (!m) return null;
    if (m[1] === this.me && m[2] !== this.me) {
      this.kills++; this.streak++; this.best = Math.max(this.best, this.streak);
      if (m[4]) this.crits++;
      const w = weaponName(m[3]); this.weapons[w] = (this.weapons[w] || 0) + 1;
      return { type: 'kill', victim: m[2], weapon: w, streak: this.streak };
    }
    if (m[2] === this.me) {
      this.deaths++; this.streak = 0;
      if (m[1] !== this.me) this.killers[m[1]] = (this.killers[m[1]] || 0) + 1;
      return { type: 'death', by: m[1] === this.me ? null : m[1], weapon: weaponName(m[3]) };
    }
    return null;
  }
  top(obj) { const e = Object.entries(obj).sort((a, b) => b[1] - a[1])[0]; return e ? { name: e[0], n: e[1] } : null; }
  // Resumo do mapa atual (null se quase nada aconteceu).
  summary(now = Date.now()) {
    if (!this.map || this.kills + this.deaths < 3) return null;
    const w = this.top(this.weapons), nem = this.top(this.killers);
    const parts = [this.map];
    parts.push(`melhor sequência ${this.best}`);
    if (w) parts.push(`mais abates com ${w.name}`);
    if (nem && nem.n >= 2) parts.push(`quem mais te matou: ${nem.name} (${nem.n})`);
    return { at: now, res: '', k: this.kills, a: null, d: this.deaths, map: this.map, best: this.best, note: `${parts.join(', ')} (registrado pelo app do PC)` };
  }
}

// Nome na Steam (PersonaName) do usuário mais recente em config/loginusers.vdf.
function personaFromLoginUsers(text) {
  const blocks = String(text).split(/"\d{17}"\s*\{/).slice(1);
  let first = null;
  for (const b of blocks) {
    const name = (b.match(/"PersonaName"\s+"([^"]*)"/) || [])[1];
    if (!name) continue;
    if (/"MostRecent"\s+"1"/.test(b)) return name;
    if (!first) first = name;
  }
  return first;
}

module.exports = { Tf2Console, personaFromLoginUsers, weaponName };
