// Ultra Proxy - 最強 web proxy
// URL書き換え型フォワードプロキシ。/p/<url> でプロキシ経由表示。
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { request } from 'undici';
import { WebSocketServer, WebSocket } from 'ws';
import { rewriteHtml, rewriteCss, encodeProxyUrl, decodeProxyUrl, PREFIX } from './rewrite.js';
import { CLIENT_SCRIPT } from './client.js';
import { HOME_PAGE } from './home.js';

const PORT = process.env.PORT || 8080;
const __dir = path.dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = path.join(__dir, 'assets');

// PWA マニフェスト
const MANIFEST = JSON.stringify({
  name: 'カピバラproxy',
  short_name: 'カピバラproxy',
  description: 'のんびり最強の web proxy',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#0f172a',
  icons: [
    { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/assets/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

const MIME = {
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
function serveAsset(res, name) {
  const file = path.join(ASSET_DIR, path.basename(name));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    });
    res.end(data);
  });
}

// --- 簡易メモリキャッシュ（静的リソース高速化） -----------------------
const CACHE = new Map();
const CACHE_MAX = 200;
const CACHE_TTL = 60_000; // 60s
function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.t > CACHE_TTL) { CACHE.delete(key); return null; }
  // LRU: 再挿入
  CACHE.delete(key); CACHE.set(key, e);
  return e;
}
function cacheSet(key, val) {
  if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.next().value);
  CACHE.set(key, { ...val, t: Date.now() });
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-encoding',
  'content-length', 'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'set-cookie',
]);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decompress(buf, enc) {
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'deflate') return zlib.inflateSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
  } catch { /* fallthrough */ }
  return buf;
}

const server = http.createServer(async (req, res) => {
  const url = req.url;

  // ホーム
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(HOME_PAGE);
  }
  // PWA / アイコン
  if (url === '/manifest.webmanifest' || url === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
    return res.end(MANIFEST);
  }
  if (url === '/favicon.ico') return serveAsset(res, 'favicon.ico');
  if (url === '/apple-touch-icon.png' || url === '/apple-touch-icon-precomposed.png')
    return serveAsset(res, 'apple-touch-icon.png');
  if (url.startsWith('/assets/')) return serveAsset(res, url.slice('/assets/'.length));

  // クライアント傍受スクリプト
  if (url === '/__proxy__/client.js') {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    });
    return res.end(CLIENT_SCRIPT);
  }
  // フォーム送信用リダイレクタ: /go?url=...
  if (url.startsWith('/go?')) {
    const q = new URL(url, 'http://localhost').searchParams.get('url');
    if (q) {
      let target = q.trim();
      if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
      res.writeHead(302, { location: encodeProxyUrl(target) });
      return res.end();
    }
    res.writeHead(400); return res.end('missing url');
  }

  // プロキシ本体
  if (url.startsWith(PREFIX)) {
    return handleProxy(req, res);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found. Use ' + PREFIX + '<url>');
});

