// Test double only. Runtime always uses the SQL ControlStore.
import { digest } from '../../config.mjs';
import { keyRecord, publicKey } from '../../store.mjs';
import { check, canonical } from '../../domain.mjs';

export class MemoryStore {
  constructor(config, state = { keys: new Map(), sessions: new Map(), functions: [], workers: new Map(), audit: [] }) {
    this.project = config.project; this.state = state;
    for (const role of ['admin', 'worker', 'client']) if (config[`${role}Key`] && ![...state.keys.values()].some(k => k.projectId === this.project && k.tokenHash === digest(config[`${role}Key`]))) {
      const key = keyRecord(this.project, { role, name: role }, config[`${role}Key`]); state.keys.set(key.id, key);
    }
  }
  async ready() { return true; }
  active(key) { return key && key.projectId === this.project && !key.revokedAt && (!key.expiresAt || key.expiresAt > Date.now()); }
  async authenticate(token) { return [...this.state.keys.values()].find(k => k.tokenHash === digest(token) && this.active(k)); }
  async keyActive(id) { return !!this.active(this.state.keys.get(id)); }
  async authenticateSession(hash) {
    const session = this.state.sessions.get(hash);
    return session?.expiresAt > Date.now() && await this.keyActive(session.keyId) ? this.state.keys.get(session.keyId) : undefined;
  }
  async createSession(hash, actor, expiresAt) { this.state.sessions.set(hash, { keyId: actor.id, expiresAt }); }
  async deleteSession(hash) { this.state.sessions.delete(hash); }
  async listKeys() { return [...this.state.keys.values()].filter(k => k.projectId === this.project).map(publicKey); }
  async createKey(input, actor) { const key = keyRecord(this.project, input); this.state.keys.set(key.id, key); await this.audit('key.created', key.id, actor); return { ...publicKey(key), token: key.token }; }
  async revokeKey(id, actor) {
    const key = this.state.keys.get(id); check(key?.projectId === this.project, 'API key not found', 404);
    if (key.revokedAt) return;
    if (key.role === 'admin') check([...this.state.keys.values()].filter(k => this.active(k) && k.role === 'admin').length > 1, 'Create another administrator key before revoking the last one', 409);
    key.revokedAt = Date.now(); await this.audit('key.revoked', id, actor);
  }
  async listFunctions(all = false) {
    const rows = this.state.functions.filter(f => f.projectId === this.project).sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version);
    const seen = new Set();
    return rows.filter(f => { if (!all && seen.has(f.name)) return false; seen.add(f.name); return true; }).map(({ projectId, ...f }) => f);
  }
  async getFunction(name, version) { const f = (await this.listFunctions(true)).find(f => f.name === name && (version == null || f.version === version)); check(f, 'Function version not registered', 404); return f; }
  async registerFunction(f) {
    const rows = await this.listFunctions(true), old = rows.find(row => row.name === f.name && row.version === f.version);
    if (old) { check(JSON.stringify(canonical(old)) === JSON.stringify(canonical(f)), 'This function version is immutable', 409); return f; }
    check(!rows.some(row => row.name === f.name && row.group === f.group), 'Use a different worker group for each version of this function', 409);
    this.state.functions.push({ ...f, projectId: this.project }); return f;
  }
  async heartbeat(worker, actor) {
    check(Array.isArray(worker.functions) && worker.functions.length > 0, 'Worker requires function versions');
    for (const item of worker.functions) { const f = await this.getFunction(item.name, item.version); check(f.group === worker.group, 'Function belongs to another group', 409); }
    const previous = this.state.workers.get(worker.id); check(!previous || previous.keyId === actor.id, 'Worker ID belongs to another credential', 403);
    const expiresAt = Date.now() + 90000;
    this.state.workers.set(worker.id, { ...worker, keyId: actor.id, lastSeenAt: Date.now(), expiresAt }); return { id: worker.id, expiresAt };
  }
  async offlineWorker(id, actor) { const worker = this.state.workers.get(id); if (worker?.keyId === actor.id) worker.expiresAt = Date.now(); }
  async listWorkers() { return Promise.all([...this.state.workers.values()].map(async worker => ({ ...worker, online: worker.expiresAt > Date.now() && await this.keyActive(worker.keyId) }))); }
  async audit(action, target, actor) { this.state.audit.push({ action, target, actorKeyId: actor.id, createdAt: Date.now() }); }
  async listAudit() { return this.state.audit; }
}
