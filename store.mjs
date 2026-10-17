import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { digest } from './config.mjs';
import { check, canonical } from './domain.mjs';

export const keyRoles = new Set(['admin', 'client', 'worker', 'metrics']);
export function keyRecord(project, { role, name, expiresAt = null }, token = `rc_${role}_${randomBytes(32).toString('hex')}`) {
  check(keyRoles.has(role), 'Invalid key role');
  check(typeof name === 'string' && name.trim().length > 0 && name.length <= 100, 'Key name must be 1–100 characters');
  check(expiresAt === null || Number.isSafeInteger(expiresAt) && expiresAt > Date.now(), 'Key expiry must be a future timestamp');
  return { id: randomUUID(), projectId: project, name: name.trim(), role, prefix: token.slice(0, 20),
    tokenHash: digest(token), token, createdAt: Date.now(), expiresAt, revokedAt: null };
}
export function publicKey(key) {
  const { token, tokenHash, ...metadata } = key; return metadata;
}
const keyFromRow = row => row && ({ id: row.id, projectId: row.project_id, name: row.name, role: row.role,
  prefix: row.prefix, createdAt: Number(row.created_at), expiresAt: row.expires_at == null ? null : Number(row.expires_at),
  revokedAt: row.revoked_at == null ? null : Number(row.revoked_at) });
const functionFromRow = row => ({ name: row.name, version: row.version, group: row.worker_group,
  description: row.description, inputSchema: JSON.parse(row.input_schema) });

