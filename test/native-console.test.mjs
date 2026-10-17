import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import vm from 'node:vm';
import { examples } from '../examples/catalogue.mjs';
import { MemoryStore } from './support/memory-store.mjs';
import { createApp } from '../server.mjs';

test('native Console API exposes lineage and payloads, validates global filters, and redirects old bookmarks', async t => {
  const value = data => ({ headers: {}, data: Buffer.from(JSON.stringify(data)).toString('base64') });
  const root = { id: 'starter-run', state: 'pending', tags: { 'resonate:target': 'poll://any@research-v1' }, param: value({ func: 'research', args: [{ topic: 'Native UI' }] }), value: {}, createdAt: 1000, timeoutAt: 9000 };
  const nodes = [{ ...root, func: 'research', parentId: null, taskId: root.id, tags: {} },
    { id: 'starter-run.plan', func: 'plan', parentId: root.id, taskId: null, state: 'resolved', param: value({ args: ['Native UI'] }), value: value({ questions: ['Why?'] }), tags: {}, createdAt: 2000, settledAt: 3000, timeoutAt: 9000 },
    { id: 'starter-run.approval', parentId: root.id, state: 'pending', tags: { 'cloud:wait': 'approval' }, param: {}, value: {}, createdAt: 4000 },
    { id: 'starter-run.local', func: 'local', parentId: root.id, state: 'resolved', tags: {}, param: value({ func: 'local', version: 1 }), value: value(true), createdAt: 2000 }];
  const tasks = [{ id: root.id, state: 'suspended', resumes: 1 }];
  const received = [];
  const backend = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw); received.push(input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ head: { status: 200 }, data: input.kind === 'ui.execution.get' ? { root, nodes, tasks, truncated: false } : { items: [], cursor: 'older', total: 30 } }));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const config = { project: 'starter', projectName: 'Test', adminKey: 'admin', clientKey: 'client', workerKey: 'worker',
    engineUrl: `http://127.0.0.1:${backend.address().port}`, publicUrl: 'http://127.0.0.1', zero: {}, privateKey: generateKeyPairSync('ed25519').privateKey };
  const app = createApp(config, {}, { store: new MemoryStore(config) }); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  config.publicUrl = `http://127.0.0.1:${app.address().port}`;
  t.after(() => { app.closeAllConnections(); app.close(); backend.closeAllConnections(); backend.close(); });
  const request = (path, options = {}) => fetch(config.publicUrl + path, { headers: { Authorization: 'Bearer client' }, ...options });
  const list = await request('/v1/executions?limit=25&state=pending&func=research&idPrefix=starter-&createdFrom=1000&createdTo=9000&cursor=older');
  assert.equal(list.status, 200);
  assert.deepEqual(received[0].data, { limit: 25, sort: 'createdAt:desc', countTotal: true, cursor: 'older', state: ['pending'], func: 'research', idPrefix: 'starter-', createdFrom: 1000, createdTo: 9000 });
  for (const query of ['limit=0', 'limit=1.5', 'limit=101', 'state=unknown', 'createdFrom=NaN', 'createdTo=-1', 'func=bad/name']) {
    assert.equal((await request(`/v1/executions?${query}`)).status, 400, query);
  }
  assert.equal(received.length, 1, 'Invalid filters must not reach the engine');
  const detail = await request('/v1/executions/starter-run'); const run = await detail.json();
  assert.equal(detail.status, 200); assert.deepEqual(run.input, { topic: 'Native UI' }); assert.equal(run.function, 'research');
  assert.equal(run.workerGroup, 'research-v1');
  assert.deepEqual(run.steps[1].input, ['Native UI']); assert.deepEqual(run.steps[1].result, { questions: ['Why?'] });
  assert.equal(run.steps[1].parentId, root.id); assert.equal(run.steps[1].settledAt, 3000);
  assert.equal(run.steps[1].inputKind, 'input'); assert.equal(run.steps[3].inputKind, 'metadata');
  assert.equal(run.waits[0].id, nodes[2].id); assert.deepEqual(run.tasks, tasks);
  assert.equal(run.consoleUrl, config.publicUrl + '/#executions/starter-run');
  const legacy = await request('/console/executions/starter-run', { redirect: 'manual' });
  assert.equal(legacy.status, 302); assert.equal(legacy.headers.get('location'), '/#executions/starter-run');
  assert.equal((await request('/console/rpc', { method: 'POST', body: '{}' })).status, 404);
  const html = await request('/'); assert.match(html.headers.get('content-security-policy'), /frame-src 'none'/);
  assert.doesNotMatch(await html.text(), /<iframe|\/console\//);
  assert.equal((await request('/executions.css')).status, 200);
  for (const path of ['/walkthrough.js', '/walkthrough-data.js', '/live-execution.js', '/walkthrough.css', '/example-studio.js', '/example-session.js', '/studio.css', '/theme.css', '/theme.js', '/execution-create.js', '/execution-input.js', '/execution-create.css', '/worker-guide.js', '/worker-examples.js']) assert.equal((await request(path)).status, 200);
});

