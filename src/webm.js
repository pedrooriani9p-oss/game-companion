// O vídeo gravado pelo Chromium (MediaRecorder) sai sem a duração no cabeçalho, e alguns players
// mostram 0:00 ou não deixam avançar. Aqui a duração é escrita no bloco Info do arquivo WebM.
const ID = { SEGMENT: 0x18538067, INFO: 0x1549a966, DURATION: 0x4489, TIMECODE_SCALE: 0x2ad7b1 };

function readId(buf, pos) {
  const first = buf[pos];
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || pos + len > buf.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}
function readSize(buf, pos) {
  const first = buf[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > buf.length) return null;
  let value = first & (0xff >> len), allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) { value = value * 256 + buf[pos + i]; if (buf[pos + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: allOnes };
}
// Tamanho sempre em 8 bytes (0x01 + 7 bytes): vale para qualquer valor e simplifica a troca.
function size8(n) {
  const b = Buffer.alloc(8); b[0] = 0x01;
  for (let i = 7; i >= 1; i--) { b[i] = n % 256; n = Math.floor(n / 256); }
  return b;
}

function fixDuration(input, durationMs) {
  const buf = Buffer.from(input);
  try {
    // Cabeçalho EBML.
    let pos = 0;
    const h = readId(buf, pos); if (!h || h.id !== 0x1a45dfa3) return buf;
    const hs = readSize(buf, pos + h.len); pos += h.len + hs.len + hs.value;
    // Segmento.
    const seg = readId(buf, pos); if (!seg || seg.id !== ID.SEGMENT) return buf;
    const segSizePos = pos + seg.len, ss = readSize(buf, segSizePos);
    let child = segSizePos + ss.len;
    while (child < buf.length) {
      const cid = readId(buf, child); if (!cid) return buf;
      const cs = readSize(buf, child + cid.len); if (!cs || cs.unknown) return buf;
      const dataStart = child + cid.len + cs.len, dataEnd = dataStart + cs.value;
      if (cid.id !== ID.INFO) { child = dataEnd; continue; }
      // Dentro do Info: escala de tempo e duração (se já existir).
      let scale = 1000000, durPos = null, durLen = 0, p = dataStart;
      while (p < dataEnd) {
        const e = readId(buf, p), es = readSize(buf, p + e.len), d = p + e.len + es.len;
        if (e.id === ID.TIMECODE_SCALE) { scale = 0; for (let i = 0; i < es.value; i++) scale = scale * 256 + buf[d + i]; }
        if (e.id === ID.DURATION) { durPos = d; durLen = es.value; }
        p = d + es.value;
      }
      const value = durationMs / (scale / 1000000);
      if (durPos != null) {
        if (durLen === 8) buf.writeDoubleBE(value, durPos); else if (durLen === 4) buf.writeFloatBE(value, durPos);
        return buf;
      }
      const dur = Buffer.alloc(11); dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88; dur.writeDoubleBE(value, 3);
      const newInfo = Buffer.concat([buf.subarray(child, child + cid.len), size8(cs.value + 11), buf.subarray(dataStart, dataEnd), dur]);
      const grow = newInfo.length - (dataEnd - child);
      const head = Buffer.from(buf.subarray(0, child));
      // Segmento com tamanho conhecido: atualiza o tamanho também.
      if (!ss.unknown) {
        const segHead = Buffer.concat([head.subarray(0, segSizePos), size8(ss.value + grow)]);
        return Buffer.concat([segHead, buf.subarray(segSizePos + ss.len, child), newInfo, buf.subarray(dataEnd)]);
      }
      return Buffer.concat([head, newInfo, buf.subarray(dataEnd)]);
    }
  } catch {}
  return buf;
}

// Lê a duração gravada (em ms), para os testes.
function readDuration(input) {
  const buf = Buffer.from(input);
  let pos = 0;
  const h = readId(buf, pos), hs = readSize(buf, pos + h.len); pos += h.len + hs.len + hs.value;
  const seg = readId(buf, pos), ss = readSize(buf, pos + seg.len);
  let child = pos + seg.len + ss.len;
  while (child < buf.length) {
    const cid = readId(buf, child), cs = readSize(buf, child + cid.len);
    const dataStart = child + cid.len + cs.len, dataEnd = dataStart + cs.value;
    if (cid.id === ID.INFO) {
      let p = dataStart, scale = 1000000, dur = null;
      while (p < dataEnd) {
        const e = readId(buf, p), es = readSize(buf, p + e.len), d = p + e.len + es.len;
        if (e.id === ID.TIMECODE_SCALE) { scale = 0; for (let i = 0; i < es.value; i++) scale = scale * 256 + buf[d + i]; }
        if (e.id === ID.DURATION) dur = es.value === 8 ? buf.readDoubleBE(d) : buf.readFloatBE(d);
        p = d + es.value;
      }
      return dur == null ? null : dur * (scale / 1000000);
    }
    if (cs.unknown) return null;
    child = dataEnd;
  }
  return null;
}

module.exports = { fixDuration, readDuration };
