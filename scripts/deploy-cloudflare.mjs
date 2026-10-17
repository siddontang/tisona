import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

if (!process.env.TISONA_RUNTIME || !/^[a-f0-9]{40}$/.test(process.env.TISONA_RELEASE || '')) throw new Error('Missing encrypted runtime or commit identity');
// Secret material is outside the Docker context and is removed on completion.
const directory = await mkdtemp(join(tmpdir(), 'tisona-release-'));
try {
  const path = join(directory, 'secrets.json');
  await writeFile(path, JSON.stringify({ TISONA_RUNTIME: process.env.TISONA_RUNTIME }), { mode: 0o600 });
  const env = { ...process.env }; delete env.TISONA_RUNTIME;
  const child = spawn('./node_modules/.bin/wrangler', ['deploy', '--secrets-file', path, '--var', `RELEASE:${process.env.TISONA_RELEASE}`], { env, stdio: 'inherit' });
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
  if (code) process.exitCode = code;
} finally { await rm(directory, { recursive: true, force: true }); }
