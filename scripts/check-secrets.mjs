import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const checkout = fileURLToPath(new URL('..', import.meta.url));
const git = (root, args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString();
export async function publicationFiles(root = checkout) {
  const files = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))];
  const forbidden = files.filter(file => {
    const name = file.split('/').at(-1).toLowerCase();
    if (['.env.example', 'deploy/service.env.example'].includes(file)) return false;
    return /(^|\/)(?:\.local|\.netlify|\.wrangler|secrets|credentials)(\/|$)/i.test(file)
      || /(?:^\.?env(?:\.|$)|\.env(?:\.|$)|\.(?:pem|key|p12|pfx|keystore|tfstate)(?:\.|$)|^id_(?:rsa|ed25519))/.test(name)
      || ['runtime.json', 'zero.json', 'resonate.toml', 'database.url', '.netrc', '.npmrc', '.cloudflare', '.netlify'].includes(name);
  });
  if (forbidden.length) throw new Error(`Private configuration cannot be published: ${forbidden.join(', ')}`);
  return files;
}
export async function checkSecrets({ root = checkout, binary = process.env.GITLEAKS_BINARY ?? 'gitleaks', history = true } = {}) {
  const files = await publicationFiles(root);
  const temp = await mkdtemp(resolve(tmpdir(), 'tisona-secret-scan-'));
  const config = resolve(checkout, '.gitleaks.toml');
  const scan = async (args, reportName, expected = 0) => {
    const report = resolve(temp, reportName + '.json');
    const result = spawnSync(binary, [...args, '--config', config, '--redact=100', '--no-banner', '--log-level=error', '--ignore-gitleaks-allow',
      '--gitleaks-ignore-path', temp, '--max-decode-depth=5', '--max-archive-depth=3', '--report-format=json', '--report-path', report], { cwd: root, encoding: 'utf8' });
    if (result.error?.code === 'ENOENT') throw new Error('Install Gitleaks 8.30.1 or set GITLEAKS_BINARY before running security:scan');
    const findings = JSON.parse(await readFile(report, 'utf8').catch(() => '[]'));
    if (result.status !== expected || (expected === 0 && findings.length)) {
      const locations = findings.map(f => `${f.RuleID}: ${f.File}:${f.StartLine}`).join('\n');
      throw new Error(`Secret scan failed (${reportName}, exit ${result.status}).${locations ? '\n' + locations : ' Check the scanner installation.'}`);
    }
    return findings;
  };
  try {
    // Prove the active scanner/config detects our credentials, without storing a real key.
    const probe = resolve(temp, 'probe'); await mkdir(probe);
    await writeFile(resolve(probe, 'credential.txt'), 'rc_admin_' + randomBytes(32).toString('hex'), { mode: 0o600 });
    const detected = await scan(['dir', probe], 'self-test', 1);
    if (!detected.some(f => f.RuleID === 'tisona-project-credential')) throw new Error('Secret scanner self-test failed');
    await scan(['git', '--staged', root], 'staged');
    if (history) await scan(['git', '--log-opts=--all --full-history', root], 'history');
    const source = resolve(temp, 'source'); await mkdir(source);
    for (const file of files) {
      const input = resolve(root, file), output = resolve(source, file);
      if (!(await lstat(input)).isFile()) throw new Error(`Publication must contain regular files only: ${file}`);
      await mkdir(dirname(output), { recursive: true }); await copyFile(input, output);
    }
    await scan(['dir', source], 'source');
    console.log(`Secret checks passed: ${files.length} public files${history ? ' and complete Git history' : ''}; scanner self-test passed.`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkSecrets().catch(error => { console.error(error.message); process.exitCode = 1; });
}
