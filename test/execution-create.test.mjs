import test from 'node:test';
import assert from 'node:assert/strict';
import { examples } from '../examples/catalogue.mjs';
import { validateInput } from '../domain.mjs';
import { initialInput, inputErrors, compatibleWorkers, createStartRequest } from '../web/execution-input.js';

test('each function receives its own schema-valid sample; new versions use their own schema defaults', () => {
  for (const example of examples) {
    const value = initialInput(example.descriptor, examples);
    assert.doesNotThrow(() => validateInput(value, example.descriptor.inputSchema));
    assert.deepEqual(inputErrors(value, example.descriptor.inputSchema), []);
    value.changed = true;
    assert.equal(example.variants[0].input.changed, undefined, 'Drafts must never modify the sample catalogue');
  }
  const v2 = { ...examples[0].descriptor, version: 2, inputSchema: { type: 'object', additionalProperties: false, properties: { ticket: { type: 'string', default: 'NEW' } } } };
  assert.deepEqual(initialInput(v2, examples), { ticket: 'NEW' });
  const research = { name: 'research', inputSchema: v2.inputSchema };
  assert.deepEqual(initialInput(research), { ticket: 'NEW' });
});

test('creation validates missing fields, types, constraints, arrays and unknown properties before sending', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['amount', 'items'], properties: {
    amount: { type: 'integer', minimum: 1, maximum: 100 }, items: { type: 'array', items: { type: 'string', minLength: 2, maxLength: 4 } }, choice: { type: 'string', enum: ['a', 'b'] }
  } };
  for (const value of [null, [], {}, { amount: 0, items: [] }, { amount: 101, items: [] }, { amount: 1.1, items: [] }, { amount: '12', items: [] }, { amount: 1, items: ['x'] }, { amount: 1, items: ['abcde'] }, { amount: 1, items: [], extra: true }, { amount: 1, items: [], choice: 'c' }]) {
    assert.throws(() => validateInput(value, schema)); assert.ok(inputErrors(value, schema).length, JSON.stringify(value));
  }
  const valid = { amount: 25, items: ['abc'], choice: 'b' };
  assert.doesNotThrow(() => validateInput(valid, schema)); assert.deepEqual(inputErrors(valid, schema), []);
});

test('worker readiness matches name, version, group and freshness rather than total worker count', () => {
  const d = { name: 'hello', version: 2, group: 'hello-v2' }, now = 100000;
  const good = { online: true, group: d.group, functions: [{ name: d.name, version: 2 }], expiresAt: now + 1000 };
  const workers = [good, { ...good, group: 'default' }, { ...good, functions: [{ name: 'hello', version: 1 }] }, { ...good, online: false }, { ...good, expiresAt: now }];
  assert.deepEqual(compatibleWorkers(d, workers, now, now), { known: true, online: 1 });
  assert.deepEqual(compatibleWorkers(d, workers, now - 15000, now), { known: false, online: 0 });
  assert.deepEqual(compatibleWorkers(d, workers, undefined, now), { known: false, online: 0 });
});

test('ambiguous creation is locked and survives reload with the same body, version and idempotency key', async () => {
  const calls = []; let stored, release;
  const body = { function: 'hello', version: 2, input: { message: 'Original' }, timeoutMs: 3600000 };
  const first = createStartRequest({ api: async (path, options) => { calls.push(options); return new Promise((resolve, reject) => { release = () => reject(new Error('Lost response')); }); }, uuid: () => 'fixed-key', save: intent => { stored = structuredClone(intent); } });
  const attempt = first.start(body);
  await first.start({ ...body, version: 3 });
  assert.equal(calls.length, 1); assert.equal(first.reset(), false);
  body.input.message = 'Edited after send'; release(); await attempt;
  assert.equal(first.state.intent.body.input.message, 'Original'); assert.equal(first.reset(), false);
  const restored = createStartRequest({ restore: stored, api: async (path, options) => { calls.push(options); return { id: 'one-run', state: 'pending' }; }, save: intent => { stored = intent; } });
  await restored.start({ ...body, version: 99 });
  assert.equal(calls[1].body, calls[0].body); assert.equal(calls[1].headers['Idempotency-Key'], 'fixed-key');
  assert.equal(restored.state.result.id, 'one-run'); assert.equal(stored, undefined);
  await restored.start(body); assert.equal(calls.length, 2, 'A receipt must not resubmit');
});

test('definitive validation failure allows edits; server errors and rate limits retain the original start', async () => {
  for (const status of [400, 401, 403, 409, 408, 429, 503]) {
    const request = createStartRequest({ api: async () => { const e = new Error('Failure'); e.status = status; throw e; }, uuid: () => 'key' });
    await request.start({ function: 'hello', version: 1, input: {} });
    assert.equal(Boolean(request.state.intent), [408, 429, 503].includes(status)); assert.equal(request.state.busy, false);
  }
});
