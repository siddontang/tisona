import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig, renderEngineConfig, connectionFromUrl, secret, engineEnvironment, testLoginEnabled, resolveStateDir, dir } from '../config.mjs';
import { Metrics, metricRoute } from '../metrics.mjs';

test('runtime state defaults to the ignored local directory and supports custom locations', () => {
  const outside = join(tmpdir(), 'tisona-private-state');
  assert.equal(resolveStateDir({}), join(dir, '.local'));
  assert.equal(resolveStateDir({ RESONATE_STATE_DIR: outside }), outside);
  for (const path of [join(dir, '.local'), join(dir, 'nested', 'runtime')]) {
    assert.equal(resolveStateDir({ RESONATE_STATE_DIR: path }), path);
  }
});

test('production uses persistent database and mounted secrets without requiring Zero state', async t => {
  const path = await mkdtemp(join(tmpdir(), 'resonate-config-')); t.after(() => rm(path, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  await writeFile(join(path, 'private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(join(path, 'public.pem'), keys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(join(path, 'database.url'), 'mysql://runtime:fixture-password@db.example:4000/production\n', { mode: 0o600 });
  await writeFile(join(path, 'admin.key'), 'fixture-admin-key-at-least-thirty-two-characters\n', { mode: 0o600 });
  const env = { NODE_ENV: 'production', RESONATE_STATE_DIR: path, RESONATE_PUBLIC_URL: 'https://runs.example',
    RESONATE_DATABASE_URL_FILE: join(path, 'database.url'), RESONATE_BOOTSTRAP_ADMIN_KEY_FILE: join(path, 'admin.key'),
    RESONATE_ENGINE_PRIVATE_KEY_FILE: join(path, 'private.pem'), RESONATE_ENGINE_PUBLIC_KEY_FILE: join(path, 'public.pem') };
  const config = await loadConfig(env);
  assert.equal(config.zero, null); assert.equal(config.connection.host, 'db.example'); assert.equal(config.database, 'production');
  assert.equal(config.databaseRelay, false); assert.equal(config.mode, 'production'); assert.match(config.adminKey, /^fixture-admin/);
  const rendered = renderEngineConfig(config);
  assert.match(rendered, /ssl-mode=VERIFY_IDENTITY/); assert.doesNotMatch(rendered, /socket=/);
  assert.match(rendered, /\[gateways.gateway_metrics\]\nenabled = true\nbind = "127.0.0.1:9091"/);
  await assert.rejects(loadConfig({ ...env, RESONATE_PUBLIC_URL: 'http://runs.example' }), /requires HTTPS/);
  await assert.rejects(loadConfig({ ...env, RESONATE_DATABASE_URL_FILE: undefined }), /Production requires RESONATE_DATABASE/);
  await assert.rejects(loadConfig({ ...env, RESONATE_ENGINE_PRIVATE_KEY_FILE: undefined }), /explicit engine signing/);
  await assert.rejects(loadConfig({ ...env, RESONATE_DATABASE_URL: 'mysql://conflicting' }), /either/);
  await assert.rejects(loadConfig({ ...env, RESONATE_PUBLIC_URL: 'https://runs.example/subpath' }), /origin URL/);
  const split = await loadConfig({ ...env, RESONATE_CONSOLE_URL: 'https://console.example' });
  assert.equal(split.publicUrl, 'https://runs.example'); assert.equal(split.consoleUrl, 'https://console.example');
  await assert.rejects(loadConfig({ ...env, RESONATE_CONSOLE_URL: 'http://console.example' }), /console URL requires HTTPS/);
  await assert.rejects(loadConfig({ ...env, RESONATE_CONSOLE_URL: 'https://console.example/path' }), /origin URL/);
});

test('database configuration refuses disabled TLS and invalid database identifiers', async () => {
  for (const value of ['mysql://user:secret@db/test?ssl-mode=DISABLED', 'postgres://db/test', 'mysql://db/', 'mysql://db/bad-name']) assert.throws(() => connectionFromUrl(value));
  assert.equal(connectionFromUrl('mysql://user:password@db:4000/valid').database, 'valid');
  await assert.rejects(secret({ TOKEN: 'a', TOKEN_FILE: '/unused' }, 'TOKEN'), /either/);
  assert.deepEqual(engineEnvironment({ PATH: '/bin', RUST_LOG: 'warn', RESONATE_ENGINE_BINARY: '/engine', RESONATE_DATABASE_URL: 'private' }), { PATH: '/bin', RUST_LOG: 'warn' });
});

test('automatic test sign-in is enabled only for loopback development and can be disabled', () => {
  const config = { mode: 'development', bind: '127.0.0.1', publicUrl: 'http://127.0.0.1:8787', adminKey: 'admin' };
  assert.equal(testLoginEnabled(config), true);
  for (const override of [{ mode: 'production', testAutoLogin: true }, { testAutoLogin: false }, { bind: '0.0.0.0' },
    { publicUrl: 'https://public.example' }, { consoleUrl: 'https://public.example' }, { adminKey: undefined }]) assert.equal(testLoginEnabled({ ...config, ...override }), false);
  assert.equal(testLoginEnabled({ ...config, bind: '::1', publicUrl: 'http://[::1]:8787' }), true);
});

test('metrics use bounded route labels and never include execution IDs or credential-like paths', () => {
  const metrics = new Metrics();
  for (let i = 0; i < 500; i++) metrics.observe('GET', metricRoute(`/v1/executions/private-${i}`), 200, 0.2);
  metrics.observe('GET', metricRoute('/unexpected/rc_secret'), 404, 0.3);
  metrics.observe('GET', metricRoute('/poll/default/subscriber'), 200, 3600);
  const result = metrics.render(2);
  assert.match(result, /cloud_http_requests_total\{method="GET",route="\/v1\/executions\/:id",status="200"\} 500/);
  assert.doesNotMatch(result, /private-|rc_secret/); assert.equal(metrics.requests.size, 3);
  assert.equal(metrics.latencies.size, 2, 'SSE stream lifetime must not trigger an API latency alert');
  assert.match(result, /cloud_workers_online 2/); assert.match(result, /le="0.5"\} 500/);
});
