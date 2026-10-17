import test from 'node:test';
import assert from 'node:assert/strict';
import { examples } from '../examples/catalogue.mjs';
import { overviewStory, exampleStory } from '../web/walkthrough-data.js';

test('all scenario presets have complete, independently seekable walkthrough states and valid connections', () => {
  const stories = [overviewStory(), ...examples.flatMap(e => e.variants.map(v => exampleStory(e.id, v.input)))];
  for (const story of stories) {
    const ids = new Set(story.nodes.map(n => n.id)); assert.equal(ids.size, story.nodes.length);
    for (const [from, to] of story.edges) { assert.ok(ids.has(from)); assert.ok(ids.has(to)); }
    for (const frame of story.frames) {
      for (const [id, value] of Object.entries(frame.nodes)) { assert.ok(ids.has(id)); assert.ok(['idle', 'active', 'saved', 'waiting', 'failed'].includes(value.status)); }
      for (const index of [...frame.activeEdges, ...frame.doneEdges]) assert.ok(index >= 0 && index < story.edges.length);
      assert.ok(frame.title && frame.caption);
    }
  }
  const first = overviewStory(), again = overviewStory();
  assert.deepEqual([first.frames[5], first.frames[2], first.frames[0]], [again.frames[5], again.frames[2], again.frames[0]]);
});

test('recovery retains the planning checkpoint while the worker is unavailable', () => {
  const story = overviewStory(), failure = story.frames.findIndex(f => f.nodes.worker?.status === 'failed');
  assert.ok(failure > 0);
  for (const frame of story.frames.slice(1)) { assert.ok(frame.saved.includes('Plan saved') || frame.saved.includes('Plan reused')); assert.equal(frame.nodes.state.status, 'saved'); }
  assert.equal(story.frames[failure].nodes.agent.status, 'waiting');
});

test('illustrations respect the selected approval, retry and order business branches', () => {
  const approval = exampleStory('support-refund');
  const waiting = approval.frames.find(f => f.nodes.approval?.status === 'waiting');
  assert.ok(waiting); assert.notEqual(waiting.nodes.refund?.status, 'saved');
  assert.equal(exampleStory('support-refund', { requireApproval: false }).frames.some(f => f.nodes.approval?.status === 'waiting'), false);
  const exhausted = exampleStory('tool-retry', { failTimes: 4, maxAttempts: 3, backoffSeconds: 1 });
  assert.equal(exhausted.frames.at(-1).nodes.result.text, 'Retry budget exhausted');
  assert.equal(exhausted.frames.some(f => f.nodes.result?.text === 'Result saved'), false);
  const saga = exampleStory('order-saga');
  assert.ok(saga.frames.findIndex(f => f.title === 'Shipping fails') < saga.frames.findIndex(f => f.title === 'Compensate the charge'));
  assert.ok(saga.frames.findIndex(f => f.title === 'Compensate the charge') < saga.frames.findIndex(f => f.title === 'Release inventory'));
  assert.equal(exampleStory('order-saga', { failShipment: false }).frames.at(-1).nodes.outcome.text, 'Fulfilled');
});

test('parallel examples join only after every document branch has a saved result', () => {
  for (const count of [2, 3, 4]) {
    const story = exampleStory('document-pipeline', { documentCount: count });
    assert.equal(story.frames[0].activeEdges.length, count, 'Every document branch starts in the same frame');
    for (const frame of story.frames) if (frame.nodes.join?.status === 'saved') {
      for (let i = 1; i <= count; i++) assert.equal(frame.nodes[`doc${i}`].status, 'saved');
    }
  }
});