async function webHarness() {
  const elements = new Map(), requests = [], timers = new Map(), live = [], events = {};
  function element() {
    return { textContent: '', className: '', children: [], hidden: false, value: '',
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); },
      setAttribute(name, value) { this[name] = value; },
      set innerHTML(_) { throw new Error('Untrusted output must never be rendered as HTML'); } };
  }
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  const context = vm.createContext({
    document: { hidden: false, querySelector: get, querySelectorAll: () => [], createElement: element, addEventListener: (name, fn) => { events[name] = fn; } },
    window: { addEventListener() {}, scrollTo() {}, resonateWalkthrough: { setView() {}, setExamples() {}, clearExecution() { live.push(['clear']); }, setExecution(run, options) { live.push(['snapshot', run, options]); }, executionStale(id) { live.push(['stale', id]); } } }, location: { hash: '#executions' }, AbortController, AbortSignal, URLSearchParams, crypto: { randomUUID: () => 'example-request' },
    fetch: (path, options) => new Promise(resolve => requests.push({ path, options, reply: (data, status = 200) => resolve({ ok: status === 200, status, json: async () => data }) })),
    setInterval() {}, clearInterval() {}, setTimeout(fn, ms) { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); }
  });
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\ninit\(\)\.catch\([^\n]+\);\s*$/, '\n');
  vm.runInContext(source, context); vm.runInContext("tab('executions')", context);
  return { get, requests, timers, live, events, run: source => vm.runInContext(source, context) };
}

test('a fresh Console enters the local test project without a key and respects disabled automatic login', async () => {
  for (const enabled of [true, false]) {
    const ui = await webHarness(); ui.run("location.hash = ''");
    const opening = ui.run('init()');
    ui.requests[0].reply({ error: 'Sign in' }, 401); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.requests[1].path, '/session'); ui.requests[1].reply({ testLoginEnabled: enabled });
    await new Promise(resolve => setImmediate(resolve));
    if (enabled) {
      assert.equal(ui.requests[2].options.method, 'POST'); assert.deepEqual(JSON.parse(ui.requests[2].options.body), { test: true });
      ui.requests[2].reply({ signedIn: true }); await new Promise(resolve => setImmediate(resolve));
      assert.equal(ui.requests[3].path, '/v1/project'); ui.requests[3].reply({ name: 'Test', endpoint: 'http://127.0.0.1' });
      await new Promise(resolve => setImmediate(resolve));
      for (const request of ui.requests.slice(4)) request.reply({ items: [] });
    } else assert.equal(ui.requests.length, 2, 'Production must never attempt keyless sign-in');
    await opening;
    assert.equal(ui.get('#login').hidden, enabled); assert.equal(ui.get('#shell').hidden, !enabled);
  }
});

