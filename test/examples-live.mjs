// Runs against the already-running local service. Owns and restarts only its
// example worker. Never stops the service or changes existing executions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, privateFile, dir } from '../config.mjs';
import { examples } from '../examples/catalogue.mjs';
import { liveExecutionScene } from '../web/live-execution.js';

const config = await loadConfig();
assert.equal(config.mode, 'development', 'Use a development project for failure injection');
const workerId = `example-test-${randomUUID()}`, auditPath = resolve(config.stateDir, `${workerId}.ndjson`);
await writeFile(auditPath, '', { mode: 0o600 });
const log = await open(resolve(config.stateDir, 'examples-live.log'), 'a', 0o600);
const evidence = { startedAt: new Date().toISOString(), checks: [], executions: {} };
let worker, workerFailure;
async function api(path, { method = 'GET', body, key = randomUUID() } = {}) {
  const response = await fetch(config.publicUrl + path, { method, headers: { Authorization: `Bearer ${config.clientKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json();
}
async function waitFor(name, fn) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (workerFailure) throw workerFailure;
    const value = await fn(); if (value) return value;
    await delay(700);
  }
  throw new Error(`Timed out: ${name}`);
}
function startWorker() {
  workerFailure = undefined;
  const child = spawn(process.execPath, ['examples/worker.mjs'], { cwd: dir, env: { ...process.env, WORKER_ID: workerId, WORKER_AUDIT_FILE: auditPath }, stdio: ['ignore', log.fd, log.fd] });
  child.on('error', () => workerFailure = new Error('Example worker could not start; see the private log'));
  child.on('exit', code => { if (!child.expectedExit) workerFailure = new Error(`Example worker exited (${code}); see the private log`); });
  worker = child;
}
async function stopWorker(signal = 'SIGTERM') {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  worker.expectedExit = true; const exited = once(worker, 'exit'); worker.kill(signal);
  const timeout = setTimeout(() => worker.kill('SIGKILL'), 8000);
  try { await exited; } finally { clearTimeout(timeout); }
}
async function start(name, input, label = name) {
  const item = examples.find(e => e.descriptor.name === name);
  const run = await api('/v1/executions', { method: 'POST', body: { function: name, version: 1, input: input ?? item.variants[0].input } });
  evidence.executions[label] = run.id; return run.id;
}
const view = id => api(`/v1/executions/${id}`);
const done = id => waitFor(`completed ${id}`, async () => { const run = await view(id); if (run.state === 'pending') return; assert.equal(run.state, 'resolved', JSON.stringify(run.result)); return run; });
const approve = (id, waitId, approved) => api(`/v1/executions/${id}/waits`, { method: 'POST', body: { waitId, value: { approved } } });
function passed(check) { evidence.checks.push(check); console.log(`PASS ${check}`); }
try {
  const other = (await api('/v1/workers')).items.filter(w => w.online && w.group === 'examples-v1');
  assert.equal(other.length, 0, 'Stop existing example workers before running fault-injection checks');
  assert.equal((await api('/v1/examples')).items.length, 4);
  startWorker();
  await waitFor('example worker online', async () => (await api('/v1/workers')).items.some(w => w.id === workerId && w.online));

  const refundId = await start('support_refund');
  const waiting = await waitFor('refund approval', async () => { const run = await view(refundId); return run.waits.length ? run : undefined; });
  assert.equal(waiting.steps.some(s => s.function === 'issueRefund'), false);
  assert.ok(waiting.steps.some(s => s.function === 'checkRefundPolicy' && s.state === 'resolved'));
  assert.equal(liveExecutionScene(waiting).frames[0].nodes.approval.status, 'waiting');
  assert.equal(liveExecutionScene(waiting).frames[0].nodes.refund.status, 'idle');
  await stopWorker();
  assert.equal((await api('/v1/workers')).items.find(w => w.id === workerId).online, false);
  await approve(refundId, waiting.waits[0].id, true);
  const approvedOffline = await view(refundId);
  assert.equal(approvedOffline.state, 'pending');
  const offlineScene = liveExecutionScene(approvedOffline, { known: true, online: 0 });
  assert.equal(offlineScene.frames[0].nodes.approval.status, 'saved');
  assert.equal(offlineScene.frames[0].title, 'Waiting for a worker');
  startWorker();
  const refund = await done(refundId); assert.equal(refund.result.outcome, 'refunded');
  assert.equal(liveExecutionScene(refund).frames[0].nodes.refund.status, 'saved');
  assert.equal(refund.result.refund.idempotencyKey, `${refundId}:refund`);
  passed('Approval remains durable with the worker offline; restart resumes the approved refund');

  const declinedId = await start('support_refund', undefined, 'support_declined');
  const declinedWait = await waitFor('decline gate', async () => { const run = await view(declinedId); return run.waits.length ? run : undefined; });
  await approve(declinedId, declinedWait.waits[0].id, false);
  const declined = await done(declinedId); assert.equal(declined.result.outcome, 'declined');
  assert.equal(declined.steps.some(s => s.function === 'issueRefund' || s.function === 'publishReply'), false);
  passed('Declining a refund prevents both the refund and the reply checkpoints');

  const retryId = await start('tool_retry', { task: 'Recovery check', failTimes: 2, maxAttempts: 4, backoffSeconds: 3 });
  const backoff = await waitFor('first recorded rate limit and pending backoff', async () => { const run = await view(retryId); return run.steps.some(s => s.function === 'callMockTool' && s.result?.status === 429) && run.steps.some(s => s.tags?.['resonate:timer'] && s.state === 'pending') ? run : undefined; });
  const backoffScene = liveExecutionScene(backoff);
  assert.equal(backoffScene.frames[0].nodes.tool.status, 'failed'); assert.equal(backoffScene.frames[0].nodes.wait.status, 'waiting');
  await stopWorker('SIGKILL'); startWorker();
  const retried = await done(retryId); assert.equal(retried.result.outcome, 'recovered');
  assert.deepEqual(retried.result.attempts.map(a => a.status), [429, 429, 200]);
  const recoveredScene = liveExecutionScene(retried);
  assert.equal(recoveredScene.frames[0].nodes.plan.status, 'saved'); assert.equal(recoveredScene.frames[0].nodes.result.status, 'saved');
  assert.equal(recoveredScene.live.failedSteps, 2);
  assert.equal(recoveredScene.live.stepIds.plan, backoffScene.live.stepIds.plan, 'Recovered animation reuses the actual saved checkpoint ID');
  const audit = (await readFile(auditPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(audit.filter(e => e.execution === retryId && e.step === 'planToolCall').length, 1);
  passed('SIGKILL during backoff preserves recorded attempts and does not repeat the completed planning step');

  const exhaustedId = await start('tool_retry', { task: 'Retry budget', failTimes: 4, maxAttempts: 2, backoffSeconds: 1 }, 'tool_exhausted');
  const compensatedId = await start('order_fulfillment');
  const fulfilledId = await start('order_fulfillment', { orderId: 'LIVE-OK', amountCents: 12900, failShipment: false }, 'order_success');
  const batchId = await start('document_pipeline');
  const autoId = await start('support_refund', { ticketId: 'LIVE-AUTO', amountCents: 1900, requireApproval: false }, 'support_auto');
  const [exhausted, compensated, fulfilled, batch, automatic] = await Promise.all([exhaustedId, compensatedId, fulfilledId, batchId, autoId].map(done));
  assert.equal(exhausted.result.outcome, 'exhausted'); assert.equal(exhausted.result.attempts.length, 2);
  assert.equal(exhausted.steps.some(s => s.function === 'saveToolResult'), false);
  assert.equal(liveExecutionScene(exhausted).frames[0].nodes.result.text, 'Retry budget exhausted');
  passed('Exhausted retry budgets stop cleanly without publishing a successful result');
  assert.equal(compensated.result.outcome, 'compensated');
  assert.ok(compensated.steps.some(s => s.function === 'bookShipment' && s.state === 'rejected'));
  assert.deepEqual(compensated.result.compensation.map(c => c.status), ['refunded', 'released']);
  const compensatedScene = liveExecutionScene(compensated);
  assert.equal(compensatedScene.frames[0].nodes.shipping.status, 'failed');
  assert.equal(compensatedScene.frames[0].nodes.outcome.text, 'Compensated');
  const sagaEvents = (await readFile(auditPath, 'utf8')).trim().split('\n').map(JSON.parse).filter(e => e.execution === compensatedId);
  assert.deepEqual(sagaEvents.map(e => e.step), ['chargePayment', 'refundPayment', 'releaseStock']);
  assert.equal(fulfilled.result.outcome, 'fulfilled'); assert.equal(fulfilled.steps.some(s => s.function === 'refundPayment'), false);
  passed('Shipping failure triggers refund then stock release; the successful order has no compensation');
  assert.equal(batch.result.indexedDocuments, 3);
  const branches = batch.steps.filter(s => s.function === 'processDocument'); assert.equal(branches.length, 3);
  assert.ok(branches.every(s => s.parentId === batchId && s.state === 'resolved'));
  assert.ok(Math.max(...branches.map(s => s.createdAt)) < Math.min(...branches.map(s => s.settledAt)), 'Document branches must overlap');
  assert.equal(batch.steps.filter(s => s.function === 'indexDocument' && s.state === 'resolved').length, 3);
  const batchScene = liveExecutionScene(batch);
  assert.ok(['doc1', 'doc2', 'doc3', 'join'].every(id => batchScene.frames[0].nodes[id].status === 'saved'));
  passed('Live animation projections match real approvals, durable waits, SIGKILL recovery, compensation and parallel branch records');
  passed('Three overlapping document branches persist extraction/index checkpoints and join into one report');
  assert.equal(automatic.result.outcome, 'refunded'); assert.equal(automatic.waits.length, 0);
  passed('The policy-approved variant completes without an approval gate');
  evidence.passed = true;
} catch (error) { evidence.passed = false; evidence.failure = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  await stopWorker(); await log.close(); evidence.completedAt = new Date().toISOString();
  await privateFile('examples-live-results.json', JSON.stringify(evidence, null, 2));
}
