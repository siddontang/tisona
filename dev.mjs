import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { engineBinary, stateDir, dir, loadConfig, engineEnvironment } from './config.mjs';
import { startDatabaseRelay } from './database-relay.mjs';

const config = await loadConfig();
const relay = config.databaseRelay ? await startDatabaseRelay(config, { path: resolve(config.stateDir, 'tidb.sock') }) : null;
const children = [spawn(engineBinary, ['serve', '--config', resolve(stateDir, 'resonate.toml')], { stdio: 'inherit', env: engineEnvironment() }),
  spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: 'inherit' })];
if (!process.argv.includes('--backend-only')) {
  // The frontend process receives public connection settings, never DB/API keys.
  const env = { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV,
    TISONA_API_URL: config.publicUrl, TISONA_CONSOLE_URL: config.consoleUrl ?? 'http://127.0.0.1:8787',
    TISONA_CONSOLE_BIND: process.env.TISONA_CONSOLE_BIND ?? '127.0.0.1',
    ...(process.env.TISONA_CONSOLE_PORT ? { TISONA_CONSOLE_PORT: process.env.TISONA_CONSOLE_PORT } : {}),
    ...(process.env.TISONA_CONSOLE_DIR ? { TISONA_CONSOLE_DIR: process.env.TISONA_CONSOLE_DIR } : {}) };
  children.push(spawn(process.execPath, ['console.mjs'], { cwd: dir, env, stdio: 'inherit' }));
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 10000);
  timer.unref();
  Promise.all(children.map(c => c.exitCode !== null ? Promise.resolve() : new Promise(r => c.once('exit', r)))).then(async () => {
    await relay?.close(); process.exit(code);
  });
}
for (const child of children) {
  child.on('error', () => { console.error('Cannot start MVP. Run setup and build the Resonate server first.'); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
