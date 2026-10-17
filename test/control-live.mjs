// Exercises the real SQL implementation with disposable project IDs only.
// Never deletes or resets the user's project, execution state, or catalogue.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { loadConfig, databaseOptions, digest, privateFile } from '../config.mjs';
import { ControlStore } from '../store.mjs';

const config = await loadConfig(), db = mysql.createPool(databaseOptions(config));
const projects = [], evidence = { startedAt: new Date().toISOString(), checks: [] };
const token = () => randomBytes(32).toString('hex');
function passed(name) { evidence.checks.push(name); console.log(`PASS ${name}`); }
async function project() {
  const local = { ...config, project: `test-${randomUUID()}`, projectName: 'Disposable integration project', adminKey: token(), workerKey: token(), clientKey: token(), importLegacyFunctions: false };
  projects.push(local.project);
  const store = new ControlStore(db, local); await store.migrate(); await store.initialize(); return { local, store };
}
try {
  const { local, store } = await project();
  const admin = await store.authenticate(local.adminKey); assert.equal(admin.role, 'admin');
  const session = digest(token()); await store.createSession(session, admin, Date.now() + 60000);
  const replacement = new ControlStore(db, local);
  assert.equal((await replacement.authenticateSession(session)).id, admin.id);
  const [[row]] = await db.execute('SELECT token_hash FROM cloud_api_keys WHERE id = ?', [admin.id]);
  assert.equal(row.token_hash, digest(local.adminKey)); assert.notEqual(row.token_hash, local.adminKey);
  passed('SQL credential hashing and sessions survive a new store instance');
  await new ControlStore(db, { ...local, adminKey: token() }).initialize();
  assert.equal((await store.listKeys()).length, 3);
  const worker = await store.authenticate(local.workerKey); await store.revokeKey(worker.id, admin); await store.initialize();
  assert.equal(await store.authenticate(local.workerKey), undefined);
  passed('Bootstrap executes once and never resurrects a revoked credential');
  const other = await project();
  assert.equal(await other.store.authenticate(local.adminKey), undefined); assert.equal(await other.store.authenticateSession(session), undefined);
  const f = { name: 'workflow', version: 1, group: 'workflow-v1', description: 'SQL fixture', inputSchema: { type: 'object' } };
  await store.registerFunction(f, admin); await store.registerFunction(f, admin);
  await assert.rejects(store.registerFunction({ ...f, description: 'changed' }, admin), error => error.status === 409);
  await assert.rejects(store.registerFunction({ ...f, version: 2 }, admin), error => error.status === 409);
  await store.registerFunction({ ...f, version: 2, group: 'workflow-v2' }, admin);
  assert.deepEqual((await store.listFunctions(true)).map(f => f.version), [2, 1]);
  assert.equal((await store.getFunction('workflow')).version, 2); assert.equal((await store.getFunction('workflow', 1)).version, 1);
  assert.deepEqual(await other.store.listFunctions(true), []);
  passed('Real SQL versions are immutable, remain addressable, and stay scoped to their project');
  const ownerKey = await store.createKey({ name: 'Owner', role: 'worker' }, admin), owner = await store.authenticate(ownerKey.token);
  const otherKey = await store.createKey({ name: 'Other', role: 'worker' }, admin), outsider = await store.authenticate(otherKey.token);
  const heartbeat = { id: 'worker-a', group: f.group, functions: [{ name: f.name, version: 1 }] };
  await store.heartbeat(heartbeat, owner);
  await assert.rejects(store.heartbeat(heartbeat, outsider), error => error.status === 403);
  assert.equal((await store.listWorkers())[0].online, true);
  await store.revokeKey(owner.id, admin); assert.equal((await store.listWorkers())[0].online, false);
  const key = await store.createKey({ name: 'Expires', role: 'client' }, admin);
  await db.execute('UPDATE cloud_api_keys SET expires_at = ? WHERE id = ?', [Date.now() - 1, key.id]);
  assert.equal(await store.authenticate(key.token), undefined);
  passed('Heartbeat ownership, worker status after revocation, and key expiry use persisted SQL state');
  const next = await store.createKey({ name: 'Second admin', role: 'admin' }, admin);
  const revocations = await Promise.allSettled([store.revokeKey(admin.id, admin), store.revokeKey(next.id, admin)]);
  assert.equal(revocations.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(revocations.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await store.listKeys()).filter(key => key.role === 'admin' && !key.revokedAt).length, 1);
  passed('Concurrent administrator revocations cannot remove the last active administrator');
  const audit = JSON.stringify(await store.listAudit());
  assert.doesNotMatch(audit, new RegExp(ownerKey.token)); assert.match(audit, /key.revoked/);
  passed('Persisted audit events identify actions and actors without storing secret values');
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.error = error.message; process.exitCode = 1; console.error(error.message); }
finally {
  for (const id of projects) for (const table of ['cloud_workers', 'cloud_sessions', 'cloud_api_keys', 'cloud_function_versions', 'cloud_audit_events', 'cloud_projects']) {
    await db.execute(`DELETE FROM ${table} WHERE ${table === 'cloud_projects' ? 'id' : 'project_id'} = ?`, [id]);
  }
  await db.end(); evidence.completedAt = new Date().toISOString();
  await privateFile('control-live-results.json', JSON.stringify(evidence, null, 2));
}
