import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { MemoryStore } from './support/memory-store.mjs';
import { createApp, validateInput, validateSchema, canonical, executionId } from '../server.mjs';

test('idempotency keys are project scoped and JSON order does not change request identity', () => {
  assert.notEqual(executionId('a', 'same'), executionId('b', 'same'));
  assert.equal(JSON.stringify(canonical({ a: 1, b: { y: 2, x: 1 } })), JSON.stringify(canonical({ b: { x: 1, y: 2 }, a: 1 })));
  assert.match(executionId('starter', 'any:key'), /^starter-[a-f0-9]{40}$/);
});

test('function schemas reject unsupported constraints and invalid caller inputs', () => {
  const schema = { type: 'object', required: ['topic'], additionalProperties: false, properties: { topic: { type: 'string', minLength: 1, maxLength: 20 }, count: { type: 'integer', maximum: 3 } } };
  validateSchema(schema); validateInput({ topic: 'ok', count: 2 }, schema);
  for (const input of [{}, { topic: '' }, { topic: 'ok', count: 1.2 }, { topic: 'ok', count: 4 }, { topic: 'ok', unexpected: true }]) assert.throws(() => validateInput(input, schema));
  assert.throws(() => validateSchema({ type: 'string', pattern: 'silently ignored' }), /Unsupported/);
});

test('local test sign-in issues a scoped session without exposing a key and preserves production authentication', async t => {
  const config = { mode: 'development', bind: '127.0.0.1', project: 'starter', projectName: 'Test', adminKey: 'administrator', publicUrl: 'http://127.0.0.1' };
  const store = new MemoryStore(config), app = createApp(config, {}, { store });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); config.publicUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => { app.closeAllConnections(); app.close(); });
  const request = (path = '/session', options = {}) => fetch(config.publicUrl + path, options);
  const auto = (headers = {}) => request('/session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ test: true }) });
  assert.deepEqual(await (await request()).json(), { testLoginEnabled: true });
  assert.equal((await request('/v1/project')).status, 401, 'API must still require a credential or session');
  const login = await auto(); assert.equal(login.status, 200); assert.deepEqual(await login.json(), { signedIn: true });
  const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await request('/v1/project', { headers: { cookie: cookie.split(';')[0] } })).status, 200);
  for (const headers of [{ Origin: 'https://foreign.invalid' }, { 'Content-Type': 'text/plain' }]) assert.equal((await auto(headers)).status, 403, Object.keys(headers)[0]);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = http.request(config.publicUrl + '/session', { method: 'POST', headers: { Host: 'foreign.invalid', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ test: true }));
  });
  assert.equal(foreignHost, 403);
  for (const override of [{ mode: 'production', testAutoLogin: true }, { bind: '0.0.0.0' }, { testAutoLogin: false }]) {
    Object.assign(config, { mode: 'development', bind: '127.0.0.1', testAutoLogin: true }, override);
    assert.deepEqual(await (await request()).json(), { testLoginEnabled: false });
    assert.equal((await auto()).status, 403);
  }
  config.testAutoLogin = true;
  const manual = await request('/session', { method: 'POST', body: JSON.stringify({ key: config.adminKey }) });
  assert.equal(manual.status, 200, 'Manual login remains available');
  const admin = await store.authenticate(config.adminKey); admin.revokedAt = Date.now();
  assert.equal((await auto()).status, 401, 'Automatic login must not resurrect a revoked key');
});

test('public boundary authenticates every surface, enforces roles, and replaces backend identity', async t => {
  const received = [];
  const backend = http.createServer(async (req, res) => {
    if (req.url.startsWith('/poll/')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
      req.on('close', () => res.end()); return;
    }
    let raw = ''; for await (const c of req) raw += c;
    const input = raw ? JSON.parse(raw) : null; received.push(input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ kind: input?.kind, head: { status: 200 }, data: { accepted: true } }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const keys = generateKeyPairSync('ed25519');
  const config = { project: 'starter', projectName: 'Test', adminKey: 'administrator', workerKey: 'worker', clientKey: 'client',
    engineUrl: `http://127.0.0.1:${backend.address().port}`, publicUrl: 'http://127.0.0.1', zero: { expiresAt: '2026-11-01T00:00:00Z' },
    privateKey: keys.privateKey };
  let databaseFailed = false;
  const errors = [];
  const store = new MemoryStore(config);
  store.listFunctions = async () => {
    if (databaseFailed) throw Object.assign(new Error('private-host password=secret'), { code: 'ENOTFOUND' });
    return [];
  };
  const app = createApp(config, {}, { store, logError: entry => errors.push(JSON.parse(entry)) });
  app.listen(0, '127.0.0.1'); await once(app, 'listening'); config.publicUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => { app.closeAllConnections(); app.close(); backend.closeAllConnections(); backend.close(); });
  const request = (path, key, options = {}) => fetch(config.publicUrl + path, { ...options, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...options.headers } });
  for (const path of ['/v1/project', '/v1/functions', '/v1/examples', '/console', '/poll/default/id']) assert.equal((await request(path)).status, 401, path);
  assert.equal((await request('/v1/examples', 'worker')).status, 403);
  assert.equal((await (await request('/v1/examples', 'client')).json()).items.length, 4);
  assert.equal((await request('/v1/project', 'bad')).status, 401);
  assert.equal((await request('/v1/project', 'client')).status, 200);
  assert.equal((await request('/session', null, { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await request('/v1/executions', 'client', { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await request('/', 'worker', { method: 'POST', body: 'null' })).status, 400);
  assert.equal((await request('/v1/credentials', 'client', { method: 'POST' })).status, 403);
  assert.equal((await request('/console', 'worker')).status, 403);
  assert.equal((await request('/', 'client', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request('/', 'worker', { method: 'POST', body: JSON.stringify({ kind: 'debug.snapshot' }) })).status, 403);
  assert.equal(received.length, 0);
  const response = await request('/', 'worker', { method: 'POST', body: JSON.stringify({ kind: 'promise.get', head: { auth: 'spoofed-admin', 'resonate:debug_time': 1 }, data: { id: 'p' } }) });
  assert.equal(response.status, 200); assert.equal(received.length, 1);
  assert.notEqual(received[0].head.auth, 'spoofed-admin');
  assert.equal(received[0].head['resonate:debug_time'], undefined);
  const login = await request('/session', null, { method: 'POST', body: JSON.stringify({ key: 'administrator' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await request('/v1/project', null, { headers: { cookie: cookie.split(';')[0] } })).status, 200);
  assert.equal((await request('/v1/project', 'bad', { headers: { cookie: cookie.split(';')[0] } })).status, 401);
  assert.equal((await request('/session', null, { method: 'POST', headers: { Origin: 'https://foreign.invalid' }, body: JSON.stringify({ key: 'administrator' }) })).status, 403);
  const sse = await request('/poll/default/worker', 'worker', { signal: AbortSignal.timeout(1000) });
  assert.equal(sse.status, 200); assert.equal(sse.headers.get('content-type'), 'text/event-stream'); await sse.body.cancel();
  databaseFailed = true;
  const outage = await request('/v1/functions', 'client');
  assert.equal(outage.status, 503);
  const failure = await outage.json();
  assert.equal(failure.requestId, outage.headers.get('x-request-id'));
  assert.equal(errors[0].requestId, failure.requestId); assert.equal(errors[0].code, 'ENOTFOUND');
  assert.doesNotMatch(JSON.stringify([errors, failure]), /private-host|password|secret/);
  databaseFailed = false;
  assert.equal((await request('/v1/functions', 'client')).status, 200);
});
