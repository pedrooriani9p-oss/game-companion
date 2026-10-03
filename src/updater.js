// Aviso de versão nova: compara a versão do app com a última versão publicada.
const https = require('https');

function newer(latest, current) {
  const a = String(latest).replace(/^v/, '').split('.').map(Number), b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return false;
}

// repo no formato "dono/nome" com releases no GitHub. Retorna { version, url } ou null.
function checkLatest(repo, current) {
  if (!repo) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.get({ host: 'api.github.com', path: `/repos/${repo}/releases/latest`, headers: { 'User-Agent': 'game-companion' }, timeout: 8000 }, (res) => {
      let body = ''; res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const r = JSON.parse(body);
          resolve(r.tag_name && newer(r.tag_name, current) ? { version: r.tag_name.replace(/^v/, ''), url: r.html_url } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
module.exports = { newer, checkLatest };
