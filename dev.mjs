import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { engineBinary, stateDir, dir, loadConfig, engineEnvironment } from './config.mjs';
import { startDatabaseRelay } from './database-relay.mjs';

const config = await loadConfig();
const relay = config.databaseRelay ? await startDatabaseRelay(config, { path: resolve(config.stateDir, 'tidb.sock') }) : null;
const children = [spawn(engineBinary, ['serve', '--config', resolve(stateDir, 'resonate.toml')], { stdio: 'inherit', env: engineEnvironment() }),
  spawn(process.execPath, ['server.mjs'], { cwd: dir, stdio: 'inherit' })];
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
