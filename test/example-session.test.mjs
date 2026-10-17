import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createExampleSession, exampleAvailability } from '../web/example-session.js';
import { examples } from '../examples/catalogue.mjs';

function harness(example = examples[0], restore) {
  const requests = [], timers = new Map(), saves = [], updates = [];
  const session = createExampleSession({ example, restore, changed: state => updates.push(structuredClone(state)), save: value => saves.push(structuredClone(value)),
    clock: { setTimeout(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); } },
    api(path, options) { return new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })); } });
  const snapshot = (id, extra = {}) => ({ id, function: example.descriptor.name, version: 1, state: 'pending', steps: [], waits: [], ...extra });
  return { session, requests, timers, saves, updates, snapshot, example };
}
async function start(ui, id = 'owned-run') {
  ui.session.activate(true); const pending = ui.session.start(ui.example.variants[0].input);
  ui.requests[0].resolve({ id }); await pending;
  ui.requests[1].resolve(ui.snapshot(id)); await setImmediate();
}

test('each example runs in place with a pinned version and only fresh compatible workers enable a launch', async () => {
  const ui = harness(), example = ui.example, worker = { online: true, group: example.descriptor.group, functions: [{ name: example.descriptor.name, version: 1 }] };
  assert.equal(exampleAvailability(example, [example.descriptor], [], 100, 200).available, false);
  assert.equal(exampleAvailability(example, [example.descriptor], [worker], 100, 200).available, true);
  assert.equal(exampleAvailability(example, [example.descriptor], [worker], 100, 16000).available, false);
  assert.equal(exampleAvailability(example, [example.descriptor], [{ ...worker, group: 'wrong' }], 100, 200).available, false);
  await start(ui);
  assert.equal(ui.session.state.mode, 'live'); assert.equal(ui.session.state.id, 'owned-run');
  const body = JSON.parse(ui.requests[0].options.body);
  assert.deepEqual(body, { function: example.descriptor.name, version: 1, input: example.variants[0].input });
  assert.equal(ui.requests[1].path, '/v1/executions/owned-run'); assert.equal(ui.timers.size, 1);
  assert.equal([...ui.timers.values()][0].ms, 2000);
});

test('two example cards launch independently and late responses cannot repaint another card', async () => {
  const first = harness(examples[0]), second = harness(examples[1]);
  await Promise.all([start(first, 'approval-run'), start(second, 'retry-run')]);
  assert.notEqual(first.requests[0].options.headers['Idempotency-Key'], second.requests[0].options.headers['Idempotency-Key']);
  const pending = first.session.refresh(); first.session.activate(false);
  first.requests[2].resolve(first.snapshot('approval-run', { state: 'resolved' })); await pending;
  assert.equal(first.session.state.run.state, 'pending', 'Leaving the page rejects late snapshots');
  assert.equal(second.session.state.id, 'retry-run'); assert.equal(second.session.state.stale, false);
  assert.equal(first.timers.size, 0); assert.equal(second.timers.size, 1);
});

test('a lost start response is retried with its original idempotency key and body, including after reload', async () => {
  const ui = harness(examples[1]); ui.session.activate(true);
  const initial = ui.session.start(ui.example.variants[0].input); ui.requests[0].reject(new Error('Connection lost')); await initial;
  const intent = ui.session.state.intent; assert.ok(intent); assert.match(ui.session.state.error, /Retry start/);
  const retry = harness(examples[1], ui.saves.at(-1)); retry.session.activate(true);
  const pending = retry.session.start(ui.example.variants[1].input);
  assert.equal(retry.requests[0].options.headers['Idempotency-Key'], intent.key);
  assert.equal(retry.requests[0].options.body, ui.requests[0].options.body, 'An ambiguous start cannot silently change its scenario');
  retry.requests[0].resolve({ id: 'original-accepted-run' }); await pending;
  assert.equal(retry.session.state.id, 'original-accepted-run'); assert.equal(retry.session.state.intent, undefined);
  retry.requests[1].resolve(retry.snapshot('original-accepted-run', { state: 'resolved' })); await setImmediate();
  assert.equal(retry.timers.size, 0);
});

test('approval affects only its recorded gate, is never optimistic, and final outcomes stop polling', async () => {
  const ui = harness(); await start(ui);
  ui.session.state.run.waits = [{ id: 'actual-gate' }];
  await ui.session.mutate('waits', { waitId: 'unrelated', value: { approved: true } }); assert.equal(ui.requests.length, 2);
  const decision = ui.session.mutate('waits', { waitId: 'actual-gate', value: { approved: true } });
  assert.equal(ui.session.state.run.waits.length, 1, 'Submitting does not mark the gate approved');
  assert.equal(ui.requests[2].path, '/v1/executions/owned-run/waits');
  ui.requests[2].resolve({}); await setImmediate();
  ui.requests[3].resolve(ui.snapshot('owned-run', { state: 'resolved', result: { outcome: 'refunded' } })); await decision;
  assert.equal(ui.session.state.run.result.outcome, 'refunded'); assert.equal(ui.timers.size, 0);
  assert.equal(ui.session.preview(), true); assert.equal(ui.session.state.mode, 'preview');
  ui.session.follow(); assert.equal(ui.session.state.mode, 'live'); ui.requests[4].resolve(ui.snapshot('owned-run', { state: 'resolved' })); await setImmediate();
});

test('an outage preserves the last snapshot; serialized polling and a resumed page recover it', async () => {
  const ui = harness(); await start(ui);
  const saved = ui.session.state.run, first = ui.session.refresh(); await ui.session.refresh(); assert.equal(ui.requests.length, 3);
  ui.requests[2].reject(new Error('Temporary outage')); await first;
  assert.equal(ui.session.state.run, saved); assert.equal(ui.session.state.stale, true); assert.equal(ui.timers.size, 1);
  ui.session.activate(false); assert.equal(ui.timers.size, 0);
  ui.session.activate(true); ui.requests[3].resolve(ui.snapshot('owned-run', { state: 'resolved' })); await setImmediate();
  assert.equal(ui.session.state.stale, false); assert.equal(ui.session.state.error, ''); assert.equal(ui.timers.size, 0);
});

test('restoring a saved run fetches its state without creating another execution', async () => {
  const ui = harness(examples[2], { id: 'saved-order' }); ui.session.activate(true);
  await ui.session.start(ui.example.variants[0].input); assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].path, '/v1/executions/saved-order');
  ui.requests[0].resolve(ui.snapshot('saved-order', { state: 'resolved', result: { outcome: 'compensated' } })); await setImmediate();
  assert.equal(ui.session.state.run.result.outcome, 'compensated'); assert.equal(ui.timers.size, 0);
});
