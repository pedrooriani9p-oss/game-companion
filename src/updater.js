// Versão nova: compara a versão do app com a última publicada no GitHub e, no app portátil do Windows,
// baixa o .exe novo para trocar quando o app fechar (ou reiniciar).
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

function newer(latest, current) {
  const a = String(latest).replace(/^v/, '').split('.').map(Number), b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return false;
}

// O .exe da versão (GameCompanion-1.2.0.exe) dentro da resposta do GitHub.
function pickAsset(release) {
  const list = (release && release.assets) || [];
  const a = list.find((x) => /^GameCompanion-[\d.]+\.exe$/i.test(x.name)) || list.find((x) => /\.exe$/i.test(x.name));
  if (!a || !a.browser_download_url) return null;
  const digest = /^sha256:[0-9a-f]{64}$/i.test(a.digest || '') ? a.digest.slice(7).toLowerCase() : null;
  return { name: a.name, size: Number(a.size) || 0, url: a.browser_download_url, sha256: digest };
}

// repo no formato "dono/nome" com releases no GitHub. Retorna { version, url, asset } ou null.
function checkLatest(repo, current) {
  if (!repo) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.get({ host: 'api.github.com', path: `/repos/${repo}/releases/latest`, headers: { 'User-Agent': 'game-companion' }, timeout: 8000 }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const r = JSON.parse(body);
          resolve(r.tag_name && newer(r.tag_name, current) ? { version: r.tag_name.replace(/^v/, ''), url: r.html_url, asset: pickAsset(r) } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Baixa um arquivo seguindo os redirecionamentos do GitHub. onProgress(recebido, total).
function download(url, file, { onProgress = () => {}, redirects = 5, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'game-companion', Accept: 'application/octet-stream' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return download(new URL(res.headers.location, url).toString(), file, { onProgress, redirects: redirects - 1, timeout }).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const total = Number(res.headers['content-length']) || 0, hash = crypto.createHash('sha256'), out = fs.createWriteStream(file);
      let got = 0;
      // Se a conexão cair no meio, fecha o arquivo (no Windows, arquivo aberto não pode ser apagado).
      const fail = (e) => { out.destroy(); reject(e); };
      res.on('data', (c) => { got += c.length; hash.update(c); onProgress(got, total); });
      res.on('error', fail); res.on('aborted', () => fail(new Error('aborted'))); out.on('error', fail);
      out.on('finish', () => (total && got !== total ? reject(new Error('incompleto')) : resolve({ size: got, sha256: hash.digest('hex') })));
      res.pipe(out);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Confere o arquivo baixado com o que o GitHub diz (tamanho e, quando houver, o SHA-256).
function verify(got, asset) {
  if (!got || !asset) return false;
  if (asset.size && got.size !== asset.size) return false;
  if (asset.sha256 && got.sha256 !== asset.sha256) return false;
  return got.size > 1024 * 1024;
}

module.exports = { newer, checkLatest, pickAsset, download, verify };
