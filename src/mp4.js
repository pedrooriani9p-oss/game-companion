// O MP4 gravado pelo Chromium vem em pedaços (MP4 fragmentado) e com duração zero no cabeçalho.
// Aqui a duração é escrita no moov (mvhd, tkhd, mdhd) e num mehd, para os players mostrarem o tempo e deixarem avançar.
function readBox(buf, p, end) {
  if (p + 8 > end) return null;
  let size = buf.readUInt32BE(p), hdr = 8;
  const type = buf.toString('latin1', p + 4, p + 8);
  if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
  if (size < hdr || p + size > end) return null;
  return { type, start: p, size, hdr, end: p + size };
}
function children(buf, box) {
  const out = [];
  for (let p = box.start + box.hdr; p < box.end;) { const b = readBox(buf, p, box.end); if (!b) break; out.push(b); p = b.end; }
  return out;
}
const find = (list, type) => list.find((b) => b.type === type);

function setDuration(buf, box, timescaleOffset, value) {
  // mvhd e mdhd: versão 0 = campos de 32 bits, versão 1 = 64 bits.
  const v = buf[box.start + box.hdr], base = box.start + box.hdr + 4;
  if (v === 1) { const ts = buf.readUInt32BE(base + 16); buf.writeBigUInt64BE(BigInt(Math.round(value(ts))), base + 20); return ts; }
  const ts = buf.readUInt32BE(base + 8); buf.writeUInt32BE(Math.min(0xffffffff, Math.round(value(ts))), base + 12); return ts;
}

function fixMp4Duration(input, durationMs) {
  const src = Buffer.from(input);
  try {
    const top = [];
    for (let p = 0; p < src.length;) { const b = readBox(src, p, src.length); if (!b) break; top.push(b); p = b.end; }
    const moov = find(top, 'moov');
    if (!moov || !find(top, 'moof')) return src;
    // Os dados dos pedaços precisam ser relativos ao próprio moof; senão, inserir bytes no moov quebraria o arquivo.
    const firstMoof = find(top, 'moof'), traf = find(children(src, firstMoof), 'traf'), tfhd = traf && find(children(src, traf), 'tfhd');
    const canInsert = tfhd && !(src.readUInt32BE(tfhd.start + tfhd.hdr) & 0x1);
    const buf = Buffer.from(src);
    const kids = children(buf, moov);
    const mvhd = find(kids, 'mvhd');
    if (!mvhd) return src;
    const movieTs = setDuration(buf, mvhd, 0, (ts) => (durationMs * ts) / 1000);
    for (const trak of kids.filter((b) => b.type === 'trak')) {
      const tk = children(buf, trak), tkhd = find(tk, 'tkhd');
      if (tkhd) {
        const v = buf[tkhd.start + tkhd.hdr], base = tkhd.start + tkhd.hdr + 4, d = Math.round((durationMs * movieTs) / 1000);
        if (v === 1) buf.writeBigUInt64BE(BigInt(d), base + 24); else buf.writeUInt32BE(Math.min(0xffffffff, d), base + 16);
      }
      const mdia = find(tk, 'mdia'), mdhd = mdia && find(children(buf, mdia), 'mdhd');
      if (mdhd) setDuration(buf, mdhd, 0, (ts) => (durationMs * ts) / 1000);
    }
    const mvex = find(kids, 'mvex');
    if (!mvex || !canInsert) return buf;
    const mehd = find(children(buf, mvex), 'mehd');
    const frag = BigInt(Math.round((durationMs * movieTs) / 1000));
    if (mehd) {
      if (buf[mehd.start + mehd.hdr] === 1) buf.writeBigUInt64BE(frag, mehd.start + mehd.hdr + 4); else buf.writeUInt32BE(Number(frag), mehd.start + mehd.hdr + 4);
      return buf;
    }
    if (moov.hdr !== 8 || mvex.hdr !== 8) return buf;
    const box = Buffer.alloc(20);
    box.writeUInt32BE(20, 0); box.write('mehd', 4, 'latin1'); box.writeUInt32BE(0x01000000, 8); box.writeBigUInt64BE(frag, 12);
    const at = mvex.start + mvex.hdr;
    const out = Buffer.concat([buf.subarray(0, at), box, buf.subarray(at)]);
    out.writeUInt32BE(mvex.size + 20, mvex.start);
    out.writeUInt32BE(moov.size + 20, moov.start);
    return out;
  } catch { return src; }
}