test('execution feedback stays on its run and clears when navigating to another run or Examples', async () => {
  const ui = await webHarness();
  ui.run("selectedId = 'approved-run'; location.hash = '#executions/approved-run'; notice('Approval submitted.'); route(false)");
  assert.equal(ui.get('#notice').textContent, 'Approval submitted.', 'Refreshing the same route retains feedback');
  ui.run("location.hash = '#executions/another-run'; route(false)");
  assert.equal(ui.get('#notice').className, 'notice'); assert.equal(ui.get('#notice').textContent, '');
  ui.run("notice('Approval submitted.'); location.hash = '#examples'; route(false)");
  assert.equal(ui.get('#notice').textContent, '');
  ui.run("location.hash = '#executions/approved-run'; route(false)");
  assert.equal(ui.get('#notice').textContent, '', 'Returning must not resurrect old feedback');
});

test('an approval response arriving after navigation does not post feedback on Examples', async () => {
  for (const status of [200, 503]) {
    const ui = await webHarness();
    ui.run("selectedId = 'approved-run'; execution = { id: selectedId, function: 'research', state: 'pending', steps: [], waits: [] }");
    const operation = ui.run("mutateExecution('waits', { waitId: 'approval', value: { approved: true } }, 'Approval submitted.')");
    ui.run("location.hash = '#examples'; route(false)");
    ui.requests[0].reply(status === 200 ? {} : { error: 'Service unavailable' }, status);
    await new Promise(resolve => setImmediate(resolve));
    for (const request of ui.requests.slice(1)) request.reply({ items: [] });
    await operation;
    assert.equal(ui.get('#notice').textContent, ''); assert.equal(ui.get('#notice').className, 'notice');
  }
});

test('late history and detail responses cannot overwrite a newer filter or selected execution', async () => {
  const ui = await webHarness();
  const first = ui.run('loadExecutions()');
  ui.get('#execution-status').value = 'pending'; const second = ui.run('applyExecutionFilters()');
  assert.match(ui.requests[1].path, /state=pending/);
  const item = { id: 'current', func: 'research', state: 'pending', createdAt: 1000 };
  ui.requests[1].reply({ items: [item], total: 1 }); await second;
  ui.requests[0].reply({ items: [{ ...item, id: 'obsolete', state: 'resolved' }], total: 99 }); await first;
  assert.equal(ui.get('#execution-total').textContent, 1);
  assert.equal(ui.get('#execution-table tbody').children[0].children[0].children[0].href, '#executions/current');
  ui.run("selectedId = 'old'"); const oldDetail = ui.run("detail('old')");
  ui.run("selectedId = 'current'"); const currentDetail = ui.run("detail('current')");
  const view = id => ({ id, function: 'research', state: 'resolved', createdAt: 1000, settledAt: 2000, waits: [], tasks: [], input: { topic: '<script>unsafe()</script>' }, steps: [{ ...item, id, function: 'research', state: 'resolved', tags: {}, result: '<img src=x onerror=unsafe()>' }] });
  ui.requests[3].reply(view('current')); await currentDetail;
  ui.requests[2].reply(view('old')); await oldDetail;
  assert.equal(ui.get('#execution-id').textContent, 'current');
  assert.match(ui.get('#step-input').textContent, /<script>/);
  assert.match(ui.get('#step-output').textContent, /<img/);
});

test('step traversal preserves parentage and safely displays cycles, missing parents, and deep trees', async () => {
  const ui = await webHarness();
  const result = ui.run(`orderedSteps([
    { id: 'child', parentId: 'root' }, { id: 'root', parentId: 'root' },
    { id: 'orphan', parentId: 'missing' }, { id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }
  ])`);
  assert.deepEqual(Array.from(result, row => [row.step.id, row.depth]), [['root', 0], ['child', 1], ['orphan', 0], ['a', 0], ['b', 1]]);
  assert.equal(ui.run("orderedSteps(Array.from({ length: 12000 }, (_, i) => ({ id: String(i), parentId: i ? String(i - 1) : null }))).length"), 12000);
});

