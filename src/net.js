// Ping e perda de pacotes: lê a saída do comando ping (Windows em português ou inglês, e Linux)
// e resume o último minuto. Lógica pura, testável com Node.

// Uma linha do ping: { ms } quando respondeu, { lost: true } quando não, null para cabeçalho e resumo.
function parsePingLine(line) {
  const l = String(line || '').trim();
  if (!l) return null;
  if (/ttl[=:]/i.test(l)) {
    const m = l.match(/(?:time|tempo|tiempo|zeit)\s*([=<])\s*([\d.,]+)\s*ms/i);
    if (!m) return { ms: 1 };
    const v = Number(m[2].replace(',', '.'));
    return { ms: m[1] === '<' ? Math.min(v, 1) : v };
  }
  if (/esgotado|timed out|inacess|unreachable|falha|failure|expirou|transmit failed|no answer yet|tempo limite/i.test(l)) return { lost: true };
  return null;
}

// Guarda as respostas do último minuto. Cada push é uma resposta (ms) ou uma perda (null).
class PingStats {
  constructor(windowMs = 60000) { this.windowMs = windowMs; this.samples = []; }
  reset() { this.samples = []; }
  push(ms, now = Date.now()) {
    this.samples.push({ at: now, ms: ms == null ? null : Number(ms) });
    while (this.samples.length && now - this.samples[0].at > this.windowMs) this.samples.shift();
  }
  // Resumo das amostras dos últimos `ms` milissegundos (padrão: a janela toda).
  summary(span = this.windowMs, now = Date.now()) {
    const list = this.samples.filter((s) => now - s.at <= span);
    const ok = list.filter((s) => s.ms != null).map((s) => s.ms);
    if (!list.length) return null;
    const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
    let jit = 0;
    for (let i = 1; i < ok.length; i++) jit += Math.abs(ok[i] - ok[i - 1]);
    return {
      n: list.length, lost: list.length - ok.length, loss: (list.length - ok.length) / list.length,
      avg: avg == null ? null : Math.round(avg), jitter: ok.length > 1 ? Math.round(jit / (ok.length - 1)) : 0,
      last: list[list.length - 1].ms == null ? null : Math.round(list[list.length - 1].ms), max: ok.length ? Math.round(Math.max(...ok)) : null,
    };
  }
  series(now = Date.now()) { return this.samples.filter((s) => now - s.at <= this.windowMs).map((s) => ({ t: s.at, ms: s.ms })); }
}

// Problema na conexão nos últimos 30 s: perda de 10% ou mais, ou ping alto (acima de 120 ms e do dobro do normal).
function trouble(inet, base = null) {
  if (!inet || inet.n < 10) return null;
  if (inet.loss >= 0.1) return 'loss';
  if (inet.avg != null && inet.avg >= 120 && (base == null || inet.avg >= base * 2)) return 'ping';
  if (inet.jitter >= 40) return 'jitter';
  return null;
}

// De onde vem o problema: o roteador (rede de casa) ou depois dele (internet).
function diagnose(inet, gw) {
  if (!inet) return { level: 'none', text: '' };
  const homeBad = gw && gw.n >= 5 && (gw.loss >= 0.05 || (gw.avg != null && gw.avg >= 30));
  const inetBad = inet.loss >= 0.03 || (inet.avg != null && inet.avg >= 100) || inet.jitter >= 30;
  if (homeBad) return { level: 'bad', where: 'home', text: `A falha está na sua rede de casa (até o roteador${gw.avg != null ? `: ${gw.avg} ms` : ''}${gw.loss ? `, ${Math.round(gw.loss * 100)}% de perda` : ''}). No Wi-Fi, chegue perto do roteador ou use cabo, e feche downloads.` };
  if (inetBad) return { level: 'warn', where: 'internet', text: 'A sua rede de casa está boa; a instabilidade vem da internet (provedor) ou do caminho até o servidor. Feche downloads e streams; se continuar, reinicie o modem.' };
  return { level: 'ok', text: inet.avg != null && inet.avg <= 40 ? 'Conexão boa para jogar.' : 'Conexão estável.' };
}

const hostOk = (h) => /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(String(h || '')) && !String(h).startsWith('-');

module.exports = { parsePingLine, PingStats, trouble, diagnose, hostOk };