async function handleProxy(req, res) {
  // PREFIX 以降を対象URLとして取り出す
  let target = req.url.slice(PREFIX.length);
  if (!target) { res.writeHead(400); return res.end('no target'); }

  // Base64url を復号
  try { target = decodeProxyUrl(target); } catch { res.writeHead(400); return res.end('bad url'); }
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  let targetUrl;
  try { targetUrl = new URL(target); } catch { res.writeHead(400); return res.end('bad url'); }

  const method = req.method || 'GET';
  const cacheKey = method === 'GET' ? targetUrl.href : null;

  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit) {
      res.writeHead(hit.status, hit.headers);
      return res.end(hit.body);
    }
  }

  // ヘッダ転送（hop-by-hop と host を除く）
  const fwdHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk) || lk === 'host' || lk === 'referer' || lk === 'origin' ||
        lk === 'accept-encoding') continue;
    fwdHeaders[k] = v;
  }
  fwdHeaders['host'] = targetUrl.host;
  fwdHeaders['user-agent'] = req.headers['user-agent'] || UA;
  fwdHeaders['accept-encoding'] = 'gzip, deflate, br';

  // リクエストボディ収集（POST等）
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }

  let upstream;
  try {
    upstream = await request(targetUrl.href, {
      method,
      headers: fwdHeaders,
      body,
      maxRedirections: 0,
      bodyTimeout: 30_000,
      headersTimeout: 15_000,
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Upstream error: ' + e.message);
  }

  const status = upstream.statusCode;
  const h = upstream.headers;

  // リダイレクトは Location を書き換えて自前で返す
  if (status >= 300 && status < 400 && h.location) {
    const loc = new URL(h.location, targetUrl.href).href;
    res.writeHead(status, { location: encodeProxyUrl(loc) });
    return res.end();
  }

  const ctype = (h['content-type'] || '').toLowerCase();
  const enc = h['content-encoding'];
  const isHtml = ctype.includes('text/html');
  const isCss = ctype.includes('text/css');
  const rewriteBody = isHtml || isCss;

  // レスポンスヘッダ構築
  const outHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    outHeaders[k] = v;
  }
  // set-cookie はパス制約を外して透過（簡易）
  if (h['set-cookie']) {
    const cookies = Array.isArray(h['set-cookie']) ? h['set-cookie'] : [h['set-cookie']];
    outHeaders['set-cookie'] = cookies.map(c =>
      c.replace(/;\s*domain=[^;]+/ig, '').replace(/;\s*secure/ig, '').replace(/;\s*samesite=[^;]+/ig, ''));
  }
  outHeaders['access-control-allow-origin'] = '*';

  if (rewriteBody) {
    // HTML/CSS はバッファして書き換え
    const chunks = [];
    for await (const c of upstream.body) chunks.push(c);
    let buf = Buffer.concat(chunks);
    buf = decompress(buf, enc);
    let text = buf.toString('utf-8');
    text = isHtml ? rewriteHtml(text, targetUrl.href) : rewriteCss(text, targetUrl.href);
    const outBuf = Buffer.from(text, 'utf-8');
    outHeaders['content-type'] = isHtml ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
    outHeaders['content-length'] = outBuf.length;
    if (cacheKey && isCss) cacheSet(cacheKey, { status, headers: outHeaders, body: outBuf });
    res.writeHead(status, outHeaders);
    return res.end(outBuf);
  }

  // それ以外（画像/JS/フォント等）はそのままストリーム（エンコーディング維持）
  if (enc) outHeaders['content-encoding'] = enc;
  res.writeHead(status, outHeaders);
  Readable.from(upstream.body).pipe(res);
}

// --- WebSocket プロキシ -------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith(PREFIX)) { socket.destroy(); return; }
  let original;
  try { original = decodeProxyUrl(req.url.slice(PREFIX.length)); }
  catch { socket.destroy(); return; }

  let u;
  try { u = new URL(original); } catch { socket.destroy(); return; }
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';

  wss.handleUpgrade(req, socket, head, (client) => {
    const headers = {};
    if (req.headers['cookie']) headers['cookie'] = req.headers['cookie'];
    if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];
    headers['origin'] = u.origin.replace(/^ws/, 'http');

    const upstream = new WebSocket(u.href, {
      headers,
      handshakeTimeout: 15_000,
      rejectUnauthorized: false,
    });

    const queue = [];
    client.on('message', (d, bin) =>
      upstream.readyState === WebSocket.OPEN ? upstream.send(d, { binary: bin }) : queue.push([d, bin]));
    upstream.on('open', () => { for (const [d, b] of queue) upstream.send(d, { binary: b }); queue.length = 0; });
    upstream.on('message', (d, bin) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: bin }); });

    const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    client.on('close', closeBoth); upstream.on('close', closeBoth);
    client.on('error', closeBoth); upstream.on('error', closeBoth);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🦫 カピバラproxy 起動: http://0.0.0.0:${PORT}\n`);
});
