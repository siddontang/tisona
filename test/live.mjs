// Real Cloud Zero integration. Uses its own execution IDs and never resets
// or drops the application's database. Owns its child processes and ports.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadConfig, databaseOptions, privateFile, stateDir, engineBinary, dir, engineEnvironment } from '../config.mjs';
import { startDatabaseRelay } from '../database-relay.mjs';

const config = await loadConfig();
const children = new Set();
const log = await open(resolve(stateDir, 'live-test.log'), 'a', 0o600);
const auditPath = resolve(stateDir, `audit-${randomUUID()}.ndjson`);
const evidence = { startedAt: new Date().toISOString(), checks: [] };
const fixtureFunctions = [];
let childFailure;
function start(command, args, env = {}) {
  const childEnv = { ...process.env, ...env };
  const child = spawn(command, args, { cwd: dir, env: command === engineBinary ? engineEnvironment(childEnv) : childEnv, stdio: ['ignore', log.fd, log.fd] });
  children.add(child);
  child.on('error', () => { childFailure = new Error('An owned service process could not start. Check the private integration log.'); });
  child.on('exit', code => { if (!child.expectedExit) childFailure = new Error(`An owned service process exited unexpectedly (${code}). Check the private integration log.`); });
  return child;
}
async function stop(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.expectedExit = true;
  child.kill(signal);
  await Promise.race([once(child, 'exit'), delay(10000).then(() => { child.kill('SIGKILL'); })]);
}
async function waitFor(description, fn, seconds = 90) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    if (childFailure) throw childFailure;
    try { const result = await fn(); if (result) return result; } catch (e) { last = e; }
    await delay(1000);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function api(path, { role = 'client', method = 'GET', body, key } = {}) {
  const response = await fetch(config.publicUrl + path, { method, headers: { Authorization: `Bearer ${config[`${role}Key`]}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  return { status: response.status, data: await response.json() };
}
function passed(name) { evidence.checks.push(name); console.log(`PASS ${name}`); }
let engine, gateway, worker, relay;
try {
  // Refuse to run against a service owned by someone else: the restart check
  // must only terminate processes this script created.
  for (const endpoint of [config.publicUrl + '/healthz', config.engineUrl + '/ready']) {
    let busy = false; try { await fetch(endpoint, { signal: AbortSignal.timeout(1000) }); busy = true; } catch {}
    assert.equal(busy, false, 'Stop npm start / the existing service before running live tests');
  }
  const db = mysql.createPool(databaseOptions(config));
  try {
    const [info] = await db.query('SELECT VERSION() AS version, @@tidb_txn_mode AS mode');
    evidence.database = info[0]; assert.equal(info[0].mode, 'pessimistic');
    const cas = randomUUID();
    await db.query('CREATE TABLE IF NOT EXISTS cloud_compat_cas (id VARCHAR(64) PRIMARY KEY, value INT NOT NULL)');
    await db.execute('INSERT INTO cloud_compat_cas (id,value) VALUES (?,0)', [cas]);
    const updates = await Promise.all([1, 2, 3].map(v => db.execute('UPDATE cloud_compat_cas SET value=? WHERE id=? AND value=0', [v, cas])));
    assert.equal(updates.reduce((n, [r]) => n + r.affectedRows, 0), 1);
    await db.execute('DELETE FROM cloud_compat_cas WHERE id=?', [cas]); passed('TiDB TLS connection, pessimistic transactions, atomic conditional update');
  } finally { await db.end(); }

  relay = await startDatabaseRelay(config);
  engine = start(engineBinary, ['serve', '--config', resolve(stateDir, 'resonate.toml')]);
  gateway = start(process.execPath, ['server.mjs']);
  await waitFor('service readiness', async () => (await fetch(config.publicUrl + '/healthz')).ok);
  passed('Unmodified Resonate MySQL migrations and authenticated engine startup');
  assert.equal((await fetch(config.publicUrl + '/v1/project')).status, 401);
  assert.equal((await api('/v1/credentials', { method: 'POST' })).status, 403);
  assert.equal((await fetch(config.engineUrl + '/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'promise.get', head: { version: '2026-04-01', corrId: 'no-auth' }, data: { id: 'x' } }) })).status, 401);
  passed('Public API authorization, role separation, private engine JWT verification');
  worker = start(process.execPath, ['worker.mjs'], { RESONATE_URL: config.publicUrl, RESONATE_TOKEN: config.workerKey, WORKER_AUDIT_FILE: auditPath });
  await waitFor('worker function manifest', async () => (await api('/v1/functions')).data.items?.some(f => f.name === 'research'));

  const requestKey = `live-${randomUUID()}`;
  const input = { function: 'research', version: 1, input: { topic: 'Cloud Zero compatibility', delaySeconds: 2, requireApproval: true } };
  const attempts = await Promise.all([0, 1, 2].map(() => api('/v1/executions', { method: 'POST', key: requestKey, body: input })));
  attempts.forEach(r => assert.equal(r.status, 202, JSON.stringify(r.data)));
  const id = attempts[0].data.id; evidence.executionId = id;
  assert.equal(new Set(attempts.map(r => r.data.id)).size, 1);
  const conflict = await api('/v1/executions', { method: 'POST', key: requestKey, body: { ...input, input: { topic: 'different' } } });
  assert.equal(conflict.status, 409);
  passed('Concurrent idempotent starts produce one execution; mismatched reuse returns 409');
  const waiting = await waitFor('durable timer and approval wait', async () => {
    const r = await api(`/v1/executions/${id}`); return r.status === 200 && r.data.waits?.length ? r.data : null;
  }, 150);
  assert.equal(waiting.steps.find(n => n.function === 'plan').state, 'resolved');
  passed('Independent SDK worker, durable step, durable timer, persisted approval wait');

  await stop(worker, 'SIGKILL'); await stop(engine, 'SIGKILL');
  engine = start(engineBinary, ['serve', '--config', resolve(stateDir, 'resonate.toml')]);
  await waitFor('engine restart', async () => (await fetch(config.publicUrl + '/healthz')).ok);
  const recovered = (await api(`/v1/executions/${id}`)).data;
  assert.equal(recovered.waits[0].id, waiting.waits[0].id);
  const approval = await api(`/v1/executions/${id}/waits`, { method: 'POST', body: { waitId: waiting.waits[0].id, value: { approved: true } } });
  assert.equal(approval.status, 200, JSON.stringify(approval.data));
  passed('Worker and engine SIGKILL recovery; approval accepted with worker offline');
  worker = start(process.execPath, ['worker.mjs'], { RESONATE_URL: config.publicUrl, RESONATE_TOKEN: config.workerKey, WORKER_AUDIT_FILE: auditPath });
  const done = await waitFor('execution completion after restart', async () => {
    const r = await api(`/v1/executions/${id}`); return r.data.state === 'resolved' ? r.data : null;
  }, 150);
  assert.equal(done.result.approved, true);
  const events = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.execution === id);
  assert.equal(events.length, 1, 'Completed plan step must not be executed again');
  passed('Persisted result returned; completed checkpoint executed only once across restarts');
  const login = await fetch(config.publicUrl + '/session', { method: 'POST', body: JSON.stringify({ key: config.adminKey }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  await stop(gateway);
  gateway = start(process.execPath, ['server.mjs']);
  await waitFor('gateway restart', async () => (await fetch(config.publicUrl + '/healthz')).ok);
  assert.equal((await fetch(config.publicUrl + '/v1/project', { headers: { cookie } })).status, 200);
  passed('Browser session survives an actual gateway process restart');
  const page = await fetch(config.publicUrl + '/', { headers: { cookie } });
  assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, /id="execution-steps"/); assert.doesNotMatch(html, /<iframe|\/console\//);
  const nativeRead = await fetch(config.publicUrl + `/v1/executions/${id}`, { headers: { cookie } });
  const nativeView = await nativeRead.json();
  assert.equal(nativeRead.status, 200); assert.equal(nativeView.state, 'resolved');
  assert.ok(nativeView.steps.some(step => step.function === 'plan' && step.parentId === id && step.createdAt));
  assert.match(nativeView.consoleUrl, /\/#executions\//);
  const filtered = await api(`/v1/executions?idPrefix=${id}&state=resolved&func=research&limit=1`);
  assert.equal(filtered.status, 200); assert.equal(filtered.data.items[0].id, id);
  const oldLink = await fetch(config.publicUrl + `/console/executions/${id}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(oldLink.status, 302); assert.equal(oldLink.headers.get('location'), `/#executions/${id}`);
  passed('Native Console, REST step inspection, exact history filters, and durable deep links');
  const fn = `upgrade-${randomUUID().slice(0, 12)}`; fixtureFunctions.push(fn);
  const versionOne = { name: fn, version: 1, group: `${fn}-v1`, description: 'Disposable version fixture', inputSchema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string' } } } };
  assert.equal((await api('/v1/functions', { role: 'worker', method: 'POST', body: versionOne })).status, 200);
  const upgradeInput = { function: fn, input: { topic: 'Pinned request' } }, upgradeKey = `upgrade-${requestKey}`;
  const before = await api('/v1/executions', { method: 'POST', key: upgradeKey, body: upgradeInput });
  assert.equal(before.status, 202); assert.equal(before.data.version, 1);
  assert.equal((await api('/v1/functions', { role: 'worker', method: 'POST', body: { ...versionOne, version: 2, group: `${fn}-v2`, inputSchema: { type: 'object', required: ['newField'], properties: { newField: { type: 'boolean' } } } } })).status, 200);
  const after = await api('/v1/executions', { method: 'POST', key: upgradeKey, body: upgradeInput });
  assert.equal(after.status, 202); assert.equal(after.data.id, before.data.id); assert.equal(after.data.version, 1);
  await api(`/v1/executions/${before.data.id}/cancel`, { method: 'POST' });
  passed('Real execution retains its v1 identity after an incompatible v2 schema rollout');
  const created = await api('/v1/api-keys', { role: 'admin', method: 'POST', body: { name: 'Disposable metrics collector', role: 'metrics' } });
  assert.equal(created.status, 201);
  const headers = { Authorization: `Bearer ${created.data.token}` };
  const metrics = await fetch(config.publicUrl + '/metrics', { headers }); assert.equal(metrics.status, 200); assert.match(await metrics.text(), /cloud_workers_online/);
  const engineMetrics = await fetch(config.publicUrl + '/metrics/engine', { headers }); assert.equal(engineMetrics.status, 200);
  assert.equal((await fetch(config.publicUrl + '/v1/project', { headers })).status, 403);
  assert.equal((await api('/v1/api-keys/' + created.data.id, { role: 'admin', method: 'DELETE' })).status, 200);
  assert.equal((await fetch(config.publicUrl + '/metrics', { headers })).status, 401);
  const reporting = await api('/v1/workers'); assert.ok(reporting.data.items.some(worker => worker.online && worker.functions.some(f => f.name === 'research' && f.version === 1)));
  passed('Persisted worker presence, restricted gateway/engine metrics, and immediate key revocation');
  const cancellation = await api('/v1/executions', { method: 'POST', key: `cancel-${requestKey}`, body: { function: 'research', version: 1, input: { topic: 'Cancellation', delaySeconds: 120 } } });
  assert.equal(cancellation.status, 202);
  const canceled = await api(`/v1/executions/${cancellation.data.id}/cancel`, { method: 'POST' });
  assert.equal(canceled.data.state, 'rejected_canceled'); passed('Execution cancellation recorded durably');
  evidence.completedAt = new Date().toISOString(); evidence.passed = true;
  await privateFile('live-results.json', JSON.stringify(evidence, null, 2));
  console.log(`All live checks passed. Evidence: .local/live-results.json`);
} catch (error) {
  evidence.passed = false; evidence.failure = error.message;
  await privateFile('live-results.json', JSON.stringify(evidence, null, 2));
  console.error(error.message); process.exitCode = 1;
} finally {
  for (const child of children) await stop(child);
  await relay?.close();
  if (fixtureFunctions.length) {
    const cleanup = mysql.createPool(databaseOptions(config));
    try { for (const name of fixtureFunctions) await cleanup.execute('DELETE FROM cloud_function_versions WHERE project_id = ? AND name = ?', [config.project, name]); }
    finally { await cleanup.end(); }
  }
  await log.close();
}
