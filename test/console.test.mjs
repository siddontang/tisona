import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createConsoleServer, loadConsoleConfig } from '../console.mjs';
import { createApp } from '../server.mjs';
import { MemoryStore } from './support/memory-store.mjs';
import { buildConsole } from '../scripts/build-console.mjs';

async function fixture(t, { mode = 'development' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tisona-console-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, value] of Object.entries({ 'index.html': '<h1>Web Console fixture</h1>', 'app.js': 'export const frontend = true;', 'private.key': 'secret fixture' })) await writeFile(join(root, name), value);
  const config = { mode, bind: '127.0.0.1', project: 'starter', projectName: 'Fixture',
    publicUrl: 'http://127.0.0.1', adminKey: 'admin-fixture', clientKey: 'client-fixture', workerKey: 'worker-fixture',
    privateKey: generateKeyPairSync('ed25519').privateKey };
  const backend = createApp(config, {}, { store: new MemoryStore(config) });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); config.publicUrl = `http://127.0.0.1:${backend.address().port}`;
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const frontendConfig = { apiUrl: config.publicUrl, consoleUrl: 'http://127.0.0.1', bind: '127.0.0.1', mode, webRoot: root };
  const frontend = await createConsoleServer(frontendConfig);
  frontend.listen(0, '127.0.0.1'); await once(frontend, 'listening');
  frontendConfig.consoleUrl = config.consoleUrl = `http://127.0.0.1:${frontend.address().port}`;
  t.after(() => { frontend.closeAllConnections(); frontend.close(); });
  return { frontend, backend, config, frontendConfig, url: config.consoleUrl };
}

test('independent frontend serves public assets and forwards authenticated API/session requests to the backend', async t => {
  const h = await fixture(t);
  const page = await fetch(h.url); assert.equal(page.status, 200); assert.match(await page.text(), /Web Console fixture/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal((await fetch(h.url + '/private.key')).status, 404);
  assert.equal((await fetch(h.url + '/poll/group/pid')).status, 404);
  const bookmark = await fetch(h.url + '/console/executions/saved-run', { redirect: 'manual' });
  assert.equal(bookmark.status, 302); assert.equal(bookmark.headers.get('location'), '/#executions/saved-run');
  const backendBookmark = await fetch(h.config.publicUrl + '/console/executions/saved-run', { headers: { Authorization: 'Bearer client-fixture' }, redirect: 'manual' });
  assert.equal(backendBookmark.headers.get('location'), h.url + '/#executions/saved-run');
  const backendPage = await fetch(h.config.publicUrl, { headers: { Authorization: 'Bearer client-fixture' } });
  assert.doesNotMatch(await backendPage.text(), /Web Console fixture|<!DOCTYPE|<html/i);
  assert.equal((await fetch(h.url + '/v1/project')).status, 401);
  assert.deepEqual(await (await fetch(h.url + '/session')).json(), { testLoginEnabled: true });
  const login = await fetch(h.url + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.url }, body: '{"test":true}' });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const project = await fetch(h.url + '/v1/project', { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(project.status, 200); const data = await project.json(); assert.equal(data.endpoint, h.config.publicUrl); assert.equal(data.consoleUrl, h.url + '/#executions');
  const direct = await fetch(h.config.publicUrl + '/v1/project', { headers: { Authorization: 'Bearer client-fixture' } }); assert.equal(direct.status, 200);
  const logout = await fetch(h.url + '/session', { method: 'DELETE', headers: { Cookie: cookie.split(';')[0], Origin: h.url } }); assert.equal(logout.status, 200);
  assert.equal((await fetch(h.url + '/v1/project', { headers: { Cookie: cookie.split(';')[0] } })).status, 401);
});

test('frontend refuses foreign origins/forged hosts and does not turn a loopback proxy into public test login', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(h.url + '/session', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const forged = (method, body) => new Promise((done, reject) => {
    const req = http.request(h.url + '/session', { method, headers: { Host: 'attacker.example', 'Content-Type': 'application/json' } }, res => {
      let raw = ''; res.on('data', c => raw += c); res.on('end', () => done({ status: res.statusCode, body: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(body);
  });
  assert.deepEqual((await forged('GET')).body, { testLoginEnabled: false });
  assert.equal((await forged('POST', '{"test":true}')).status, 403);
  h.frontendConfig.bind = '0.0.0.0';
  assert.deepEqual(await (await fetch(h.url + '/session')).json(), { testLoginEnabled: false });
  assert.equal((await fetch(h.url + '/session', { method: 'POST', body: '{"test":true}' })).status, 403);
});

test('production frontend keeps test login disabled and returns a bounded service error during backend outage', async t => {
  const h = await fixture(t, { mode: 'production' });
  assert.deepEqual(await (await fetch(h.url + '/session')).json(), { testLoginEnabled: false });
  assert.equal((await fetch(h.url + '/session', { method: 'POST', body: '{"test":true}' })).status, 403);
  const login = await fetch(h.url + '/session', { method: 'POST', body: JSON.stringify({ key: 'admin-fixture' }) }); assert.equal(login.status, 200);
  h.backend.closeAllConnections(); await new Promise(done => h.backend.close(done));
  assert.equal((await fetch(h.url)).status, 200);
  const unavailable = await fetch(h.url + '/v1/project'); assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'Backend temporarily unavailable. Retry in a moment.' });
});

test('generic Console build contains only public files and the frontend requires no database/signing configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tisona-assets-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'web'), output = join(root, 'dist'); await mkdir(source);
  for (const name of ['index.html', 'app.js', 'theme.css', '.secret.js', 'runtime.json', 'secret.pem']) await writeFile(join(source, name), 'fixture');
  assert.equal((await buildConsole({ source, output })).assets, 3);
  assert.deepEqual((await readdir(output)).sort(), ['app.js', 'index.html', 'theme.css']);
  const config = loadConsoleConfig({}); assert.equal(config.apiUrl, 'http://127.0.0.1:8788'); assert.equal(config.consoleUrl, 'http://127.0.0.1:8787');
  for (const value of ['https://user:password@api.example', 'http://api.example/path', 'http://api.example?secret=x']) assert.throws(() => loadConsoleConfig({ TISONA_API_URL: value }));
  assert.throws(() => loadConsoleConfig({ TISONA_API_URL: config.consoleUrl }), /separate/);
  assert.throws(() => loadConsoleConfig({ NODE_ENV: 'production' }), /HTTPS/);
  assert.equal(await readFile(join(output, 'app.js'), 'utf8'), 'fixture');
});
