import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dir, engineDir } from '../config.mjs';

const source = JSON.parse(await readFile(new URL('../engine-source.json', import.meta.url), 'utf8'));
const checkout = resolve(dir, '.vendor/resonate');
async function run(command, args, cwd = checkout, capture = false) {
  const child = spawn(command, args, { cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
  let output = ''; if (capture) child.stdout.on('data', value => { output += value; });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code !== 0) throw new Error(`${command} failed (${code})`);
  return output.trim();
}
await mkdir(checkout, { recursive: true });
try { await access(resolve(checkout, '.git')); }
catch {
  await run('git', ['init', '--quiet']);
  await run('git', ['remote', 'add', 'origin', source.repository]);
}
if (await run('git', ['remote', 'get-url', 'origin'], checkout, true) !== source.repository) throw new Error('Unexpected engine source origin');
if (await run('git', ['status', '--porcelain'], checkout, true)) throw new Error('Engine source has local changes; preserve them before rebuilding');
await run('git', ['sparse-checkout', 'set', source.path]);
await run('git', ['fetch', '--depth=1', 'origin', source.revision]);
await run('git', ['checkout', '--detach', source.revision]);
if (await run('git', ['rev-parse', 'HEAD'], checkout, true) !== source.revision) throw new Error('Engine revision verification failed');
await run('cargo', ['build', '--locked', '--bin', 'resonate', ...(process.env.NODE_ENV === 'production' || process.argv.includes('--release') ? ['--release'] : [])], engineDir);
