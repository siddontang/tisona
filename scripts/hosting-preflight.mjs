import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export async function hostingPreflight(env = process.env, fetchImpl = fetch) {
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Configure Cloudflare deployment credentials first.');
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(20000)
  });
  const data = await response.json();
  if (!response.ok || data.success === false) {
    if (JSON.stringify(data.errors).includes('Workers Paid')) throw new Error('Cloudflare Containers requires Workers Paid. Enable it in the account dashboard, then rerun this deployment. No Console release was published.');
    throw new Error(`Cloudflare Containers access failed (HTTP ${response.status}). Check account ID and token permissions. No Console release was published.`);
  }
  console.log('Cloudflare Containers deployment access verified.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  hostingPreflight().catch(error => { console.error(error.message); process.exitCode = 1; });
}
