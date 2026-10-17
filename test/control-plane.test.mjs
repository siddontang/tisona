import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { createApp, canonical, executionId } from '../server.mjs';
import { encode, digest } from '../config.mjs';
import { MemoryStore } from './support/memory-store.mjs';

const descriptor = version => ({ name: 'research', version, group: `research-v${version}`, description: 'Versioned function', inputSchema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } }, additionalProperties: false } });
async function harness(t) {
  const promises = new Map(), operations = [];
  let unavailable = false, getBarrier;
  const backend = http.createServer(async (req, res) => {
    if (req.url.startsWith('/poll/')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
    if (req.url === '/ready') { res.writeHead(200); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); operations.push(input);
    let status = 200, data;
    if (input.kind === 'promise.get') {
      const found = promises.get(input.data.id);
      if (getBarrier) await getBarrier();
      if (unavailable) { status = 503; data = 'Unavailable'; }
      else if (!found) { status = 404; data = 'Not found'; }
      else data = { promise: found };
    } else if (input.kind === 'promise.create') {
      if (!promises.has(input.data.id)) promises.set(input.data.id, { ...input.data, state: 'pending', createdAt: Date.now() });
      data = { promise: promises.get(input.data.id) };
    } else data = {};
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ head: { status }, data }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const config = { project: 'test', projectName: 'Test', adminKey: 'admin', clientKey: 'client', workerKey: 'worker', privateKey: generateKeyPairSync('ed25519').privateKey,
    engineUrl: `http://127.0.0.1:${backend.address().port}`, publicUrl: 'http://127.0.0.1' };
  const store = new MemoryStore(config), apps = [];
  async function gateway(sharedStore = store) {
    const local = { ...config }, app = createApp(local, {}, { store: sharedStore, streamAuthIntervalMs: 20 });
    app.listen(0, '127.0.0.1'); await once(app, 'listening'); apps.push(app);
    local.publicUrl = `http://127.0.0.1:${app.address().port}`;
    return async (path, { key = 'client', body, method = 'GET', cookie } = {}) => {
      const response = await fetch(local.publicUrl + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': 'same-request' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
      if (path.startsWith('/poll/')) return response;
      const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
      return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
  }
  t.after(() => { for (const app of apps) { app.closeAllConnections(); app.close(); } backend.closeAllConnections(); backend.close(); });
  return { store, config, promises, operations, gateway, api: await gateway(), setUnavailable: value => unavailable = value, setGetBarrier: value => getBarrier = value };
}

test('accepted requests survive incompatible function upgrades, including explicit version pins and legacy records', async t => {
  const h = await harness(t), start = body => h.api('/v1/executions', { method: 'POST', body });
  await h.store.registerFunction(descriptor(1));
  const input = { function: 'research', input: { topic: 'Original' } };
  const first = await start(input); assert.equal(first.status, 202); assert.equal(first.data.version, 1);
  const v2 = descriptor(2); v2.inputSchema = { type: 'object', required: ['newField'], properties: { newField: { type: 'boolean' } } };
  await h.store.registerFunction(v2);
  const retried = await start(input); assert.equal(retried.status, 202); assert.equal(retried.data.id, first.data.id); assert.equal(retried.data.version, 1);
  assert.equal((await start({ ...input, input: { topic: 'Different' } })).status, 409);
  assert.equal((await start({ ...input, version: 2 })).status, 409);
  assert.equal(h.operations.filter(op => op.kind === 'promise.create').length, 1);
  // Old executions have only the original version-dependent request hash.
  const saved = h.promises.get(first.data.id); delete saved.tags['cloud:requestIdentity'];
  saved.tags['cloud:requestHash'] = digest(JSON.stringify(canonical({ ...input, version: 1, timeoutMs: 3600000 })));
  assert.equal((await start(input)).status, 202);
  h.promises.clear(); const pinned = await start({ ...input, version: 1 }); assert.equal(pinned.status, 202); assert.equal(pinned.data.version, 1);
});

test('simultaneous starts spanning a version rollout agree on the winning execution version', async t => {
  const h = await harness(t); await h.store.registerFunction(descriptor(1)); await h.store.registerFunction(descriptor(2));
  let gets = 0, release;
  const barrier = new Promise(resolve => release = resolve);
  h.setGetBarrier(async () => { if (++gets === 2) release(); await barrier; });
  let resolutions = 0;
  h.store.getFunction = async () => descriptor(++resolutions === 1 ? 1 : 2);
  const input = { function: 'research', input: { topic: 'Same' } };
  const responses = await Promise.all([1, 2].map(() => h.api('/v1/executions', { method: 'POST', body: input })));
  responses.forEach(response => assert.equal(response.status, 202));
  assert.equal(responses[0].data.version, responses[1].data.version); assert.equal(h.promises.size, 1);
});

test('a failed idempotency lookup never creates a second execution', async t => {
  const h = await harness(t); h.setUnavailable(true);
  const result = await h.api('/v1/executions', { method: 'POST', body: { function: 'research', input: {} } });
  assert.equal(result.status, 503); assert.equal(h.operations.filter(op => op.kind === 'promise.create').length, 0);
});

test('function versions are immutable, retain old schemas, and route to distinct worker groups', async t => {
  const { api } = await harness(t);
  const register = body => api('/v1/functions', { key: 'worker', method: 'POST', body });
  assert.equal((await register(descriptor(1))).status, 200);
  assert.equal((await register(descriptor(1))).status, 200);
  assert.equal((await register({ ...descriptor(1), description: 'changed' })).status, 409);
  assert.equal((await register({ ...descriptor(2), group: descriptor(1).group })).status, 409);
  assert.equal((await register(descriptor(2))).status, 200);
  assert.equal((await api('/v1/functions')).data.items[0].version, 2);
  assert.deepEqual((await api('/v1/functions?versions=all')).data.items.map(f => f.version), [2, 1]);
});

test('shared session state works across gateways, logout and key revocation invalidate it everywhere', async t => {
  const h = await harness(t), other = await h.gateway();
  const newAdmin = await h.api('/v1/api-keys', { key: 'admin', method: 'POST', body: { role: 'admin', name: 'Second admin' } });
  const login = await h.api('/session', { key: null, method: 'POST', body: { key: newAdmin.data.token } });
  assert.equal((await other('/v1/project', { key: null, cookie: login.cookie })).status, 200);
  assert.equal((await other('/v1/api-keys/' + newAdmin.data.id, { key: 'admin', method: 'DELETE' })).status, 200);
  assert.equal((await h.api('/v1/project', { key: null, cookie: login.cookie })).status, 401);
  assert.equal((await h.api('/v1/project', { key: newAdmin.data.token })).status, 401);
  const adminLogin = await h.api('/session', { key: null, method: 'POST', body: { key: 'admin' } });
  await other('/session', { key: null, cookie: adminLogin.cookie, method: 'DELETE' });
  assert.equal((await h.api('/v1/project', { key: null, cookie: adminLogin.cookie })).status, 401);
  const initial = (await h.api('/v1/api-keys', { key: 'admin' })).data.items.find(key => key.name === 'admin');
  assert.equal((await h.api('/v1/api-keys/' + initial.id, { key: 'admin', method: 'DELETE' })).status, 409);
});

test('keys are revealed once, expire, and metrics credentials cannot operate executions', async t => {
  const h = await harness(t);
  const created = await h.api('/v1/api-keys', { key: 'admin', method: 'POST', body: { role: 'metrics', name: 'Scraper', expiresAt: Date.now() + 60000 } });
  assert.equal(created.status, 201); assert.ok(created.data.token);
  const listing = await h.api('/v1/api-keys', { key: 'admin' });
  assert.equal(listing.data.items.find(key => key.id === created.data.id).token, undefined);
  assert.doesNotMatch(JSON.stringify(listing.data), /tokenHash/);
  assert.equal((await h.api('/v1/executions', { key: created.data.token })).status, 403);
  assert.equal((await h.api('/metrics', { key: created.data.token })).status, 200);
  assert.equal((await h.api('/metrics', { key: 'client' })).status, 403);
  assert.equal((await h.api('/v1/credentials', { key: 'admin', method: 'POST' })).status, 410);
  h.store.state.keys.get(created.data.id).expiresAt = Date.now() - 1;
  assert.equal((await h.api('/metrics', { key: created.data.token })).status, 401);
});

test('worker presence verifies function groups, credential ownership, TTL and credential revocation', async t => {
  const h = await harness(t); await h.store.registerFunction(descriptor(1));
  const body = { group: 'research-v1', functions: [{ name: 'research', version: 1 }] };
  assert.equal((await h.api('/v1/workers/worker-a/heartbeat', { key: 'worker', method: 'POST', body })).status, 200);
  assert.equal((await h.api('/v1/workers')).data.items[0].online, true);
  assert.equal((await h.api('/v1/workers/worker-a/heartbeat', { key: 'worker', method: 'POST', body: { ...body, group: 'wrong' } })).status, 409);
  const other = await h.api('/v1/api-keys', { key: 'admin', method: 'POST', body: { role: 'worker', name: 'Other worker' } });
  assert.equal((await h.api('/v1/workers/worker-a/heartbeat', { key: other.data.token, method: 'POST', body })).status, 403);
  await h.api('/v1/workers/worker-a/offline', { key: 'worker', method: 'POST' });
  assert.equal((await h.api('/v1/workers')).data.items[0].online, false);
  await h.api('/v1/workers/worker-b/heartbeat', { key: other.data.token, method: 'POST', body });
  await h.api('/v1/api-keys/' + other.data.id, { key: 'admin', method: 'DELETE' });
  assert.equal((await h.api('/v1/workers')).data.items.find(w => w.id === 'worker-b').online, false);
});

test('revoking a worker key on another gateway closes its existing SSE stream', async t => {
  const h = await harness(t), other = await h.gateway();
  const key = await h.api('/v1/api-keys', { key: 'admin', method: 'POST', body: { role: 'worker', name: 'Stream owner' } });
  const stream = await h.api('/poll/default/subscriber', { key: key.data.token });
  assert.equal(stream.status, 200); const reader = stream.body.getReader();
  const closed = reader.read().then(result => result.done).catch(() => true);
  await other('/v1/api-keys/' + key.data.id, { key: 'admin', method: 'DELETE' });
  assert.equal(await closed, true);
});
