import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { workerExamples, workerGuide } from '../web/worker-examples.js';
import { validateFunction, validateSchema, validateInput } from '../domain.mjs';

test('every SDK sample publishes a valid, isolated function and invokes its exact version', () => {
  const names = new Set(), groups = new Set();
  for (const example of workerExamples) {
    const guide = workerGuide(example, 'http://127.0.0.1:8787');
    const descriptor = validateFunction(guide.descriptor); validateSchema(descriptor.inputSchema);
    validateInput({ name: 'Ada' }, descriptor.inputSchema);
    assert.equal(names.has(descriptor.name), false); assert.equal(groups.has(descriptor.group), false);
    names.add(descriptor.name); groups.add(descriptor.group);
    const body = JSON.parse(guide.invoke.match(/-d '([^\n]+)'/)[1]);
    assert.equal(body.function, descriptor.name); assert.equal(body.version, descriptor.version); validateInput(body.input, descriptor.inputSchema);
    execFileSync('/bin/sh', ['-n'], { input: guide.publish });
  }
});

test('copyable environment commands preserve endpoints literally without evaluating shell syntax', () => {
  for (const endpoint of ['https://example.test', "https://example.test/a'b", 'https://example.test/$(printf INJECTED)`printf SECOND`']) {
    const guide = workerGuide(workerExamples[0], endpoint);
    const actual = execFileSync('/bin/sh', ['-c', guide.environment + '\nprintf %s "$RESONATE_URL"'], { encoding: 'utf8' });
    assert.equal(actual, endpoint);
  }
});
