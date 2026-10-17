import { access } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { stateDir, privateFile } from './config.mjs';
import { resolve } from 'node:path';

async function exists(name) { try { await access(resolve(stateDir, name)); return true; } catch { return false; } }
const privateExists = await exists('engine-private.pem'), publicExists = await exists('engine-public.pem');
if (privateExists !== publicExists) throw new Error('Incomplete signing key pair. Restore the missing file before continuing.');
if (!privateExists) {
  const keys = generateKeyPairSync('ed25519');
  await privateFile('engine-private.pem', keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await privateFile('engine-public.pem', keys.publicKey.export({ format: 'pem', type: 'spki' }));
}
if (!await exists('bootstrap-admin.key')) await privateFile('bootstrap-admin.key', `rc_admin_${randomBytes(32).toString('hex')}\n`);
console.log('Signing keys and a bootstrap administrator key are ready in the private state directory. Existing files were preserved. Bootstrap applies only to a new project.');
