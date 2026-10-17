import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export function apiOrigin(value, siteOrigin) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set TISONA_API_ORIGIN to the external gateway HTTPS origin before building the Console.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost') || /[\r\n]/.test(value)) throw new Error('TISONA_API_ORIGIN must be a public HTTPS origin without a path, credentials, query or fragment.');
  if (siteOrigin && url.origin === new URL(siteOrigin).origin) throw new Error('The API origin must differ from the Netlify site origin.');
  return url.origin;
}
export async function buildConsole({ origin, siteOrigin, output = resolve(root, '.netlify-dist'), source = resolve(root, 'web') }) {
  const api = apiOrigin(origin, siteOrigin);
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  const assets = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isFile() && /\.(js|css|html)$/.test(entry.name));
  for (const entry of assets) await copyFile(resolve(source, entry.name), resolve(output, entry.name));
  // Only the browser's short REST/session requests pass through Netlify.
  // SDK protocol POST / and SSE /poll/* always use the gateway directly.
  await writeFile(resolve(output, '_redirects'), `/session ${api}/session 200!\n/v1/* ${api}/v1/:splat 200!\n`);
  await writeFile(resolve(output, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cache-Control: no-store
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
`);
  return { assets: assets.length, output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildConsole({ origin: process.env.TISONA_API_ORIGIN, siteOrigin: process.env.URL });
  console.log(`Built ${result.assets} public Console assets. Gateway and workers must run separately.`);
}
