import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import mysql from 'mysql2/promise';
import { databaseStream } from '../network.mjs';

const directory = resolve('.local/hosting'), repo = 'siddontang/tisona';
await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
const save = async (name, value) => { const p = resolve(directory, name); await writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { mode: 0o600 }); await chmod(p, 0o600); };
const exists = async name => { try { await access(resolve(directory, name)); return true; } catch { return false; } };
async function command(program, args, input) {
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; });
  // CLI diagnostics may include server connection details. Report only status.
  child.stderr.resume(); child.stdin.end(input);
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code) throw new Error(`${program} failed (exit ${code})`);
  return output;
}
async function token(name, file) { return process.env[name] || (await readFile(resolve(homedir(), file), 'utf8')).trim(); }
const cf = await token('CLOUDFLARE_API_TOKEN', '.cloudflare'), netlify = await token('NETLIFY_AUTH_TOKEN', '.netlify');
async function api(base, auth, path, { method = 'GET', body } = {}) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${base.includes('cloudflare') ? 'Cloudflare' : 'Netlify'} API ${method} ${path} failed (HTTP ${response.status})`);
  return response.json();
}
const cfApi = (path, options) => api('https://api.cloudflare.com/client/v4', cf, path, options);
const nlApi = (path, options) => api('https://api.netlify.com/api/v1', netlify, path, options);
const accounts = (await cfApi('/accounts')).result;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || (accounts.length === 1 ? accounts[0].id : undefined);
if (!accountId) throw new Error('Select CLOUDFLARE_ACCOUNT_ID when multiple accounts are available');
const subdomain = (await cfApi(`/accounts/${accountId}/workers/subdomain`)).result.subdomain;
const apiOrigin = `https://tisona-api.${subdomain}.workers.dev`;
let state;
if (await exists('deployment.json')) state = JSON.parse(await readFile(resolve(directory, 'deployment.json')));
else {
  // Refuse to replace an existing encrypted runtime without its local recovery copy.
  const existing = JSON.parse(await command('gh', ['secret', 'list', '--repo', repo, '--json', 'name']));
  if (existing.some(s => s.name === 'TISONA_RUNTIME')) throw new Error('Restore .local/hosting before reprovisioning. Existing runtime secrets will not be replaced.');
  const teams = await nlApi('/accounts');
  const team = process.env.NETLIFY_ACCOUNT_SLUG || (teams.length === 1 ? teams[0].slug : undefined);
  if (!team) throw new Error('Select NETLIFY_ACCOUNT_SLUG when multiple teams are available');
  const sites = await nlApi('/sites?per_page=100');
  const site = sites.find(s => s.name === 'tisona-siddontang' && s.account_slug === team)
    || await nlApi(`/${team}/sites`, { method: 'POST', body: { name: 'tisona-siddontang' } });
  state = { accountId, apiOrigin, consoleOrigin: site.ssl_url || `https://${site.name}.netlify.app`, netlifySiteId: site.id };
  await save('deployment.json', state);
}
if (state.accountId !== accountId || state.apiOrigin !== apiOrigin) throw new Error('Hosting account changed. Restore the original configuration before continuing.');
let runtime;
if (await exists('runtime.json')) runtime = JSON.parse(await readFile(resolve(directory, 'runtime.json')));
else {
  let zero;
  if (await exists('zero.json')) zero = JSON.parse(await readFile(resolve(directory, 'zero.json')));
  else {
    const response = await fetch('https://zero.tidbapi.com/v1beta1/instances', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag: 'tisona-hosted-preview' }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Cloud Zero provisioning failed (HTTP ${response.status})`);
    zero = await response.json(); await save('zero.json', zero);
  }
  const connection = zero.instance.connection;
  const db = await mysql.createConnection({ host: connection.host, port: connection.port || 4000, user: connection.username, password: connection.password,
    ssl: { rejectUnauthorized: true, verifyIdentity: true }, stream: databaseStream, connectTimeout: 20000 });
  try { await db.query('CREATE DATABASE IF NOT EXISTS tisona_hosted'); } finally { await db.end(); }
  const url = new URL(zero.instance.connectionString); url.pathname = '/tisona_hosted';
  const pair = generateKeyPairSync('ed25519');
  runtime = { databaseUrl: url.toString(), databaseExpiresAt: zero.instance.expiresAt,
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    adminKey: `rc_admin_${randomBytes(32).toString('hex')}`, clientKey: `rc_client_${randomBytes(32).toString('hex')}`, workerKey: `rc_worker_${randomBytes(32).toString('hex')}`,
    publicUrl: state.apiOrigin, consoleUrl: state.consoleOrigin };
  await save('runtime.json', runtime);
}
await save('console-admin.key', runtime.adminKey + '\n');
for (const [name, value] of Object.entries({ CLOUDFLARE_API_TOKEN: cf, NETLIFY_AUTH_TOKEN: netlify, TISONA_RUNTIME: JSON.stringify(runtime) })) {
  await command('gh', ['secret', 'set', name, '--repo', repo], value);
  console.log(`GitHub encrypted secret configured: ${name}`);
}
for (const [name, value] of Object.entries({ CLOUDFLARE_ACCOUNT_ID: state.accountId, NETLIFY_SITE_ID: state.netlifySiteId, TISONA_API_ORIGIN: state.apiOrigin, TISONA_CONSOLE_ORIGIN: state.consoleOrigin })) {
  await command('gh', ['variable', 'set', name, '--repo', repo, '--body', value]);
  console.log(`GitHub deployment variable configured: ${name}`);
}
console.log(JSON.stringify({ apiOrigin: state.apiOrigin, consoleOrigin: state.consoleOrigin, databaseExpiresAt: runtime.databaseExpiresAt, credentialsFile: resolve(directory, 'console-admin.key') }));
