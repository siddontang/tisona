import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { RuntimeController } from '../deploy/cloudflare/runtime-controller.mjs';
import { prepareRuntime } from '../deploy/cloudflare/entrypoint.mjs';
import { loadConfig, testLoginEnabled } from '../config.mjs';
import { hostingPreflight } from '../scripts/hosting-preflight.mjs';

test('concurrent cold requests share a single engine and upgrades stop the old engine first', async () => {
  const events = []; let alarm, starts = 0, currentRelease;
  const container = { running: false, images: { app: 'sha256:image' },
    async inspect() { return { labels: { release: currentRelease } }; },
    async destroy() { events.push('stop'); this.running = false; },
    start(options) { assert(!this.running); starts++; events.push('start'); this.running = true; currentRelease = options.labels.release; assert.equal(options.enableInternet, true); assert.equal(options.env.TISONA_RUNTIME, 'private'); },
    async setInactivityTimeout(ms) { assert(ms >= 10 * 60000); },
    getTcpPort(port) { assert.equal(port, 8787); return { fetch: async () => Response.json({ ready: true }) }; }
  };
  const ctx = { container, storage: { async setAlarm(value) { alarm = value; } } };
  const env = { TISONA_RUNTIME: 'private', RELEASE: 'first' };
  const controller = new RuntimeController(ctx, env);
  await Promise.all([controller.ready(), controller.ready(), controller.ready()]);
  assert.equal(starts, 1); assert(alarm > Date.now());
  await controller.ready();
  assert.equal(starts, 1, 'An unchanged release must keep the existing engine');
  env.RELEASE = 'upgrade'; await controller.ready();
  assert.deepEqual(events, ['start', 'stop', 'start']);
});

test('runtime probes readiness instead of treating running as ready and fails closed on an outage', async () => {
  let probes = 0, pauses = 0;
  const ctx = { storage: { async setAlarm() {} }, container: { running: true,
    async inspect() { return { labels: { release: 'same' } }; }, async setInactivityTimeout() {},
    getTcpPort() { return { async fetch() { probes++; return Response.json({ ready: false }, { status: 503 }); } }; }
  } };
  const controller = new RuntimeController(ctx, { TISONA_RUNTIME: 'secret', RELEASE: 'same' }, { pause: async () => pauses++ });
  await assert.rejects(controller.ready(), /readiness timed out/);
  assert.equal(probes, 60); assert.equal(pauses, 60); assert.equal(controller.starting, null);
});

test('container secrets restore a stable production identity without enabling public test login', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tisona-hosting-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const runtime = { databaseUrl: 'mysql://test:fixture@db.example:4000/tisona_hosted',
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
    publicUrl: 'https://api.example', consoleUrl: 'https://console.example', adminKey: 'admin-fixture', clientKey: 'client-fixture', workerKey: 'worker-fixture',
    databaseExpiresAt: new Date(Date.now() + 86400000).toISOString() };
  const env = await prepareRuntime(runtime, { directory, release: 'revision' });
  assert.equal(env.TISONA_RUNTIME, undefined); assert.equal(env.RESONATE_DATABASE_URL, undefined);
  for (const key of ['DATABASE_URL', 'ENGINE_PRIVATE_KEY', 'ENGINE_PUBLIC_KEY', 'BOOTSTRAP_ADMIN_KEY', 'BOOTSTRAP_CLIENT_KEY', 'BOOTSTRAP_WORKER_KEY']) {
    assert.equal((await stat(env[`RESONATE_${key}_FILE`])).mode & 0o777, 0o600);
  }
  const config = await loadConfig(env);
  assert.equal(config.clientKey, runtime.clientKey); assert.equal(config.workerKey, runtime.workerKey);
  assert.equal(config.databaseExpiresAt, runtime.databaseExpiresAt); assert.equal(config.release, 'revision');
  assert.equal(testLoginEnabled(config), false);
  const again = await prepareRuntime(runtime, { directory, release: 'upgrade' });
  assert.equal(await readFile(again.RESONATE_ENGINE_PRIVATE_KEY_FILE, 'utf8'), runtime.privateKey);
  await assert.rejects(prepareRuntime({ ...runtime, databaseExpiresAt: '2000-01-01T00:00:00Z' }, { directory }), /expired/);
  await assert.rejects(loadConfig({ ...env, RESONATE_DATABASE_EXPIRES_AT: 'invalid' }), /expired/);
});

test('a missing Cloudflare plan stops deployment with an actionable message and no token disclosure', async () => {
  const env = { CLOUDFLARE_API_TOKEN: 'fixture-secret', CLOUDFLARE_ACCOUNT_ID: 'account' };
  await assert.rejects(hostingPreflight(env, async () => Response.json({ success: false, errors: [{ message: 'Requires Workers Paid' }] }, { status: 401 })), error => {
    assert.match(error.message, /Workers Paid/); assert.match(error.message, /No Console release/); assert(!error.message.includes(env.CLOUDFLARE_API_TOKEN)); return true;
  });
});
