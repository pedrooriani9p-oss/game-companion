// Clipes+: lista da pasta, pedaços do arquivo para o player (Range) e o plano de exportação
// (corte e versão leve para o Discord). Lógica pura, testável com Node.
const crypto = require('crypto');
const path = require('path');

const clipId = (file) => crypto.createHash('sha1').update(String(file).toLowerCase()).digest('hex').slice(0, 16);
const isVideo = (name) => /\.(mp4|webm)$/i.test(name);

// Junta os arquivos da pasta com o que o app sabe de cada clipe (jogo, motivo). Mais novos primeiro.
// files: [{ file, size, mtime }], known: [{ file, at, ms, game, reason }]
function mergeClips(files, known) {
  const byFile = new Map((known || []).map((c) => [String(c.file).toLowerCase(), c]));
  return (files || []).filter((f) => isVideo(f.file)).map((f) => {
    const k = byFile.get(String(f.file).toLowerCase()) || {};
    return {
      id: clipId(f.file), file: f.file, name: path.basename(f.file), size: f.size, at: k.at || f.mtime, ms: k.ms || null,
      game: k.game || null, reason: k.reason || '', kind: k.kind || (/\((corte|discord)\)\.\w+$/i.test(f.file) ? (/discord/i.test(f.file) ? 'discord' : 'trim') : ''),
    };
  }).sort((a, b) => b.at - a.at);
}

// Cabeçalho Range ("bytes=100-200") → { start, end } dentro do arquivo, ou null quando inválido.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2]) || !size) return null;
  let start, end;
  if (!m[1]) { start = Math.max(0, size - Number(m[2])); end = size - 1; } else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  return start > end || start >= size ? null : { start, end };
}

// Nome do arquivo exportado, ao lado do original: "CS2 2026-10-04 21-00-00 (corte).mp4".
function exportName(file, mode, ext) {
  const base = path.basename(file).replace(/\.(mp4|webm)$/i, '').replace(/ \((corte|discord)( \d+)?\)$/i, '');
  return `${base} (${mode === 'discord' ? 'Discord' : 'corte'}).${ext}`;
}

module.exports = { clipId, isVideo, mergeClips, parseRange, exportName };
