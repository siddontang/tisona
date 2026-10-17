import { readFile, mkdir, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash, sign, createPrivateKey, createPublicKey } from 'node:crypto';
import { databaseStream } from './network.mjs';

export const dir = fileURLToPath(new URL('.', import.meta.url));
export const stateDir = resolve(process.env.RESONATE_STATE_DIR ?? resolve(dir, '.local'));
export const databaseSocket = resolve(stateDir, 'tidb.sock');
export const engineDir = resolve(dir, '.vendor/resonate/impl/server/core');
export const engineBinary = process.env.RESONATE_ENGINE_BINARY ?? resolve(engineDir, `target/${process.env.NODE_ENV === 'production' ? 'release' : 'debug'}/resonate`);
export const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
export const decode = value => {
  if (!value?.data) return null;
  try { return JSON.parse(Buffer.from(value.data, 'base64').toString('utf8')); }
  catch { return { encoded: value.data }; }
};
export const digest = value => createHash('sha256').update(value).digest('hex');
export const isLoopback = host => ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host);
export function testLoginEnabled(config) {
  return config.mode === 'development' && config.testAutoLogin !== false && isLoopback(config.bind)
    && isLoopback(new URL(config.publicUrl).hostname) && isLoopback(new URL(config.consoleUrl ?? config.publicUrl).hostname) && Boolean(config.adminKey);
}
// The Rust binary treats every RESONATE_* variable as engine configuration.
// Cloud-service settings are rendered into TOML, never inherited as overrides.
export const engineEnvironment = (env = process.env) => Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('RESONATE_')));

