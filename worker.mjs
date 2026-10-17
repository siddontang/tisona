// This process is intentionally separate from the service. Copy this pattern
// into your own worker, importing Resonate from @resonatehq/sdk/async.
import { Resonate } from '@resonatehq/sdk/async';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadConfig, secret } from './config.mjs';
import { registerWorker } from './worker-presence.mjs';

const suppliedToken = await secret(process.env, 'RESONATE_TOKEN');
if (Boolean(process.env.RESONATE_URL) !== Boolean(suppliedToken)) {
  throw new Error('Set both RESONATE_URL and RESONATE_TOKEN, or neither to use the local project.');
}
const config = process.env.RESONATE_URL ? null : await loadConfig();
const url = process.env.RESONATE_URL ?? config.publicUrl;
const token = suppliedToken ?? config.workerKey;
if (!token) throw new Error('Create a worker API key and supply RESONATE_URL and RESONATE_TOKEN_FILE');
const version = Number(process.env.WORKER_VERSION ?? 1);
if (!Number.isInteger(version) || version < 1 || version > 2147483647) throw new Error('Invalid worker function version');
const group = process.env.WORKER_GROUP ?? (version === 1 ? 'default' : `research-v${version}`);
const id = process.env.WORKER_ID ?? randomUUID();
const descriptor = {
  name: 'research', version, group,
  description: 'A deterministic demonstration of planning, durable sleep, approval, and a report. No model account required.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['topic'], properties: {
    topic: { type: 'string', minLength: 1, maxLength: 500 },
    delaySeconds: { type: 'integer', minimum: 0, maximum: 120 },
    requireApproval: { type: 'boolean' }
  } }
};

async function plan(info, topic) {
  // Test-only evidence: a completed checkpoint must not run again after
  // server/worker restarts. Real side effects still require idempotency.
  if (process.env.WORKER_AUDIT_FILE) await appendFile(process.env.WORKER_AUDIT_FILE, JSON.stringify({ step: 'plan', execution: info.originId }) + '\n');
  return { topic, questions: [`What is ${topic}?`, `How can ${topic} be used?`] };
}
async function report(_info, planned) {
  return { topic: planned.topic, summary: `Completed durable research on ${planned.topic}.`, questions: planned.questions, approved: true };
}
async function research(ctx, input) {
  const planned = await ctx.run(plan, input.topic);
  await ctx.sleep((input.delaySeconds ?? 2) * 1000);
  if (input.requireApproval) {
    const approval = ctx.promise({ tags: { 'cloud:wait': 'approval' } });
    const decision = await approval;
    if (!decision.approved) return { topic: input.topic, approved: false, summary: 'Review declined.' };
  }
  return await ctx.run(report, planned);
}

const worker = new Resonate({ url, token, pid: id, group, ttl: 60000 });
worker.register('research', research, { version });
let presence;
try { presence = await registerWorker({ url, token, id, group, functions: [descriptor], onAuthError: async () => { await worker.stop(); process.exit(1); } }); }
catch (error) { await worker.stop(); throw error; }
console.log(`Worker connected to ${url}; function research v${version} registered; group=${group}; id=${id}.`);
const stop = async () => { await presence.stop(); await worker.stop(); process.exit(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