test('older-page failures preserve the current page, and polling does not interrupt older-page inspection', async () => {
  const ui = await webHarness();
  const item = { id: 'new', func: 'research', state: 'resolved', createdAt: 1000, settledAt: 2000 };
  const first = ui.run('loadExecutions()'); ui.requests[0].reply({ items: [item], cursor: 'older', total: 2 }); await first;
  ui.get('#execution-next').onclick();
  const failed = ui.run('listController');
  ui.requests[1].reply({ error: 'Temporary outage' }, 503);
  // Let both fetch and response decoding finish before inspecting the page.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed.signal.aborted, false);
  assert.match(ui.get('#execution-page-note').textContent, /Page 1/);
  assert.equal(ui.run('pageIndex'), 0); assert.equal(ui.get('#execution-next').disabled, false);
  ui.get('#execution-next').onclick(); ui.requests[2].reply({ items: [{ ...item, id: 'old' }], total: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(ui.requests[2].path, /cursor=older/);
  assert.match(ui.get('#execution-page-note').textContent, /Page 2/);
  await ui.run('loadExecutions(true)'); assert.equal(ui.requests.length, 3);
  assert.equal(ui.get('#execution-next').disabled, true);
  assert.equal(ui.get('#execution-previous').disabled, false);
  assert.equal(ui.run("settledAt({ state: 'rejected_timedout', timeoutAt: 9000 })"), 9000);
});

test('an expired session returns to sign-in while preserving the execution deep link', async () => {
  const ui = await webHarness();
  ui.run("location.hash = '#executions/saved-run'");
  const request = ui.run("api('/v1/executions/saved-run')");
  ui.requests[0].reply({ error: 'Sign in again' }, 401);
  await assert.rejects(request, /Sign in again/);
  assert.equal(ui.get('#login').hidden, false); assert.equal(ui.get('#shell').hidden, true);
  assert.equal(ui.run('location.hash'), '#executions/saved-run');
});

test('live execution refresh is serialized, retains stale progress and resumes without a reload', async () => {
  const ui = await webHarness();
  ui.run("selectedId = 'live'; workersObservedAt = Date.now(); catalogue = [{ name: 'tool_retry', version: 1, group: 'examples-v1' }]; exampleWorkers = [{ online: true, group: 'examples-v1', functions: [{ name: 'tool_retry', version: 1 }] }]");
  const snapshot = { id: 'live', function: 'tool_retry', version: 1, state: 'pending', input: {}, steps: [], waits: [], tasks: [] };
  const first = ui.run("detail('live')"); await ui.run("detail('live', true)");
  assert.equal(ui.requests.length, 1, 'Polling never overlaps an in-flight snapshot');
  ui.requests[0].reply(snapshot); await first;
  assert.equal(ui.live.at(-1)[0], 'snapshot'); assert.equal(ui.live.at(-1)[2].presence.online, 1);
  assert.equal([...ui.timers.values()][0].ms, 2000);
  const stale = ui.run("detail('live', true)"); ui.requests[1].reply({ error: 'Temporary outage' }, 503); await stale;
  assert.deepEqual(ui.live.at(-1), ['stale', 'live']); assert.equal(ui.run('execution.state'), 'pending');
  assert.equal(ui.timers.size, 1, 'Outage schedules another attempt');
  const recovered = ui.run("detail('live', true)"); ui.requests[2].reply({ ...snapshot, state: 'resolved' }); await recovered;
  assert.equal(ui.live.at(-1)[1].state, 'resolved'); assert.equal(ui.live.at(-1)[2].stale, false);
  assert.equal(ui.timers.size, 0, 'Terminal executions stop automatic detail requests');
});

test('hidden pages pause live requests and late responses cannot animate a different run', async () => {
  const ui = await webHarness(), snapshot = { id: 'old', function: 'research', state: 'pending', steps: [], waits: [] };
  ui.run("selectedId = 'old'"); const first = ui.run("detail('old')"); ui.requests[0].reply(snapshot); await first;
  assert.equal(ui.timers.size, 1);
  ui.run('document.hidden = true'); ui.events.visibilitychange(); assert.equal(ui.timers.size, 0);
  ui.run('document.hidden = false'); ui.events.visibilitychange();
  assert.equal(ui.requests.length, 2);
  ui.run("location.hash = '#executions/new'; route(false)");
  const latest = ui.live.length; ui.requests[1].reply(snapshot); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.live.length, latest, 'An old snapshot cannot repaint the new route');
  assert.equal(ui.live.at(-1)[0], 'clear');
});
