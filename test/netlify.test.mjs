import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { apiOrigin, buildConsole } from '../scripts/build-console.mjs';
import { createApp } from '../server.mjs';
import { MemoryStore } from './support/memory-store.mjs';

test('Netlify packaging requires an external HTTPS backend and never bundles private state', async t => {
  for (const value of [undefined, 'http://api.example', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://user:password@api.example', 'https://api.example/path', 'https://api.example?token=x', 'https://api.example#x', 'https://api.example\n/v1']) assert.throws(() => apiOrigin(value));
  assert.throws(() => apiOrigin('https://console.example', 'https://console.example'), /must differ/);
  const path = await mkdtemp(join(tmpdir(), 'tisona-netlify-')); t.after(() => rm(path, { recursive: true, force: true }));
  const source = join(path, 'web'), output = join(path, 'publish'); await mkdir(source);
  for (const name of ['index.html', 'app.js', 'theme.css', '.env', 'runtime.json', 'secret.pem', 'WALKTHROUGHS.md']) await writeFile(join(source, name), 'fixture');
  const result = await buildConsole({ origin: 'https://api.example/', source, output }); assert.equal(result.assets, 3);
  assert.deepEqual((await readdir(output)).sort(), ['_headers', '_redirects', 'app.js', 'index.html', 'theme.css']);
  const redirects = await readFile(join(output, '_redirects'), 'utf8');
  assert.match(redirects, /^\/session https:\/\/api.example\/session 200!/m);
  assert.match(redirects, /^\/v1\/\* https:\/\/api.example\/v1\/:splat 200!/m);
  assert.doesNotMatch(redirects, /poll|metrics|^\/\s|localhost/m);
  assert.match(await readFile(join(output, '_headers'), 'utf8'), /connect-src 'self'/);
});

test('split Console allows its exact origin, keeps worker URLs on the gateway and refuses other origins', async t => {
  const config = { project: 'starter', projectName: 'Fixture', adminKey: 'admin-fixture', clientKey: 'client-fixture', workerKey: 'worker-fixture',
    mode: 'production', bind: '127.0.0.1', publicUrl: 'https://api.example', consoleUrl: 'https://console.example', zero: {},
    privateKey: generateKeyPairSync('ed25519').privateKey };
  const app = createApp(config, {}, { store: new MemoryStore(config) }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => { app.closeAllConnections(); app.close(); });
  const endpoint = `http://127.0.0.1:${app.address().port}`;
  for (const origin of ['https://api.example', 'https://console.example']) {
    const res = await fetch(endpoint + '/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: config.adminKey }) });
    assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800; Secure/);
  }
  for (const origin of ['https://attacker.example', 'https://console.example.attacker.test', 'http://console.example', 'null']) {
    assert.equal((await fetch(endpoint + '/session', { method: 'POST', headers: { Origin: origin }, body: '{}' })).status, 403);
  }
  const project = await fetch(endpoint + '/v1/project', { headers: { Origin: config.consoleUrl, Authorization: `Bearer ${config.clientKey}` } });
  assert.equal(project.status, 200); const data = await project.json(); assert.equal(data.endpoint, config.publicUrl); assert.equal(data.consoleUrl, config.consoleUrl + '/#executions');
  assert.equal((await (await fetch(endpoint + '/session')).json()).testLoginEnabled, false);
});
