import test from 'node:test';
import assert from 'node:assert/strict';
import { examples } from '../examples/catalogue.mjs';
import { workflows } from '../examples/workflows.mjs';
import { validateFunction, validateSchema, validateInput } from '../domain.mjs';

test('every showcased scenario has a matching workflow and a valid bounded input', () => {
  assert.equal(new Set(examples.map(e => e.id)).size, 4);
  for (const example of examples) {
    const descriptor = validateFunction(example.descriptor); validateSchema(descriptor.inputSchema);
    assert.equal(typeof workflows[descriptor.name], 'function');
    for (const variant of example.variants) validateInput(variant.input, descriptor.inputSchema);
    const input = structuredClone(example.variants[0].input);
    input.unrecognized = true; assert.throws(() => validateInput(input, descriptor.inputSchema));
  }
  const schema = examples.find(e => e.id === 'document-pipeline').descriptor.inputSchema;
  assert.throws(() => validateInput({ batchId: 'huge', documentCount: 10000, delaySeconds: 1 }, schema));
});