export class ControlStore {
  constructor(db, config) { this.db = db; this.project = config.project; this.config = config; }
  async migrate() {
    await this.db.query('CREATE TABLE IF NOT EXISTS cloud_schema_migrations (version INT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at BIGINT NOT NULL)');
    const sql = await readFile(new URL('./migrations/001_control.sql', import.meta.url), 'utf8');
    const checksum = digest(sql);
    const [versions] = await this.db.execute('SELECT checksum FROM cloud_schema_migrations WHERE version = 1');
    if (versions.length) { check(versions[0].checksum === checksum, 'Control schema migration checksum mismatch', 503); return; }
    // Each DDL is restartable: MySQL/TiDB DDL may commit before the migration
    // ledger is written. Production runs this explicit setup job before serve.
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await this.db.query(statement);
    await this.db.execute('INSERT IGNORE INTO cloud_schema_migrations (version, checksum, applied_at) VALUES (1, ?, ?)', [checksum, Date.now()]);
  }
  async projectTransaction(fn) {
    const connection = await this.db.getConnection();
    try {
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      const [rows] = await connection.execute('SELECT id FROM cloud_projects WHERE id = ? FOR UPDATE', [this.project]);
      check(rows.length, 'Project has not been initialized. Run setup.', 503);
      const result = await fn(connection); await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async initialize() {
    await this.db.execute('INSERT IGNORE INTO cloud_projects (id, name, created_at) VALUES (?, ?, ?)', [this.project, this.config.projectName, Date.now()]);
    await this.projectTransaction(async db => {
      const [[project]] = await db.execute('SELECT bootstrapped_at FROM cloud_projects WHERE id = ?', [this.project]);
      if (project.bootstrapped_at != null) return;
      check(typeof this.config.adminKey === 'string' && this.config.adminKey.length >= 32, 'Initial setup requires an administrator bootstrap key of at least 32 characters');
      for (const role of ['admin', 'client', 'worker']) {
        const token = this.config[`${role}Key`]; if (!token) continue;
        const key = keyRecord(this.project, { role, name: `Initial ${role} key` }, token);
        await this.insertKey(db, key);
      }
      // Import the original single-project catalogue once, preserving v1 runs.
      const [legacy] = await db.query("SHOW TABLES LIKE 'cloud_functions'");
      if (legacy.length && this.config.importLegacyFunctions) {
        const [rows] = await db.query('SELECT * FROM cloud_functions');
        for (const row of rows) await this.insertFunction(db, functionFromRow(row));
      }
      await db.execute('UPDATE cloud_projects SET bootstrapped_at = ? WHERE id = ?', [Date.now(), this.project]);
    });
  }
  async ready() {
    const [rows] = await this.db.execute('SELECT bootstrapped_at FROM cloud_projects WHERE id = ?', [this.project]);
    return rows.length > 0 && rows[0].bootstrapped_at != null;
  }
  async insertKey(db, key) {
    await db.execute('INSERT INTO cloud_api_keys (id, project_id, name, role, prefix, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [key.id, this.project, key.name, key.role, key.prefix, key.tokenHash, key.createdAt, key.expiresAt]);
  }
  async authenticate(token) {
    const now = Date.now();
    const [rows] = await this.db.execute('SELECT * FROM cloud_api_keys WHERE project_id = ? AND token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [this.project, digest(token), now]);
    return keyFromRow(rows[0]);
  }
  async authenticateSession(hash) {
    const now = Date.now();
    const [rows] = await this.db.execute(`SELECT k.* FROM cloud_sessions s JOIN cloud_api_keys k ON k.id = s.api_key_id AND k.project_id = s.project_id
      WHERE s.project_id = ? AND s.token_hash = ? AND s.expires_at > ? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)`, [this.project, hash, now, now]);
    return keyFromRow(rows[0]);
  }
  async keyActive(id) {
    const [rows] = await this.db.execute('SELECT id FROM cloud_api_keys WHERE project_id = ? AND id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [this.project, id, Date.now()]);
    return rows.length > 0;
  }
  async createSession(hash, actor, expiresAt) {
    await this.projectTransaction(async db => {
      await db.execute('DELETE FROM cloud_sessions WHERE project_id = ? AND expires_at <= ?', [this.project, Date.now()]);
      const [[count]] = await db.execute('SELECT COUNT(*) AS n FROM cloud_sessions WHERE project_id = ?', [this.project]);
      check(Number(count.n) < 100, 'Too many active sessions', 429);
      // Recheck inside the project lock so a concurrently revoked key cannot
      // mint a new session after its revocation transaction commits.
      const [keys] = await db.execute('SELECT id FROM cloud_api_keys WHERE project_id = ? AND id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [this.project, actor.id, Date.now()]);
      check(keys.length, 'Administrator credential expired or revoked', 401);
      await db.execute('INSERT INTO cloud_sessions (token_hash, project_id, api_key_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [hash, this.project, actor.id, Date.now(), expiresAt]);
      await this.audit('session.created', actor.id, actor, db);
    });
  }
  async deleteSession(hash) { await this.db.execute('DELETE FROM cloud_sessions WHERE project_id = ? AND token_hash = ?', [this.project, hash]); }
  async listKeys() {
    const [rows] = await this.db.execute('SELECT * FROM cloud_api_keys WHERE project_id = ? ORDER BY created_at DESC, id LIMIT 200', [this.project]);
    return rows.map(keyFromRow);
  }
  async createKey(input, actor) {
    const key = keyRecord(this.project, input);
    await this.projectTransaction(async db => {
      const [[count]] = await db.execute('SELECT COUNT(*) AS n FROM cloud_api_keys WHERE project_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', [this.project, Date.now()]);
      check(Number(count.n) < 100, 'Project has reached its active API key limit', 429);
      await this.insertKey(db, key); await this.audit('key.created', key.id, actor, db);
    });
    return { ...publicKey(key), token: key.token };
  }
  async revokeKey(id, actor) {
    await this.projectTransaction(async db => {
      const [[key]] = await db.execute('SELECT * FROM cloud_api_keys WHERE project_id = ? AND id = ?', [this.project, id]);
      check(key, 'API key not found', 404); if (key.revoked_at != null) return;
      if (key.role === 'admin' && (key.expires_at == null || key.expires_at > Date.now())) {
        const [[count]] = await db.execute("SELECT COUNT(*) AS n FROM cloud_api_keys WHERE project_id = ? AND role = 'admin' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", [this.project, Date.now()]);
        check(Number(count.n) > 1, 'Create another administrator key before revoking the last one', 409);
      }
      await db.execute('UPDATE cloud_api_keys SET revoked_at = ? WHERE project_id = ? AND id = ?', [Date.now(), this.project, id]);
      await this.audit('key.revoked', id, actor, db);
    });
  }
  async insertFunction(db, f) {
    await db.execute('INSERT INTO cloud_function_versions (project_id, name, version, worker_group, description, input_schema, descriptor_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [this.project, f.name, f.version, f.group, f.description, JSON.stringify(f.inputSchema), digest(JSON.stringify(canonical(f))), Date.now()]);
  }
  async registerFunction(f, actor) {
    return this.projectTransaction(async db => {
      const [rows] = await db.execute('SELECT * FROM cloud_function_versions WHERE project_id = ? AND name = ?', [this.project, f.name]);
      const previous = rows.find(row => row.version === f.version);
      if (previous) {
        check(previous.descriptor_hash === digest(JSON.stringify(canonical(f))), 'This function version is immutable. Publish a new version.', 409);
        return f;
      }
      check(!rows.some(row => row.worker_group === f.group), 'Use a different worker group for each version of this function', 409);
      await this.insertFunction(db, f); await this.audit('function.registered', `${f.name}@${f.version}`, actor, db); return f;
    });
  }
  async listFunctions(all = false) {
    const [rows] = await this.db.execute('SELECT * FROM cloud_function_versions WHERE project_id = ? ORDER BY name, version DESC', [this.project]);
    const seen = new Set();
    return rows.filter(row => { if (!all && seen.has(row.name)) return false; seen.add(row.name); return true; }).map(functionFromRow);
  }
  async getFunction(name, version) {
    const args = [this.project, name]; if (version != null) args.push(version);
    const [rows] = await this.db.execute(`SELECT * FROM cloud_function_versions WHERE project_id = ? AND name = ?${version == null ? '' : ' AND version = ?'} ORDER BY version DESC LIMIT 1`, args);
    check(rows.length, 'Function version not registered. Connect a compatible worker.', 404); return functionFromRow(rows[0]);
  }
  async heartbeat(worker, actor, ttl = 90000) {
    check(typeof worker.group === 'string' && /^[\w.-]{1,128}$/.test(worker.group), 'Invalid worker group');
    check(Array.isArray(worker.functions) && worker.functions.length > 0 && worker.functions.length <= 32, 'Worker requires 1–32 function versions');
    const functions = [];
    for (const item of worker.functions) {
      check(item && typeof item.name === 'string' && Number.isInteger(item.version), 'Invalid worker function version');
      const f = await this.getFunction(item.name, item.version); check(f.group === worker.group, 'Function version belongs to a different worker group', 409);
      functions.push({ name: f.name, version: f.version });
    }
    const now = Date.now();
    // Credential ownership is part of the upsert predicate. Another key cannot
    // take over an existing worker id, even with simultaneous first heartbeats.
    await this.db.execute(`INSERT INTO cloud_workers (project_id, id, api_key_id, worker_group, functions_json, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE worker_group = IF(api_key_id = VALUES(api_key_id), VALUES(worker_group), worker_group),
      functions_json = IF(api_key_id = VALUES(api_key_id), VALUES(functions_json), functions_json),
      last_seen_at = IF(api_key_id = VALUES(api_key_id), VALUES(last_seen_at), last_seen_at), expires_at = IF(api_key_id = VALUES(api_key_id), VALUES(expires_at), expires_at)`,
      [this.project, worker.id, actor.id, worker.group, JSON.stringify(functions), now, now + ttl]);
    const [[owner]] = await this.db.execute('SELECT api_key_id FROM cloud_workers WHERE project_id = ? AND id = ?', [this.project, worker.id]);
    check(owner.api_key_id === actor.id, 'Worker ID belongs to another credential', 403);
    return { id: worker.id, expiresAt: now + ttl, heartbeatIntervalMs: 20000 };
  }
  async offlineWorker(id, actor) {
    await this.db.execute('UPDATE cloud_workers SET expires_at = ? WHERE project_id = ? AND id = ? AND api_key_id = ?', [Date.now(), this.project, id, actor.id]);
  }
  async listWorkers() {
    const now = Date.now();
    const [rows] = await this.db.execute(`SELECT w.*, k.revoked_at, k.expires_at AS key_expires_at FROM cloud_workers w JOIN cloud_api_keys k ON k.id = w.api_key_id AND k.project_id = w.project_id
      WHERE w.project_id = ? ORDER BY w.last_seen_at DESC LIMIT 200`, [this.project]);
    return rows.map(row => ({ id: row.id, group: row.worker_group, functions: JSON.parse(row.functions_json), lastSeenAt: Number(row.last_seen_at), expiresAt: Number(row.expires_at),
      online: row.expires_at > now && row.revoked_at == null && (row.key_expires_at == null || row.key_expires_at > now) }));
  }
  async audit(action, target, actor, db = this.db) {
    await db.execute('INSERT INTO cloud_audit_events (project_id, api_key_id, action, target, created_at) VALUES (?, ?, ?, ?, ?)', [this.project, actor.id, action, target, Date.now()]);
  }
  async listAudit() {
    const [rows] = await this.db.execute('SELECT api_key_id AS actorKeyId, action, target, created_at AS createdAt FROM cloud_audit_events WHERE project_id = ? ORDER BY id DESC LIMIT 100', [this.project]); return rows;
  }
  async cleanup() {
    await this.db.execute('DELETE FROM cloud_sessions WHERE project_id = ? AND expires_at < ?', [this.project, Date.now()]);
  }
}
