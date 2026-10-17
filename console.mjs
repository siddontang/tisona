import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const web = fileURLToPath(new URL('./web/', import.meta.url));
const loopback = host => ['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);
export function loadConsoleConfig(env = process.env) {
  const api = new URL(env.TISONA_API_URL ?? 'http://127.0.0.1:8788');
  const consoleUrl = new URL(env.TISONA_CONSOLE_URL ?? 'http://127.0.0.1:8787');
  for (const url of [api, consoleUrl]) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Console and API URLs must be HTTP(S) origins without credentials');
  }
  if (api.origin === consoleUrl.origin) throw new Error('Console and API must use separate origins');
  const port = Number(env.TISONA_CONSOLE_PORT ?? (consoleUrl.port || (consoleUrl.protocol === 'https:' ? 443 : 80)));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Console port');
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';
  if (mode === 'production' && (api.protocol !== 'https:' || consoleUrl.protocol !== 'https:')) throw new Error('Production Console and API URLs require HTTPS');
  return { apiUrl: api.origin, consoleUrl: consoleUrl.origin, port, bind: env.TISONA_CONSOLE_BIND ?? '127.0.0.1', mode,
    webRoot: resolve(env.TISONA_CONSOLE_DIR ?? web) };
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
async function requestBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) { const error = new Error('Request exceeds 1 MiB'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}
export async function createConsoleServer(config, { fetchImpl = fetch } = {}) {
  const assets = new Set((await readdir(config.webRoot, { withFileTypes: true })).filter(e => e.isFile() && !e.name.startsWith('.') && /\.(html|css|js)$/.test(e.name)).map(e => '/' + e.name));
  const requestHeaders = ['accept', 'authorization', 'content-type', 'cookie', 'origin', 'sec-fetch-site', 'idempotency-key'];
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const url = new URL(req.url, config.consoleUrl);
      if (url.pathname === '/health/live' && req.method === 'GET') return json(res, 200, { live: true, service: 'console' });
      if (req.headers.origin && req.headers.origin !== config.consoleUrl) return json(res, 403, { error: 'Cross-origin request refused' });
      if (url.pathname === '/session' || url.pathname.startsWith('/v1/') || url.pathname === '/health/ready') {
        if (!['GET', 'POST', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
        const localTest = config.mode === 'development' && loopback(config.bind) && loopback(new URL(config.consoleUrl).hostname)
          && loopback(req.socket.remoteAddress) && req.headers.host === new URL(config.consoleUrl).host;
        const raw = ['GET', 'HEAD'].includes(req.method) ? undefined : await requestBody(req);
        if (url.pathname === '/session' && req.method === 'POST' && !localTest) {
          let input; try { input = JSON.parse(raw?.toString() || '{}'); } catch { /* Backend validates malformed JSON. */ }
          if (input?.test === true) return json(res, 403, { error: 'Test sign-in is unavailable' });
        }
        const headers = Object.fromEntries(requestHeaders.filter(name => typeof req.headers[name] === 'string').map(name => [name, req.headers[name]]));
        const controller = new AbortController();
        const abort = () => controller.abort(); req.once('aborted', abort); res.once('close', abort);
        const timeout = setTimeout(abort, 25000);
        try {
          const upstream = await fetchImpl(config.apiUrl + url.pathname + url.search, { method: req.method, headers, body: raw, redirect: 'manual', signal: controller.signal });
          if (url.pathname === '/session' && req.method === 'GET' && upstream.ok) {
            const data = await upstream.json(); return json(res, upstream.status, { ...data, testLoginEnabled: Boolean(data.testLoginEnabled && localTest) });
          }
          const outgoing = {};
          for (const name of ['content-type', 'cache-control', 'location', 'retry-after', 'x-request-id']) if (upstream.headers.has(name)) outgoing[name] = upstream.headers.get(name);
          const cookies = upstream.headers.getSetCookie(); if (cookies.length) outgoing['set-cookie'] = cookies;
          res.writeHead(upstream.status, outgoing);
          if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res); else res.end();
        } finally { clearTimeout(timeout); req.off('aborted', abort); res.off('close', abort); }
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      if (url.pathname === '/console' || /^\/console\/(executions(?:\/[^/]+)?|settings)\/?$/.test(url.pathname)) {
        const id = url.pathname.match(/^\/console\/executions\/([^/]+)\/?$/)?.[1];
        const target = id ? `/#executions/${encodeURIComponent(decodeURIComponent(id))}` : url.pathname.endsWith('/settings') ? '/#access' : '/#executions';
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' }); return res.end();
      }
      const file = url.pathname === '/' ? '/index.html' : url.pathname;
      if (!assets.has(file)) return json(res, 404, { error: 'Not found' });
      const content = await readFile(resolve(config.webRoot, file.slice(1)));
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error.status ?? 503, { error: error.status === 413 ? error.message : 'Backend temporarily unavailable. Retry in a moment.' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConsoleConfig();
  const server = await createConsoleServer(config);
  server.listen(config.port, config.bind, () => console.log(`Web Console ready: ${config.consoleUrl}; API: ${config.apiUrl}`));
  const stop = () => { server.closeAllConnections(); server.close(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
