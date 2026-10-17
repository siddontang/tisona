import { Resonate } from '@resonatehq/sdk/async';
import { randomUUID } from 'node:crypto';
import { loadConfig, secret } from '../config.mjs';
import { registerWorker } from '../worker-presence.mjs';
import { examples } from './catalogue.mjs';
import { workflows } from './workflows.mjs';

const suppliedToken = await secret(process.env, 'RESONATE_TOKEN');
if (Boolean(process.env.RESONATE_URL) !== Boolean(suppliedToken)) throw new Error('Set both RESONATE_URL and RESONATE_TOKEN[_FILE]');
const config = process.env.RESONATE_URL ? null : await loadConfig();
const url = process.env.RESONATE_URL ?? config.publicUrl, token = suppliedToken ?? config.workerKey;
if (!token) throw new Error('Supply a worker credential');
const id = process.env.WORKER_ID ?? `examples-${randomUUID()}`;
const worker = new Resonate({ url, token, pid: id, group: 'examples-v1', ttl: 15000 });
for (const example of examples) worker.register(example.descriptor.name, workflows[example.descriptor.name], { version: example.descriptor.version });
let presence;
try {
  presence = await registerWorker({ url, token, id, group: 'examples-v1', functions: examples.map(e => e.descriptor),
    onAuthError: async () => { await worker.stop(); process.exit(1); } });
} catch (error) { await worker.stop(); throw error; }
console.log(`Example worker connected: ${examples.length} workflows; group=examples-v1; id=${id}`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await presence.stop(); await worker.stop(); process.exit(); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
