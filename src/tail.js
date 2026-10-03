// Acompanha um arquivo de texto que cresce (registros de jogos), entregando só as linhas novas.
const fs = require('fs');

class Tail {
  constructor(file, onLines, { fromStart = false, interval = 1000 } = {}) {
    this.file = file; this.onLines = onLines; this.interval = interval; this.buf = ''; this.timer = null;
    try { this.pos = fromStart ? 0 : fs.statSync(file).size; } catch { this.pos = 0; }
  }
  start() { this.timer = setInterval(() => this.read(), this.interval); return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
  read() {
    let st;
    try { st = fs.statSync(this.file); } catch { return; }
    if (st.size < this.pos) { this.pos = 0; this.buf = ''; } // o jogo recomeçou o arquivo
    if (st.size === this.pos) return;
    const len = Math.min(st.size - this.pos, 2 * 1024 * 1024);
    const chunk = Buffer.alloc(len);
    let fd;
    try { fd = fs.openSync(this.file, 'r'); fs.readSync(fd, chunk, 0, len, this.pos); } catch { return; } finally { if (fd != null) fs.closeSync(fd); }
    this.pos += len;
    const lines = (this.buf + chunk.toString('utf8')).split('\n');
    this.buf = lines.pop();
    if (lines.length) this.onLines(lines);
  }
}

module.exports = { Tail };
