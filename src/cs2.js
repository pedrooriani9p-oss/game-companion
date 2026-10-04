// CS2 ao vivo pelo Game State Integration (recurso oficial da Valve). Lógica pura, testável com Node.

// Dicas rápidas por mapa.
const MAP_TIPS = {
  de_dust2: ['Smoke no Xbox (meio) ajuda o time a cruzar para o B ou Short.', 'No CT, o AWP no Mid Doors segura muita rodada.', 'Long A: a flash por cima da porta cega quem segura o pit.'],
  de_mirage: ['Smoke no Jungle e no CT para tomar o A pelo Palace e Ramp.', 'Controle o Mid: Connector e Window abrem os dois bombs.', 'No B, a molotov no Bench tira quem fica escondido no canto.'],
  de_inferno: ['Banana é a chave do B: jogue molotov e HE cedo.', 'No A, smoke no Pit, Library e Arch para entrar.', 'CTs: segure Banana com utilitário nos primeiros 20 segundos.'],
  de_nuke: ['O Outside define o jogo: smokes no Mini e no Garage.', 'Lembre que Ramp e Hut levam ao A e ao B de baixo.', 'Som atravessa o chão: ande de shift perto do A.'],
  de_ancient: ['Controle o Mid para dividir o CT entre A e B.', 'No B, smoke no CT e na Cave antes de entrar.', 'No A, cuidado com o Donut e o Temple ao mesmo tempo.'],
  de_anubis: ['Mid é curto: use smoke no Connector para cruzar.', 'No B, a água dá acesso rápido; jogue flash antes.', 'No A, o Heaven dos CTs vê quase todo o bomb.'],
  de_vertigo: ['A Ramp do A é o caminho principal: molotov e flash juntos.', 'Cuidado com quedas: não pule perto da borda sem olhar.', 'No B, smoke na Elevator e no Window para plantar.'],
  de_overpass: ['Toilets e Monster são os acessos ao B; segure com utilitário.', 'No A, Long e Bathrooms se cruzam: jogue com o time.', 'Connector liga os dois bombs: rotacione por ali.'],
  de_train: ['No A, os trens bloqueiam visão: limpe cada vão.', 'Ivy e Connector são os caminhos principais para o A.', 'No B, entre com flash pela Upper ou Lower.'],
};
const mapLabel = (name) => String(name || '').replace(/^(de|cs|ar|dz)_/, '').replace(/^./, (c) => c.toUpperCase());
const MODES = { competitive: 'Competitivo', premier: 'Premier', casual: 'Casual', deathmatch: 'Mata-mata', scrimcomp2v2: 'Wingman', gungameprogressive: 'Corrida armamentista' };

class Cs2Live {
  constructor() { this.state = null; this.lastPhase = null; this.lastMine = null; this.reported = new Set(); }
  // Recebe o JSON enviado pelo jogo. Retorna { state, match } (match só no fim de uma partida).
  update(p) {
    if (!p || !p.map) { this.state = null; this.lastPhase = null; return { state: null, match: null }; }
    const me = p.provider && p.provider.steamid;
    const pl = p.player || {};
    const mine = pl.steamid && me && pl.steamid === me;
    // Depois de morrer, o jogo mostra quem você está assistindo; os números só valem quando "player" é você.
    if (mine && pl.match_stats) this.lastMine = { team: pl.team, ...pl.match_stats, money: pl.state && pl.state.money, health: pl.state && pl.state.health, roundKills: pl.state && pl.state.round_kills };
    const ct = (p.map.team_ct && p.map.team_ct.score) || 0, t = (p.map.team_t && p.map.team_t.score) || 0;
    const m = this.lastMine || {};
    this.state = {
      map: p.map.name, mapLabel: mapLabel(p.map.name), mode: p.map.mode, phase: p.map.phase, round: p.map.round,
      roundPhase: p.round && p.round.phase, ctScore: ct, tScore: t, team: m.team || null,
      kills: m.kills ?? null, assists: m.assists ?? null, deaths: m.deaths ?? null, mvps: m.mvps ?? null,
      money: mine && pl.state ? pl.state.money : m.money ?? null, health: mine && pl.state ? pl.state.health : null,
      watching: !mine && Boolean(pl.name), tips: MAP_TIPS[p.map.name] || [],
      roundKills: mine && pl.state ? pl.state.round_kills ?? null : null,
      lossStreak: m.team === 'CT' ? (p.map.team_ct || {}).consecutive_round_losses ?? 0 : m.team === 'T' ? (p.map.team_t || {}).consecutive_round_losses ?? 0 : 0,
    };
    this.state.buy = buyAdvice(this.state);
    let match = null;
    const key = `${p.map.name}-${ct}-${t}-${m.kills}-${m.deaths}-${(p.provider && p.provider.timestamp) ? Math.floor(p.provider.timestamp / 3600) : ''}`;
    if (p.map.phase === 'gameover' && this.lastPhase !== 'gameover' && !this.reported.has(key)) {
      this.reported.add(key);
      const myScore = m.team === 'CT' ? ct : m.team === 'T' ? t : null, other = m.team === 'CT' ? t : m.team === 'T' ? ct : null;
      // No mata-mata não há placar de time: fica sem resultado.
      const dm = p.map.mode === 'deathmatch';
      match = {
        at: Date.now(), res: myScore == null || dm ? '' : myScore > other ? 'V' : myScore < other ? 'D' : 'E',
        k: m.kills ?? null, a: m.assists ?? null, d: m.deaths ?? null,
        note: `${mapLabel(p.map.name)}${MODES[p.map.mode] ? ` · ${MODES[p.map.mode]}` : ''}${dm ? '' : `, placar ${myScore ?? ct}-${other ?? t}`}${m.mvps ? `, ${m.mvps} MVP` : ''} (registrado pelo app do PC)`,
        map: p.map.name, mapLabel: mapLabel(p.map.name), mode: p.map.mode, mvps: m.mvps ?? null,
        score: dm || myScore == null ? null : [myScore, other],
      };
    }
    if (p.map.phase !== 'gameover' && this.lastPhase === 'gameover') this.lastMine = null;
    this.lastPhase = p.map.phase;
    return { state: this.state, match };
  }
}

