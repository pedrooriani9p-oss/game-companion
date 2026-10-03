// Stardew Valley: lê o arquivo SaveGameInfo que o jogo grava ao dormir. Lógica pura, testável com Node.

const SEASONS = ['Primavera', 'Verão', 'Outono', 'Inverno'];
const SEASON_IDS = { spring: 0, summer: 1, fall: 2, winter: 3 };
const SKILLS = [['farmingLevel', 'Cultivo'], ['miningLevel', 'Mineração'], ['foragingLevel', 'Coleta'], ['fishingLevel', 'Pesca'], ['combatLevel', 'Combate']];
const SEASON_TIPS = [
  ['Plante couve-flor e batata; guarde dinheiro para os morangos do Festival do Ovo (dia 13).', 'Pesque no rio e junte forragem para os primeiros pacotes do Centro Comunitário.'],
  ['Mirtilo e melão rendem muito no verão; plante cedo para colher várias vezes.', 'No dia 11 tem o Luau: coloque um item de qualidade na sopa.'],
  ['Oxicoco e abóbora dão ótimo lucro no outono.', 'O Festival da Colheita (dia 16) e o Vale Assombrado (dia 27) têm itens únicos.'],
  ['Sem plantações ao ar livre: aproveite para descer nas minas e pescar.', 'Use o inverno para conversar com todo mundo e subir amizades.'],
];

const tag = (xml, name) => { const m = String(xml).match(new RegExp(`<${name}>([^<]*)</${name}>`)); return m ? m[1] : null; };
const num = (xml, name) => { const v = tag(xml, name); return v == null || v === '' ? null : Number(v); };

function parseSaveInfo(xml) {
  if (!xml || !/<Farmer|<farmName>/.test(xml)) return null;
  let season = num(xml, 'seasonForSaveGame');
  if (season == null) season = SEASON_IDS[(tag(xml, 'currentSeason') || '').toLowerCase()] ?? null;
  const levels = {};
  for (const [k] of SKILLS) levels[k] = num(xml, k) ?? 0;
  return {
    farm: tag(xml, 'farmName'), money: num(xml, 'money'), earned: num(xml, 'totalMoneyEarned'),
    day: num(xml, 'dayOfMonthForSaveGame') ?? num(xml, 'dayOfMonth'), season, year: num(xml, 'yearForSaveGame') ?? num(xml, 'year'), levels,
  };
}

const dateLabel = (s) => (s && s.day != null && s.season != null ? `${SEASONS[s.season]} ${s.day}, ano ${s.year || 1}` : '');

// Compara dois dias salvos: dinheiro e habilidades que subiram.
function diffSaves(prev, cur) {
  if (!prev || !cur) return null;
  const ups = SKILLS.filter(([k]) => cur.levels[k] > prev.levels[k]).map(([k, label]) => `${label} ${cur.levels[k]}`);
  const sameDay = prev.day === cur.day && prev.season === cur.season && prev.year === cur.year;
  return { money: (cur.money ?? 0) - (prev.money ?? 0), ups, newDay: !sameDay };
}

module.exports = { parseSaveInfo, diffSaves, dateLabel, SEASONS, SKILLS, SEASON_TIPS };
