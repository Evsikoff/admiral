// The game and its online club from one process: the page (admiral-3d.html, built by tools/build.py),
// its assets, and a WebSocket at /ws for the lobby, the tables and the games.
//   PORT=8080 node server/server.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import { Lobby } from './lobby.js';
import { createPaymentsHandler } from './payments.js';
import { createUsersHandler } from './users.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, 'secrets.txt'), quiet: true });
const PAGE = path.join(ROOT, 'admiral-3d.html');
const ASSETS = path.join(ROOT, 'assets');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const appId = process.env.VK_APP_ID;
const appSecret = process.env.VK_APP_SECRET;
const databasePath = process.env.VK_PAYMENTS_DB_PATH;
let handlePayments;
if (appId && appSecret && databasePath) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(ASSETS, 'ship-sets.json'), 'utf8'));
    handlePayments = await createPaymentsHandler({
      appId, appSecret, databasePath, catalog, publicOrigin: process.env.VK_PUBLIC_ORIGIN,
    });
  } catch (error) {
    console.error('VK payments are disabled:', error.message);
  }
}
handlePayments ??= await createPaymentsHandler();
const handleUsers = createUsersHandler({
  supabaseUrl: process.env.SUPABASE_URL,
  secretKey: process.env.SUPABASE_SECRET_KEY,
  appId, appSecret,
});

// only what the page loads is served: nothing else in the repository (tools, keys, sources) leaves the server
const TYPES = {
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json',
};

// the page is one big file; it is read and compressed once (again when the file changes, for local work)
let page = null;
function loadPage() {
  const stat = fs.statSync(PAGE, { throwIfNoEntry: false });
  if (!stat) return null;
  if (page && page.mtime === stat.mtimeMs) return page;
  const raw = fs.readFileSync(PAGE);
  page = {
    mtime: stat.mtimeMs, raw,
    gzip: zlib.gzipSync(raw, { level: 6 }),
    br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }),
    etag: `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
  };
  return page;
}

function sendPage(req, res) {
  const p = loadPage();
  if (!p) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Game is not built: run python tools/build.py\n'); return; }
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', etag: p.etag, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === p.etag) { res.writeHead(304, headers); res.end(); return; }
  const accept = String(req.headers['accept-encoding'] || '');
  let body = p.raw;
  if (/\bbr\b/.test(accept)) { body = p.br; headers['content-encoding'] = 'br'; }
  else if (/\bgzip\b/.test(accept)) { body = p.gzip; headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendAsset(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.slice('/assets/'.length)); } catch { return notFound(res); }
  const file = path.resolve(ASSETS, rel);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type || !file.startsWith(ASSETS + path.sep)) return notFound(res);
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const headers = { 'content-type': type, 'cache-control': 'public, max-age=86400', 'accept-ranges': 'bytes' };
    // films and music are fetched in ranges (Safari will not play a video without them)
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    let start = 0, end = stat.size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
      else start = Math.max(0, stat.size - Number(range[2]));
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return;
      }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}
function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found\n'); }

// the time for a decision in a game, in seconds (TURN_SECONDS, at least 15; 60 by default)
const lobby = new Lobby({ turnMs: Math.max(15, Number(process.env.TURN_SECONDS) || 60) * 1000 });
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath === '/api/users/register') return handleUsers(req, res);
  if (urlPath === '/vk/payments' || urlPath === '/vk/purchases') return handlePayments(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/admiral-3d.html') return sendPage(req, res);
  if (urlPath.startsWith('/assets/')) return sendAsset(req, res, urlPath);
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ...lobby.stats() }));
    return;
  }
  notFound(res);
});

// ---- the club: one WebSocket per browser tab
const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  const conn = { send: (msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } };
  let player = null;
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    try {
      if (msg?.t === 'hello') { if (player) lobby.disconnect(player, conn); player = lobby.hello(conn, msg); }
      else if (player) lobby.message(player, msg);
    } catch (err) { console.error('message failed', msg?.t, err); }
  });
  ws.on('close', () => { if (player) lobby.disconnect(player, conn); });
  ws.on('error', () => {});
});
// a connection that stops answering is closed, so its player is seen to be gone (proxies drop quiet sockets anyway)
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 25000);

server.listen(PORT, HOST, () => {
  console.log(`Admiral: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/  (page ${loadPage() ? 'ready' : 'NOT BUILT — run python tools/build.py'})`);
});
const stop = () => {
  clearInterval(heartbeat);
  wss.close();
  server.close(() => { handlePayments.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