// Dica de compra pela economia: só com o seu dinheiro, o placar e a sequência de derrotas do seu time
// (tudo que o jogo mostra para você). Valores aproximados do CS2: bônus de derrota 1.400 + 500 por derrota seguida, até 3.400.
const HALVES = { competitive: 12, premier: 12, scrimcomp2v2: 8 };
function buyAdvice(s) {
  const half = s && HALVES[s.mode];
  if (!half || s.money == null || !s.team || s.watching || s.phase === 'warmup' || s.phase === 'gameover') return null;
  const r = s.round ?? 0, money = s.money;
  const full = s.team === 'CT' ? 5000 : 4300;
  if (r === 0 || r === half) return { kind: 'pistol', say: 'Rodada de pistola', text: 'Rodada de pistola: colete ou uma pistola melhor, mais uma granada.' };
  if (r === half - 1 || r === 2 * half - 1) return { kind: 'all-in', say: 'Última rodada do tempo: gaste tudo', text: 'Última rodada do tempo: gaste tudo, o dinheiro zera depois.' };
  if (money >= full) return { kind: 'full', say: 'Compra completa', text: `Compra completa: fuzil, colete com capacete${s.team === 'CT' ? ', kit' : ''} e granadas.` };
  if (money >= full - 700) return { kind: 'full', say: 'Fuzil e colete', text: 'Quase completa: fuzil e colete, menos granadas.' };
  const nextIfLose = money + Math.min(3400, 1400 + 500 * (s.lossStreak || 0));
  if (nextIfLose >= full) return { kind: 'eco', say: 'Eco, guarde o dinheiro', text: `Eco: guarde. Mesmo perdendo, na próxima você terá uns $${nextIfLose.toLocaleString('pt-BR')} para comprar tudo.` };
  if (money >= 2000) return { kind: 'force', say: 'Force buy, se o time comprar', text: 'Force buy: SMG ou escopeta com colete, se o time também comprar.' };
  return { kind: 'eco', say: 'Eco', text: 'Eco: fique com a pistola e jogue junto para pegar armas.' };
}

// Arquivo de configuração que o CS2 lê na pasta cfg ao abrir.
function gsiConfig(port, token) {
  return `"Game Companion"
{
  "uri" "http://127.0.0.1:${port}/cs2"
  "timeout" "5.0"
  "buffer" "0.1"
  "throttle" "0.5"
  "heartbeat" "10.0"
  "auth" { "token" "${token}" }
  "data"
  {
    "provider" "1"
    "map" "1"
    "round" "1"
    "player_id" "1"
    "player_state" "1"
    "player_match_stats" "1"
  }
}
`;
}

module.exports = { Cs2Live, gsiConfig, MAP_TIPS, mapLabel, buyAdvice, MODES };
