import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function prepareRuntime(runtime, { directory = '/tmp/tisona', release = 'local' } = {}) {
  for (const name of ['databaseUrl', 'privateKey', 'publicKey', 'adminKey', 'clientKey', 'workerKey', 'publicUrl', 'consoleUrl']) {
    if (typeof runtime?.[name] !== 'string' || !runtime[name]) throw new Error(`Missing runtime setting: ${name}`);
  }
  if (runtime.databaseExpiresAt && Date.parse(runtime.databaseExpiresAt) <= Date.now()) throw new Error('Preview database expired. Replace the runtime database secret.');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const env = { ...process.env, NODE_ENV: 'production', RESONATE_STATE_DIR: directory,
    RESONATE_BIND: process.env.RESONATE_BIND ?? '0.0.0.0', RESONATE_PORT: process.env.RESONATE_PORT ?? '8787', RESONATE_DATABASE_RELAY: 'false',
    RESONATE_PROJECT_ID: 'starter', RESONATE_PROJECT_NAME: 'Starter project',
    RESONATE_PUBLIC_URL: runtime.publicUrl, RESONATE_CONSOLE_URL: runtime.consoleUrl,
    RESONATE_DATABASE_EXPIRES_AT: runtime.databaseExpiresAt ?? '', TISONA_RELEASE: release };
  // Secrets stay in owner-only ephemeral files and never appear in CLI args.
  const files = { RESONATE_DATABASE_URL: ['database.url', runtime.databaseUrl],
    RESONATE_ENGINE_PRIVATE_KEY: ['engine-private.pem', runtime.privateKey],
    RESONATE_ENGINE_PUBLIC_KEY: ['engine-public.pem', runtime.publicKey],
    RESONATE_BOOTSTRAP_ADMIN_KEY: ['admin.key', runtime.adminKey],
    RESONATE_BOOTSTRAP_CLIENT_KEY: ['client.key', runtime.clientKey],
    RESONATE_BOOTSTRAP_WORKER_KEY: ['worker.key', runtime.workerKey] };
  for (const [name, [filename, value]] of Object.entries(files)) {
    const path = resolve(directory, filename); await writeFile(path, value, { mode: 0o600 }); await chmod(path, 0o600);
    delete env[name]; env[`${name}_FILE`] = path;
  }
  delete env.TISONA_RUNTIME;
  return env;
}

async function start() {
  const env = await prepareRuntime(JSON.parse(process.env.TISONA_RUNTIME), { directory: process.env.RESONATE_STATE_DIR ?? '/tmp/tisona', release: process.env.TISONA_RELEASE });
  delete process.env.TISONA_RUNTIME;
  const children = new Set(); let stopping = false;
  const stop = (code = 0) => {
    if (stopping) return; stopping = true;
    for (const c of children) c.kill('SIGTERM');
    const timeout = setTimeout(() => { for (const c of children) c.kill('SIGKILL'); process.exit(code); }, 12000);
    timeout.unref();
    Promise.all([...children].map(c => new Promise(done => c.once('exit', done)))).then(() => process.exit(code));
  };
  process.on('SIGTERM', () => stop()); process.on('SIGINT', () => stop());
  function launch(file, extra = {}) {
    const child = spawn(process.execPath, [file], { env: { ...env, ...extra }, stdio: 'inherit' }); children.add(child);
    child.once('error', () => { console.error('{"event":"runtime_child_failed"}'); stop(1); });
    child.once('exit', code => { children.delete(child); if (!stopping && file !== 'setup.mjs') stop(code || 1); });
    return child;
  }
  const setup = launch('setup.mjs');
  const code = await new Promise(done => setup.once('exit', done));
  if (code !== 0 || stopping) return stop(code || 1);
  launch('dev.mjs');
  for (let attempt = 0; attempt < 90 && !stopping; attempt++) {
    try {
      const localUrl = `http://127.0.0.1:${env.RESONATE_PORT}`;
      const response = await fetch(localUrl + '/health/ready', { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        launch('examples/worker.mjs', { RESONATE_URL: localUrl, RESONATE_TOKEN_FILE: env.RESONATE_BOOTSTRAP_WORKER_KEY_FILE, WORKER_ID: 'hosted-examples-v1' });
        console.log(JSON.stringify({ event: 'runtime_ready', release: env.TISONA_RELEASE })); return;
      }
      await response.body?.cancel();
    } catch { /* Engine is still starting. */ }
    await new Promise(done => setTimeout(done, 500));
  }
  stop(1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  start().catch(() => { console.error('{"event":"runtime_setup_failed"}'); process.exit(1); });
}
