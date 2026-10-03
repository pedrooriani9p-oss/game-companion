// Gravador dos clipes (janela escondida). Grava a tela o tempo todo, mas só guarda os últimos segundos:
// dois gravadores revezam, cada um começa `seconds` depois do outro e recomeça ao chegar no dobro disso.
// Assim sempre existe um com pelo menos `seconds` de vídeo para salvar, sem parar a gravação.
let cfg = null, stream = null, mime = '', slots = [], timer = null;

function pickMime() {
  const types = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function getStream() {
  const video = { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: cfg.sourceId, maxWidth: cfg.width, maxHeight: cfg.height, maxFrameRate: 30 } };
  // Som do PC junto (no Windows); se não der, grava só a imagem.
  try { return { s: await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video }), audio: true }; } catch {}
  return { s: await navigator.mediaDevices.getUserMedia({ audio: false, video }), audio: false };
}

function newSlot() {
  const opts = { videoBitsPerSecond: cfg.bitrate, audioBitsPerSecond: 128000 };
  if (mime) opts.mimeType = mime;
  const rec = new MediaRecorder(stream, opts);
  const slot = { rec, chunks: [], start: Date.now() };
  rec.ondataavailable = (e) => { if (e.data && e.data.size) slot.chunks.push(e.data); };
  rec.onerror = () => { slot.dead = true; };
  rec.start(1000);
  return slot;
}

function cycle() {
  const now = Date.now(), maxAge = cfg.seconds * 2000;
  for (const s of slots) if (now - s.start >= maxAge) { s.dead = true; try { s.rec.stop(); } catch {} }
  slots = slots.filter((s) => !s.dead);
  const newest = slots.reduce((b, s) => (!b || s.start > b.start ? s : b), null);
  if (!newest || now - newest.start >= cfg.seconds * 1000) slots.push(newSlot());
}

// Pega o que um gravador já tem (sem parar): o começo do arquivo vale como vídeo completo.
function snapshot(slot) {
  return new Promise((resolve) => {
    const done = () => resolve(new Blob(slot.chunks.slice(), { type: mime || 'video/webm' }));
    if (slot.rec.state !== 'recording') return done();
    const prev = slot.rec.ondataavailable;
    const t = setTimeout(done, 1500);
    slot.rec.ondataavailable = (e) => { prev(e); slot.rec.ondataavailable = prev; clearTimeout(t); done(); };
    try { slot.rec.requestData(); } catch { clearTimeout(t); done(); }
  });
}

async function save(reason) {
  const now = Date.now(), want = cfg.seconds * 1000;
  // O mais novo entre os que já têm o tempo pedido; no começo, o mais antigo.
  const ready = slots.filter((s) => now - s.start >= want).sort((a, b) => b.start - a.start);
  const slot = ready[0] || [...slots].sort((a, b) => a.start - b.start)[0];
  if (!slot || !slot.chunks.length) return window.api.recStatus({ status: 'on', msg: 'Ainda não há nada gravado. Tente de novo em alguns segundos.' });
  const blob = await snapshot(slot);
  const buf = await blob.arrayBuffer();
  await window.api.recFile(buf, Date.now() - slot.start, { mime: mime || 'video/webm', reason, audio: cfg.audio });
}

async function start(msg) {
  cfg = msg;
  try {
    const got = await getStream();
    stream = got.s; cfg.audio = got.audio;
    mime = pickMime();
    cycle();
    timer = setInterval(cycle, 1000);
    window.api.recStatus({ status: 'on', msg: got.audio ? '' : 'Gravando sem o som do PC.' });
  } catch (e) {
    window.api.recStatus({ status: 'error', msg: 'Não consegui gravar a tela neste PC.' });
  }
}

window.api.onRec((msg) => {
  if (msg.type === 'start' && !stream) start(msg);
  if (msg.type === 'save' && stream) save(msg.reason || '');
});
window.addEventListener('beforeunload', () => {
  clearInterval(timer);
  slots.forEach((s) => { try { s.rec.stop(); } catch {} });
  if (stream) stream.getTracks().forEach((t) => t.stop());
});
