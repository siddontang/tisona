import test from 'node:test';
import assert from 'node:assert/strict';
import { liveExecutionScene } from '../web/live-execution.js';

const step = (id, fn, state = 'resolved', extra = {}) => ({ id, function: fn, state, parentId: 'run', createdAt: Number(id.replace(/\D/g, '')) || 1, ...extra });
const run = (fn, steps = [], extra = {}) => ({ id: 'run', function: fn, version: 1, state: 'pending', input: {}, steps, ...extra });
const frame = scene => scene.frames[0];
const timer = (id, state = 'pending', parentId = 'run') => step(id, undefined, state, { parentId, tags: { 'resonate:timer': 'true' } });

test('live approval uses recorded decisions and never invents downstream checkpoints', () => {
  const waiting = run('support_refund', [step('1', 'loadTicket'), step('2', 'checkRefundPolicy'), step('3', undefined, 'pending', { tags: { 'cloud:wait': 'approval' } })]);
  const scene = liveExecutionScene(waiting);
  assert.equal(frame(scene).nodes.approval.status, 'waiting'); assert.equal(frame(scene).nodes.refund.status, 'idle');
  assert.equal(scene.live.stepIds.approval, '3'); assert.equal(frame(scene).title, 'Waiting for approval');
  waiting.steps[2] = { ...waiting.steps[2], state: 'resolved', result: { approved: false } }; waiting.state = 'resolved'; waiting.result = { outcome: 'declined' };
  const declined = liveExecutionScene(waiting);
  assert.equal(frame(declined).nodes.approval.text, 'Declined · saved'); assert.equal(frame(declined).nodes.refund.text, 'Not run');
  assert.equal(frame(declined).nodes.refund.status, 'idle');
  const auto = liveExecutionScene(run('support_refund', [], { input: { requireApproval: false } }));
  assert.equal(frame(auto).nodes.approval.text, 'Not required by this preset');
});

test('live retries retain 429 responses after recovery and distinguish timers from failures', () => {
  const steps = [step('1', 'planToolCall'), step('2', 'callMockTool', 'resolved', { result: { ok: false, status: 429, attempt: 1 } }), timer('3')];
  const waiting = liveExecutionScene(run('tool_retry', steps));
  assert.equal(frame(waiting).nodes.tool.status, 'failed'); assert.equal(frame(waiting).nodes.wait.status, 'waiting');
  assert.equal(frame(waiting).nodes.result.status, 'idle'); assert.deepEqual(frame(waiting).activeEdges, [1]);
  assert.equal(waiting.live.failedSteps, 1); assert.ok(frame(waiting).saved.some(s => s.includes('429')));
  const completed = liveExecutionScene(run('tool_retry', [{ ...steps[0] }, { ...steps[1] }, timer('3', 'rejected_timedout'),
    step('4', 'callMockTool', 'resolved', { result: { ok: true, status: 200, attempt: 2 } }), step('5', 'saveToolResult')], { state: 'resolved', result: { outcome: 'recovered', summary: 'Recovered on attempt two.' } }));
  assert.equal(frame(completed).nodes.tool.status, 'saved'); assert.equal(frame(completed).nodes.wait.status, 'saved');
  assert.equal(completed.live.failedSteps, 1); assert.equal(completed.live.records.find(s => s.id === '2').status, 'failed');
  assert.equal(frame(completed).caption, 'Recovered on attempt two.'); assert.deepEqual(frame(completed).activeEdges, []);
});

test('exhaustion is a business outcome and does not invent a successful result', () => {
  const scene = liveExecutionScene(run('tool_retry', [step('1', 'planToolCall'), step('2', 'callMockTool', 'resolved', { result: { ok: false, status: 429 } })], { state: 'resolved', result: { outcome: 'exhausted' } }));
  assert.equal(frame(scene).title, 'Execution completed'); assert.equal(frame(scene).nodes.result.status, 'failed');
  assert.equal(scene.live.stepIds.result, undefined);
});

test('compensation arrows require recorded recovery actions and retain the failed shipment', () => {
  const steps = [step('1', 'reserveStock'), step('2', 'chargePayment'), step('3', 'bookShipment', 'rejected')];
  const failed = liveExecutionScene(run('order_fulfillment', steps));
  assert.equal(frame(failed).nodes.shipping.status, 'failed'); assert.ok(!frame(failed).activeEdges.includes(3)); assert.ok(!frame(failed).doneEdges.includes(4));
  const recovered = liveExecutionScene(run('order_fulfillment', [...steps, step('4', 'refundPayment'), step('5', 'releaseStock')], { state: 'resolved', result: { outcome: 'compensated' } }));
  assert.equal(frame(recovered).nodes.shipping.status, 'failed'); assert.equal(frame(recovered).nodes.payment.text, 'Payment refunded · saved');
  assert.equal(frame(recovered).nodes.stock.text, 'Stock released · saved'); assert.equal(frame(recovered).nodes.outcome.text, 'Compensated');
  assert.ok(frame(recovered).doneEdges.includes(3)); assert.ok(frame(recovered).doneEdges.includes(4));
});

test('parallel live state follows each branch lineage; an elapsed child timer does not complete a branch', () => {
  const scene = liveExecutionScene(run('document_pipeline', [step('1', 'prepareBatch'), step('2', 'processDocument'), step('3', 'processDocument', 'pending'),
    timer('4', 'rejected_timedout', '3'), step('5', 'extractFields', 'resolved', { parentId: '3' }), step('6', 'processDocument', 'pending'), timer('7', 'pending', '6')], { input: { documentCount: 3 } }));
  assert.equal(frame(scene).nodes.doc1.status, 'saved'); assert.equal(frame(scene).nodes.doc2.status, 'active');
  assert.equal(frame(scene).nodes.doc3.status, 'waiting'); assert.equal(frame(scene).nodes.join.status, 'idle');
  assert.equal(scene.live.stepIds.doc3, '7'); assert.equal(scene.live.failedSteps, 0);
});

test('worker heartbeats and task resumes never fabricate a crash or replay', () => {
  const value = run('tool_retry', [step('1', 'planToolCall'), step('2', 'callMockTool', 'pending')], { tasks: [{ id: 'run', state: 'acquired', resumes: 10 }] });
  const unknown = liveExecutionScene(value);
  assert.equal(frame(unknown).nodes.tool.status, 'active'); assert.equal(unknown.live.taskState, 'acquired');
  const offline = liveExecutionScene(value, { known: true, online: 0 });
  assert.equal(frame(offline).title, 'Waiting for a worker'); assert.equal(frame(offline).nodes.plan.status, 'saved');
  assert.equal(frame(offline).nodes.tool.status, 'waiting'); assert.equal(offline.live.failedSteps, 0);
  assert.deepEqual(liveExecutionScene(value), unknown, 'Projection is deterministic and has no client-side time progression');
});

test('cancellation, partial views and unsupported functions cannot look successfully completed', () => {
  const canceled = liveExecutionScene(run('tool_retry', [step('1', 'planToolCall'), step('2', 'callMockTool', 'pending')], { state: 'rejected_canceled' }));
  assert.equal(frame(canceled).title, 'Execution canceled'); assert.equal(frame(canceled).nodes.tool.status, 'waiting'); assert.deepEqual(frame(canceled).activeEdges, []);
  const partial = liveExecutionScene(run('document_pipeline', [], { truncated: true, input: { documentCount: 1e9 } }));
  assert.equal(partial.nodes.length, 6); assert.equal(partial.live.truncated, true); assert.equal(frame(partial).nodes.batch.text, 'Not in this view');
  assert.equal(liveExecutionScene(run('customer_function')), null);
});
