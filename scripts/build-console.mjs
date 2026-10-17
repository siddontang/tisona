import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function buildConsole({ output = resolve(root, 'dist/console'), source = resolve(root, 'web') } = {}) {
  await rm(output, { recursive: true, force: true }); await mkdir(output, { recursive: true });
  const assets = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isFile() && !entry.name.startsWith('.') && /\.(js|css|html)$/.test(entry.name));
  for (const entry of assets) await copyFile(resolve(source, entry.name), resolve(output, entry.name));
  return { assets: assets.length, output };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await buildConsole();
  console.log(`Built ${result.assets} public Console assets in ${result.output}. Start the Console and backend separately.`);
}
