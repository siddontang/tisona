import { access, readFile } from 'node:fs/promises';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { stateDir, privateFile, databaseOptions, loadConfig, renderEngineConfig } from './config.mjs';
import { ControlStore } from './store.mjs';

async function exists(path) { try { await access(path); return true; } catch { return false; } }
const production = process.env.NODE_ENV === 'production';
const external = process.env.RESONATE_DATABASE_URL || process.env.RESONATE_DATABASE_URL_FILE;
if (!production) {
  if (!external && !await exists(resolve(stateDir, 'zero.json'))) {
    const response = await fetch('https://zero.tidbapi.com/v1beta1/instances', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'resonate-cloud-mvp' }), signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Cloud Zero provisioning failed (${response.status})`);
    const zero = await response.json();
    if (!zero.instance?.connection?.password) throw new Error('Cloud Zero returned no database credentials');
    await privateFile('zero.json', JSON.stringify(zero, null, 2));
  }
  if (!await exists(resolve(stateDir, 'runtime.json'))) {
    await privateFile('runtime.json', JSON.stringify({ project: 'starter', projectName: 'Starter project', database: 'resonate_mvp',
      bind: '127.0.0.1', port: 8788, engineUrl: 'http://127.0.0.1:8001', publicUrl: 'http://127.0.0.1:8788', consoleUrl: 'http://127.0.0.1:8787',
      adminKey: `rc_admin_${randomBytes(32).toString('hex')}`, clientKey: `rc_client_${randomBytes(32).toString('hex')}`, workerKey: `rc_worker_${randomBytes(32).toString('hex')}` }, null, 2));
  }
  // Upgrade the original single-port local preview without changing its keys/DB.
  const runtimePath = resolve(stateDir, 'runtime.json');
  const localRuntime = JSON.parse(await readFile(runtimePath, 'utf8'));
  if (!localRuntime.consoleUrl && localRuntime.publicUrl === 'http://127.0.0.1:8787' && localRuntime.port === 8787) {
    await privateFile('runtime.json', JSON.stringify({ ...localRuntime, port: 8788, publicUrl: 'http://127.0.0.1:8788', consoleUrl: 'http://127.0.0.1:8787' }, null, 2));
  }
  if (!await exists(resolve(stateDir, 'engine-private.pem'))) {
    const keys = generateKeyPairSync('ed25519');
    await privateFile('engine-private.pem', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await privateFile('engine-public.pem', keys.publicKey.export({ type: 'spki', format: 'pem' }));
  }
}
const config = await loadConfig();
const options = databaseOptions(config);
if (!production) {
  delete options.database;
  const db = await mysql.createConnection(options);
  try { await db.query(`CREATE DATABASE IF NOT EXISTS \`${config.database}\``); } finally { await db.end(); }
}
const db = mysql.createPool(databaseOptions(config));
try {
  const [rows] = await db.query('SELECT VERSION() AS version, @@tidb_txn_mode AS transactionMode, @@transaction_isolation AS isolationLevel');
  if (rows[0].transactionMode !== 'pessimistic') throw new Error('The TiDB database must use pessimistic transactions');
  const store = new ControlStore(db, config);
  await store.migrate(); await store.initialize(); await store.cleanup();
  await privateFile('compatibility.json', JSON.stringify({ checkedAt: new Date().toISOString(), database: rows[0], expiresAt: config.zero?.expiresAt ?? null }, null, 2));
  console.log(`Control schema and project ready; database=${rows[0].version}.`);
} finally { await db.end(); }
await privateFile('resonate.toml', renderEngineConfig(config));
if (!production) {
  await privateFile('worker.env', `RESONATE_URL=${config.publicUrl}\nRESONATE_TOKEN=${config.workerKey}\n`);
  await privateFile('client.env', `RESONATE_URL=${config.publicUrl}\nRESONATE_TOKEN=${config.clientKey}\n`);
}
console.log(`API ready to start: ${config.publicUrl}; Web Console: ${config.consoleUrl ?? 'configure separately'}. Bootstrap credentials are imported only once; revoked keys are never reseeded.`);