export async function privateFile(name, content) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const path = resolve(stateDir, name);
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw new Error('Invalid configuration file'); }
}
export async function secret(env, name) {
  if (env[name] && env[`${name}_FILE`]) throw new Error(`Configure either ${name} or ${name}_FILE`);
  if (env[`${name}_FILE`]) return (await readFile(env[`${name}_FILE`], 'utf8')).trim();
  return env[name];
}
export function connectionFromUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid database URL'); }
  if (url.protocol !== 'mysql:' || !url.hostname || !/^\/[A-Za-z0-9_]{1,64}$/.test(url.pathname)) throw new Error('Database URL must use mysql:// and name a database');
  const sslMode = url.searchParams.get('ssl-mode');
  if (sslMode && sslMode !== 'VERIFY_IDENTITY') throw new Error('Database TLS must verify the server identity');
  return { host: url.hostname, port: Number(url.port || 4000), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
}
export function validateConfig(config) {
  if (!/^[\w-]{1,64}$/.test(config.project)) throw new Error('Invalid project ID');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.database)) throw new Error('Invalid database name');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid service port');
  for (const name of ['publicUrl', 'engineUrl', 'engineMetricsUrl', ...(config.consoleUrl ? ['consoleUrl'] : [])]) {
    const url = new URL(config[name]);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}`);
    if (name !== 'engineMetricsUrl' && url.pathname !== '/') throw new Error(`${name} must be an origin URL`);
  }
  if (config.mode === 'production' && !config.publicUrl.startsWith('https://')) throw new Error('Production public URL requires HTTPS');
  if (config.mode === 'production' && config.consoleUrl && !config.consoleUrl.startsWith('https://')) throw new Error('Production console URL requires HTTPS');
  if (config.zero?.expiresAt && Date.parse(config.zero.expiresAt) <= Date.now()) throw new Error('Temporary database expired. Claim it or configure a persistent database.');
  return config;
}
export async function loadConfig(env = process.env) {
  const local = resolve(env.RESONATE_STATE_DIR ?? stateDir);
  const runtime = await optionalJson(env.RESONATE_CONFIG_FILE ?? resolve(local, 'runtime.json'));
  const mode = env.NODE_ENV === 'production' ? 'production' : 'development';
  const external = await secret(env, 'RESONATE_DATABASE_URL');
  if (mode === 'production' && !external) throw new Error('Production requires RESONATE_DATABASE_URL_FILE or RESONATE_DATABASE_URL');
  if (mode === 'production' && (!env.RESONATE_ENGINE_PRIVATE_KEY_FILE || !env.RESONATE_ENGINE_PUBLIC_KEY_FILE)) throw new Error('Production requires explicit engine signing key files');
  const zero = external ? null : (await optionalJson(resolve(local, 'zero.json'))).instance;
  if (!external && !zero?.connection) throw new Error('No database configured. Run setup or configure a persistent database.');
  const connection = external ? connectionFromUrl(external) : zero.connection;
  const privateKeyPath = env.RESONATE_ENGINE_PRIVATE_KEY_FILE ?? resolve(local, 'engine-private.pem');
  const publicKeyPath = env.RESONATE_ENGINE_PUBLIC_KEY_FILE ?? resolve(local, 'engine-public.pem');
  const privateKey = await readFile(privateKeyPath, 'utf8'), publicKey = await readFile(publicKeyPath, 'utf8');
  const signingKey = createPrivateKey(privateKey);
  if (signingKey.asymmetricKeyType !== 'ed25519' || !createPublicKey(signingKey).export({ type: 'spki', format: 'der' }).equals(createPublicKey(publicKey).export({ type: 'spki', format: 'der' }))) throw new Error('Engine requires a matching Ed25519 signing key pair');
  const config = { ...runtime, mode, stateDir: local, zero, connection, databaseUrl: external ?? zero.connectionString,
    database: external ? connection.database : runtime.database ?? 'resonate_mvp',
    project: env.RESONATE_PROJECT_ID ?? runtime.project ?? 'starter', projectName: env.RESONATE_PROJECT_NAME ?? runtime.projectName ?? 'Starter project',
    bind: env.RESONATE_BIND ?? runtime.bind ?? '127.0.0.1', port: Number(env.RESONATE_PORT ?? runtime.port ?? 8787),
    publicUrl: (env.RESONATE_PUBLIC_URL ?? runtime.publicUrl ?? 'http://127.0.0.1:8787').replace(/\/$/, ''),
    consoleUrl: env.RESONATE_CONSOLE_URL?.replace(/\/$/, ''),
    engineUrl: (env.RESONATE_ENGINE_URL ?? runtime.engineUrl ?? 'http://127.0.0.1:8001').replace(/\/$/, ''),
    engineMetricsUrl: env.RESONATE_ENGINE_METRICS_URL ?? 'http://127.0.0.1:9091/metrics',
    databaseRelay: env.RESONATE_DATABASE_RELAY === 'true' || mode !== 'production' && env.RESONATE_DATABASE_RELAY !== 'false',
    privateKey, publicKeyPath, testAutoLogin: env.RESONATE_TEST_AUTO_LOGIN !== 'false',
    adminKey: await secret(env, 'RESONATE_BOOTSTRAP_ADMIN_KEY') ?? (mode === 'development' ? runtime.adminKey : undefined),
    clientKey: mode === 'development' ? runtime.clientKey : undefined, workerKey: mode === 'development' ? runtime.workerKey : undefined };
  config.importLegacyFunctions = env.RESONATE_IMPORT_LEGACY_FUNCTIONS === 'true' || mode === 'development' && config.project === runtime.project;
  return validateConfig(config);
}
export function renderEngineConfig(config) {
  const connection = new URL(config.databaseUrl); connection.pathname = `/${config.database}`;
  connection.searchParams.set('ssl-mode', 'VERIFY_IDENTITY');
  if (config.databaseRelay) connection.searchParams.set('socket', resolve(config.stateDir, 'tidb.sock'));
  else connection.searchParams.delete('socket');
  const q = JSON.stringify;
  return `[servers]
active = "server_mysql"
[servers.server_mysql]
url = ${q(connection.toString())}
pool_size = 5
retry_timeout = 10000
server_url = ${q(config.publicUrl)}
wheel_refresh = 1000
sweep_interval = 5000
[gateways.gateway_http]
bind = ${q(new URL(config.engineUrl).host)}
[gateways.gateway_http.auth]
publickey = ${q(config.publicKeyPath)}
iss = "resonate-cloud-mvp"
aud = "resonate-engine"
[gateways.gateway_metrics]
enabled = true
bind = ${q(new URL(config.engineMetricsUrl).host)}
[workers.transport_http_push]
enabled = false
[workers.transport_gcps]
enabled = false
[workers.worker_bash]
enabled = false
[workers.transport_http_poll]
keepalive_interval_ms = 15000
`;
}

export function internalToken(config) {
  const head = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ role: 'admin', iss: 'resonate-cloud-mvp', aud: ['resonate-engine'], exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), config.privateKey).toString('base64url')}`;
}

export function databaseOptions(config) {
  const c = config.connection ?? config.zero.connection;
  return { host: c.host, port: c.port ?? 4000, user: c.username, password: c.password,
    database: config.database, ssl: { rejectUnauthorized: true, verifyIdentity: true }, stream: databaseStream,
    connectionLimit: 3, maxIdle: 2, idleTimeout: 60000, connectTimeout: 20000 };
}
