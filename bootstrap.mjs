import { spawn } from 'node:child_process';
import { dir } from './config.mjs';

async function run(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error(`${command} failed (${code})`);
}
await run(process.execPath, ['scripts/engine.mjs'], dir);
await run(process.execPath, ['setup.mjs'], dir);