// Duração real do vídeo (ms), somando as amostras de cada pedaço (moof): o relógio da gravação
// começa um pouco antes do primeiro quadro, então o tempo de parede não serve.
function mp4MediaDuration(input) {
  const buf = Buffer.from(input);
  try {
    const top = [];
    for (let p = 0; p < buf.length;) { const b = readBox(buf, p, buf.length); if (!b) break; top.push(b); p = b.end; }
    const moov = find(top, 'moov');
    if (!moov) return null;
    const scale = {}, defDur = {};
    for (const b of children(buf, moov)) {
      if (b.type === 'trak') {
        const tk = children(buf, b), tkhd = find(tk, 'tkhd'), mdia = find(tk, 'mdia'), mdhd = mdia && find(children(buf, mdia), 'mdhd');
        if (!tkhd || !mdhd) continue;
        const tv = buf[tkhd.start + tkhd.hdr], id = buf.readUInt32BE(tkhd.start + tkhd.hdr + 4 + (tv === 1 ? 16 : 8));
        const mv = buf[mdhd.start + mdhd.hdr];
        scale[id] = buf.readUInt32BE(mdhd.start + mdhd.hdr + 4 + (mv === 1 ? 16 : 8));
      }
      if (b.type === 'mvex') for (const t of children(buf, b)) if (t.type === 'trex') defDur[buf.readUInt32BE(t.start + 12)] = buf.readUInt32BE(t.start + 20);
    }
    const span = {};
    for (const moof of top.filter((b) => b.type === 'moof')) {
      for (const traf of children(buf, moof).filter((b) => b.type === 'traf')) {
        const parts = children(buf, traf), tfhd = find(parts, 'tfhd'), tfdt = find(parts, 'tfdt');
        if (!tfhd || !tfdt) continue;
        const flags = buf.readUInt32BE(tfhd.start + 8) & 0xffffff, id = buf.readUInt32BE(tfhd.start + 12);
        let q = tfhd.start + 16;
        if (flags & 0x1) q += 8; if (flags & 0x2) q += 4;
        let dflt = defDur[id] || 0;
        if (flags & 0x8) dflt = buf.readUInt32BE(q);
        const base = buf[tfdt.start + 8] === 1 ? Number(buf.readBigUInt64BE(tfdt.start + 12)) : buf.readUInt32BE(tfdt.start + 12);
        let total = 0;
        for (const trun of parts.filter((b) => b.type === 'trun')) {
          const tf = buf.readUInt32BE(trun.start + 8) & 0xffffff, count = buf.readUInt32BE(trun.start + 12);
          let r = trun.start + 16;
          if (tf & 0x1) r += 4; if (tf & 0x4) r += 4;
          const per = ((tf & 0x100) ? 4 : 0) + ((tf & 0x200) ? 4 : 0) + ((tf & 0x400) ? 4 : 0) + ((tf & 0x800) ? 4 : 0);
          for (let i = 0; i < count; i++) { total += (tf & 0x100) ? buf.readUInt32BE(r) : dflt; r += per; }
        }
        const sp = span[id] || (span[id] = { start: base, end: base });
        sp.start = Math.min(sp.start, base); sp.end = Math.max(sp.end, base + total);
      }
    }
    const ms = Object.entries(span).map(([id, sp]) => (scale[id] ? ((sp.end - sp.start) * 1000) / scale[id] : 0));
    return ms.length ? Math.max(...ms) : null;
  } catch { return null; }
}

// Duração (ms) que o cabeçalho diz: mehd quando existe, senão mvhd. Para os testes.
function readMp4Duration(input) {
  const buf = Buffer.from(input);
  const top = [];
  for (let p = 0; p < buf.length;) { const b = readBox(buf, p, buf.length); if (!b) break; top.push(b); p = b.end; }
  const moov = find(top, 'moov');
  if (!moov) return null;
  const kids = children(buf, moov), mvhd = find(kids, 'mvhd');
  const v = buf[mvhd.start + mvhd.hdr], base = mvhd.start + mvhd.hdr + 4;
  const ts = v === 1 ? buf.readUInt32BE(base + 16) : buf.readUInt32BE(base + 8);
  let d = v === 1 ? Number(buf.readBigUInt64BE(base + 20)) : buf.readUInt32BE(base + 12);
  const mvex = find(kids, 'mvex'), mehd = mvex && find(children(buf, mvex), 'mehd');
  if (mehd) d = buf[mehd.start + mehd.hdr] === 1 ? Number(buf.readBigUInt64BE(mehd.start + mehd.hdr + 4)) : buf.readUInt32BE(mehd.start + mehd.hdr + 4);
  return (d * 1000) / ts;
}

module.exports = { fixMp4Duration, readMp4Duration, mp4MediaDuration };
