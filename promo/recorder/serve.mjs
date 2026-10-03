// Serves the game (repo root) for recording, without touching the file players load.
// index.html is rewritten in memory only:
//  - a hook exposing a few module-scope internals is spliced in before the module's final `requestAnimationFrame(loop);`
//  - Vercel analytics is dropped and /api/* is answered locally, so recordings never reach production
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Everything the recorder reads from the game. Formulas come from the game itself so promo balance never drifts.
const HOOK = `window.__g = { sfx, camera, tableHP, tableReward, dmgAt, get tables() { return tables; }, get activeRoom() { return activeRoom; }, get cleared() { return cleared; } };\n`;
const ANCHOR = '\nrequestAnimationFrame(loop);\n</script>';

export function patchedIndex() {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const at = src.lastIndexOf(ANCHOR);
  if (at < 0) throw new Error(`recorder hook anchor not found in index.html (expected the module to end with${JSON.stringify(ANCHOR)})`);
  return src.slice(0, at + 1) + HOOK + src.slice(at + 1).replace('<script defer src="/_vercel/insights/script.js"></script>', '');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

export function serve(port = 0) {
  const index = patchedIndex();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_vercel/')) { res.writeHead(204); return res.end(); }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(index); }
    const file = path.join(ROOT, path.normalize(url.pathname));
    if (!file.startsWith(ROOT + path.sep) || file.includes(`${path.sep}promo${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/index.html` })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(+process.argv[2] || 8765);
  console.log(`serving the game with the recorder hook at ${url}`);
}
