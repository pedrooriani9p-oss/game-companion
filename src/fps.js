// FPS lido do PresentMon (CSV). Lógica pura, testável com Node.
// Aceita cabeçalho v1 (MsBetweenPresents) ou v2 (FrameTime).
class FpsMeter {
  constructor(windowMs = 1000) { this.windowMs = windowMs; this.col = -1; this.frames = []; this.buf = ''; }
  push(chunk, now = Date.now()) {
    this.buf += chunk;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop();
    for (const line of lines) {
      const cells = line.split(',');
      if (this.col < 0) {
        const i = cells.findIndex((c) => /^(MsBetweenPresents|FrameTime)$/i.test(c.trim()));
        if (i >= 0) this.col = i;
        continue;
      }
      const ms = parseFloat(cells[this.col]);
      if (ms > 0 && ms < 1000) this.frames.push({ t: now, ms });
    }
    this.frames = this.frames.filter((f) => now - f.t <= this.windowMs * 2);
  }
  // FPS médio dos últimos quadros (até 1 segundo de quadros) e o 1% mais lento.
  read(now = Date.now()) {
    const recent = this.frames.filter((f) => now - f.t <= this.windowMs * 2);
    if (recent.length < 3) return null;
    let sum = 0; const used = [];
    for (let i = recent.length - 1; i >= 0 && sum < this.windowMs; i--) { sum += recent[i].ms; used.push(recent[i].ms); }
    const sorted = used.sort((a, b) => b - a);
    const low = sorted[Math.max(0, Math.floor(sorted.length * 0.01) - 1)];
    return { fps: Math.round((used.length * 1000) / sum), low1: Math.round(1000 / low) };
  }
}
module.exports = { FpsMeter };
