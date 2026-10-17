import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicationFiles } from '../scripts/check-secrets.mjs';

test('publication excludes ignored local configuration and rejects forced staging of private configuration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tisona-publication-')); t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '--quiet']);
  await writeFile(join(root, '.gitignore'), await readFile(new URL('../.gitignore', import.meta.url)));
  await mkdir(join(root, '.local'));
  const privateFiles = ['.env', '.env.production', 'runtime.json', 'private.key', '.local/runtime.json'];
  for (const name of ['app.js', '.env.example', ...privateFiles]) await writeFile(join(root, name), 'test fixture');
  git(['add', 'app.js', '.gitignore', '.env.example']);
  assert.deepEqual((await publicationFiles(root)).sort(), ['.env.example', '.gitignore', 'app.js']);
  for (const name of privateFiles) {
    git(['add', '-f', name]);
    await assert.rejects(publicationFiles(root), /Private configuration cannot be published/);
    git(['rm', '--cached', name]);
  }
});
