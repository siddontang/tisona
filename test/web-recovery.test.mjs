import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';

test('overview loads onboarding independently, recovers outages and never requests execution history', async () => {
  const elements = new Map();
  function element() {
    return { textContent: '', className: '', children: [], hidden: false, value: '',
      replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } };
  }
  const get = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  let catalogueFailed = true, workersFailed = false, poll;
  const requests = [];
  const context = vm.createContext({
    document: { hidden: false, querySelector: get, querySelectorAll: () => [], createElement: element, addEventListener() {} },
    window: { addEventListener() {}, scrollTo() {} }, location: { hash: '' },
    setInterval: fn => { poll = fn; return 1; }, clearInterval() {}, clearTimeout() {},
    fetch: async path => {
      requests.push(path);
      const failed = path.startsWith('/v1/functions') ? catalogueFailed : path === '/v1/workers' ? workersFailed : false;
      let data;
      if (failed) data = { error: 'Service temporarily unavailable' };
      else if (path === '/v1/project') data = { name: 'Test', endpoint: 'http://127.0.0.1', databaseExpiresAt: '2026-11-01T00:00:00Z' };
      else if (path.startsWith('/v1/functions')) data = { items: [{ name: 'research', version: 1, group: 'default', description: 'Test function', inputSchema: { type: 'object' } }] };
      else if (path === '/v1/workers') data = { items: [] };
      else if (path === '/v1/examples') data = { items: [] };
      else data = { items: [{ id: 'existing-run', func: 'research', state: 'resolved', createdAt: 1 }] };
      return { ok: !failed, status: failed ? 503 : 200, json: async () => data };
    }
  });
  const source = (await readFile(new URL('../web/app.js', import.meta.url), 'utf8')).replace(/\ninit\(\)\.catch\([^\n]+\);\s*$/, '\n');
  vm.runInContext(source, context);
  await vm.runInContext('init()', context);
  assert.equal(requests.some(path => path.startsWith('/v1/executions')), false);
  assert.match(get('#notice').textContent, /Function catalogue.*Retrying automatically/);
  catalogueFailed = false;
  poll(); await setImmediate();
  assert.equal(vm.runInContext('catalogue.length', context), 1);
  assert.equal(get('#notice').textContent, ''); assert.equal(get('#notice').className, 'notice');
  await vm.runInContext("notice('Execution accepted'); refresh()", context);
  assert.equal(get('#notice').textContent, 'Execution accepted', 'Successful polling must not erase action feedback');
  workersFailed = true;
  await vm.runInContext('refresh()', context);
  assert.match(get('#notice').textContent, /Worker status/);
  assert.equal(vm.runInContext('catalogue.length', context), 1);
  workersFailed = false;
  poll(); await setImmediate();
  assert.equal(get('#notice').textContent, '');
  assert.equal(requests.some(path => path.startsWith('/v1/executions')), false, 'Background refresh must not load a hidden history list');
});
