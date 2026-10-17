const $ = selector => document.querySelector(selector);
let catalogue = [];
let renderedFunctions;
const expandedSchemas = new Set();
let exampleCatalogue = [], exampleWorkers = [], examplesLoaded = false;
let project, selectedId, timer, noticeSource, refreshing = false, activeTab = 'overview';
let execution, selectedStep, detailController, listController, mutationPending = false;
let detailTimer, executionObservedAt, executionStale = false, workersObservedAt;
let listItems = [], nextCursor, cursors = [undefined], pageIndex = 0, loadedPageIndex = 0, listLoaded = false, renderedSteps;
let appliedFilters = {};
const stateLabels = { pending: 'Pending', resolved: 'Resolved', rejected: 'Rejected', rejected_canceled: 'Canceled', rejected_timedout: 'Timed out' };
const stamp = value => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const settledAt = record => record.settledAt ?? (record.state === 'rejected_timedout' ? record.timeoutAt : undefined);
const duration = (start, end) => {
  if (!start) return '—';
  const seconds = Math.max(0, Math.floor(((end ?? Date.now()) - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
};
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function stateBadge(state) { return node('span', stateLabels[state] ?? state, `state ${state}`); }
function pretty(value) { return value === undefined || value === null ? 'No value recorded.' : JSON.stringify(value, null, 2); }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/session' && path !== '/v1/project') {
      clearInterval(timer); clearTimeout(detailTimer); detailController?.abort(); listController?.abort();
      window.resonateWalkthrough?.executionStale(selectedId);
      window.resonateExamples?.pause();
      $('#login').hidden = false; $('#shell').hidden = true; $('#key-secret').textContent = ''; $('#key-created').hidden = true;
    }
    const error = new Error(data.error || `Request failed (${response.status})`); error.status = response.status; throw error;
  }
  return data;
}
function notice(message, error = false, source = 'action') {
  noticeSource = source;
  $('#notice').textContent = message; $('#notice').className = `notice visible${error ? ' error' : ''}`;
}
function clearNotice() {
  noticeSource = undefined; $('#notice').textContent = ''; $('#notice').className = 'notice';
}
function button(label, action, className = 'text-button') {
  const b = document.createElement('button'); b.textContent = label; b.className = className;
  b.onclick = async () => { try { await action(); } catch (error) { notice(error.message, true); } }; return b;
}
function navigate(name, id) {
  const hash = `#${name}${id ? `/${encodeURIComponent(id)}` : ''}`;
  if (location.hash === hash) route(); else location.hash = hash;
}
function tab(name) {
  activeTab = name;
  window.resonateWalkthrough?.setView(name);
  window.resonateExamples?.setView(name);
  window.resonateCreate?.setView(name);
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
  for (const b of document.querySelectorAll('nav [data-tab], .sidebar-config')) b.classList.toggle('active', b.dataset.tab === name);
  $('#page-title').textContent = { overview: 'Overview', new: 'New execution', examples: 'Examples', executions: 'Executions', functions: 'Functions', workers: 'Workers', access: 'API access', config: 'Config' }[name];
  $('#new-execution').hidden = name === 'new';
}
function route(load = true) {
  const [requested, encodedId] = location.hash.slice(1).split('/');
  const name = ['overview', 'new', 'examples', 'executions', 'functions', 'workers', 'access', 'config'].includes(requested) ? requested : 'overview';
  let id;
  try { id = name === 'executions' && encodedId ? decodeURIComponent(encodedId) : undefined; } catch { /* invalid links open the list */ }
  const changed = name !== activeTab || id !== selectedId;
  if (changed) clearNotice();
  clearTimeout(detailTimer); detailController?.abort(); listController?.abort();
  tab(name);
  if (id !== selectedId) {
    execution = undefined; selectedStep = undefined; renderedSteps = undefined; executionObservedAt = undefined; executionStale = false;
    window.resonateWalkthrough?.clearExecution();
  }
  selectedId = id;
  $('#execution-list-view').hidden = !!id;
  $('#execution-detail-view').hidden = !id;
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'executions' && load) refreshExecutions();
  if (['overview', 'new', 'examples', 'functions', 'workers', 'access'].includes(name) && load) refresh();
}
window.addEventListener('hashchange', () => route());
$('#theme').value = window.resonateTheme?.get() ?? 'system';
$('#theme').onchange = () => window.resonateTheme?.set($('#theme').value);
window.addEventListener('resonate:themechange', () => { $('#theme').value = window.resonateTheme?.get() ?? 'system'; });
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => navigate(b.dataset.tab));
function updateComposer() {
  window.resonateCreate?.update({ catalogue, examples: exampleCatalogue, workers: exampleWorkers, workersObservedAt, api, project, loaded: renderedFunctions !== undefined });
}
window.addEventListener('resonate:create-ready', () => { updateComposer(); window.resonateCreate?.setView(activeTab); });
window.addEventListener('resonate:worker-guide-ready', () => { if (project) window.resonateWorkerGuide?.setEndpoint(project.endpoint); });
window.addEventListener('resonate:examples-ready', renderExamples);
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const b = event.submitter; b.disabled = true;
  try { await api('/session', { method: 'POST', body: JSON.stringify({ key: $('#login-key').value }) }); $('#login-key').value = ''; await init(); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { b.disabled = false; }
};
$('#logout').onclick = async () => {
  await api('/session', { method: 'DELETE' }); clearInterval(timer); clearTimeout(detailTimer); detailController?.abort(); listController?.abort();
  window.resonateWalkthrough?.clearExecution(); window.resonateExamples?.clear();
  window.resonateCreate?.clear();
  $('#key-secret').textContent = ''; $('#key-created').hidden = true; $('#login-error').textContent = '';
  $('#login').hidden = false; $('#shell').hidden = true;
};

async function functions() {
  const data = await api('/v1/functions?versions=all');
  catalogue = data.items;
  const filter = $('#execution-function'); const current = filter.value;
  const names = [...new Set([...data.items.map(f => f.name), ...listItems.map(r => r.func).filter(Boolean), ...(current ? [current] : [])])].sort();
  const all = node('option', 'All functions'); all.value = '';
  filter.replaceChildren(all, ...names.map(name => { const option = node('option', name); option.value = name; return option; }));
  filter.value = current;
  const fingerprint = JSON.stringify(data.items);
  if (fingerprint === renderedFunctions) return;
  renderedFunctions = fingerprint;
  updateComposer();
  const list = $('#function-list'); list.replaceChildren();
  if (!data.items.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No registered functions. Start your worker to publish its manifest.'; list.append(p); }
  for (const f of data.items) {
    const card = document.createElement('div'); card.className = 'function-card';
    const h = document.createElement('h3'); h.textContent = `${f.name} · v${f.version} · ${f.group}`;
    const p = document.createElement('p'); p.textContent = f.description;
    const schema = node('details', undefined, 'function-schema');
    const key = JSON.stringify([f.name, f.version, f.group]); schema.open = expandedSchemas.has(key);
    schema.ontoggle = () => { if (schema.open) expandedSchemas.add(key); else expandedSchemas.delete(key); };
    const summary = node('summary', 'Input schema');
    const fields = f.inputSchema?.properties;
    if (fields) { const count = Object.keys(fields).length; summary.append(node('span', `${count} field${count === 1 ? '' : 's'}`, 'schema-size')); }
    const pre = node('pre', JSON.stringify(f.inputSchema, null, 2)); pre.tabIndex = 0;
    schema.append(summary, pre);
    const start = button('Create execution →', () => { window.resonateCreate?.choose(f.name, f.version); navigate('new'); }, 'outline');
    card.append(h, p, start, schema); list.append(card);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    // History loads only on Executions. Onboarding resources retry independently.
    const resources = [[functions, 'Function catalogue'], [workers, 'Worker status'], ...(!examplesLoaded ? [[loadExamples, 'Example catalogue']] : []), ...(activeTab === 'access' ? [[keys, 'API keys']] : [])];
    const results = await Promise.allSettled(resources.map(([load]) => load()));
    renderExamples();
    updateComposer();
    const failures = results.flatMap((result, i) => result.status === 'rejected' ? [resources[i][1]] : []);
    if (failures.length) notice(`${failures.join(' and ')} temporarily unavailable. Retrying automatically.`, true, 'refresh');
    else if (noticeSource === 'refresh') { $('#notice').textContent = ''; $('#notice').className = 'notice'; noticeSource = undefined; }
  } finally { refreshing = false; }
}
async function loadExecutions(poll = false) {
  if (poll && (pageIndex > 0 || listController && !listController.signal.aborted)) return;
  listController?.abort(); const controller = new AbortController(); listController = controller;
  const requestedPage = pageIndex;
  $('#execution-previous').disabled = true; $('#execution-next').disabled = true;
  $('#execution-loading').hidden = listLoaded;
  const query = new URLSearchParams({ limit: '25', ...appliedFilters });
  if (cursors[pageIndex]) query.set('cursor', cursors[pageIndex]);
  try {
    const data = await api(`/v1/executions?${query}`, { signal: controller.signal });
    if (controller.signal.aborted || activeTab !== 'executions' || selectedId) return;
    listItems = data.items; nextCursor = data.cursor; listLoaded = true; loadedPageIndex = requestedPage;
    $('#execution-list-error').hidden = true;
    $('#execution-total').textContent = data.total ?? `${data.items.length}${data.cursor ? '+' : ''}`;
    $('#execution-total-note').textContent = data.total == null ? 'Shown on this page' : 'Across the selected filters';
    $('#execution-pending').textContent = data.items.filter(r => r.state === 'pending').length;
    $('#execution-resolved').textContent = data.items.filter(r => r.state === 'resolved').length;
    renderExecutionList();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (listLoaded) pageIndex = loadedPageIndex;
    $('#execution-list-error').textContent = `${listLoaded ? 'Showing the last loaded page. ' : ''}${error.message}. Use Refresh to retry.`;
    $('#execution-list-error').hidden = false;
  } finally {
    if (listController === controller) {
      listController = undefined; $('#execution-loading').hidden = true;
      $('#execution-previous').disabled = pageIndex === 0;
      $('#execution-next').disabled = !nextCursor;
    }
  }
}
function renderExecutionList() {
  $('#execution-empty').hidden = listItems.length !== 0;
  $('#execution-table').hidden = listItems.length === 0;
  $('#execution-page-note').textContent = `Page ${pageIndex + 1} · ${listItems.length} execution${listItems.length === 1 ? '' : 's'}`;
  $('#execution-table tbody').replaceChildren(...listItems.map(run => {
    const row = node('tr');
    const identity = node('td'); const link = node('a', undefined, 'execution-link');
    link.href = `#executions/${encodeURIComponent(run.id)}`;
    link.setAttribute('aria-label', `Inspect execution ${run.id}`);
    link.append(node('strong', run.func || 'Execution'), node('span', run.id, 'mono'));
    link.title = run.id; identity.append(link);
    const state = node('td'); state.append(stateBadge(run.state));
    row.append(identity, state, node('td', stamp(run.createdAt)), node('td', duration(run.createdAt, settledAt(run)), 'mono'), node('td', '↗', 'row-arrow'));
    return row;
  }));
}
function applyExecutionFilters() {
  cursors = [undefined]; pageIndex = 0; nextCursor = undefined;
  appliedFilters = {};
  for (const [field, selector] of [['idPrefix', '#execution-search'], ['state', '#execution-status'], ['func', '#execution-function']]) {
    const value = $(selector).value.trim(); if (value) appliedFilters[field] = value;
  }
  const windowMs = Number($('#execution-window').value);
  if (windowMs) appliedFilters.createdFrom = String(Date.now() - windowMs);
  listLoaded = false; listItems = [];
  $('#execution-table').hidden = true; $('#execution-empty').hidden = true;
  $('#execution-total').textContent = '—'; $('#execution-pending').textContent = '—'; $('#execution-resolved').textContent = '—';
  return loadExecutions();
}
$('#execution-filters').onsubmit = event => { event.preventDefault(); applyExecutionFilters(); };
for (const selector of ['#execution-status', '#execution-function', '#execution-window']) $(selector).onchange = applyExecutionFilters;
$('#execution-reset').onclick = () => {
  for (const selector of ['#execution-search', '#execution-status', '#execution-function', '#execution-window']) $(selector).value = '';
  applyExecutionFilters();
};
$('#execution-refresh').onclick = () => loadExecutions();
$('#execution-previous').onclick = () => { if (pageIndex > 0) { pageIndex--; loadExecutions(); } };
$('#execution-next').onclick = () => {
  if (!nextCursor) return;
  cursors = [...cursors.slice(0, pageIndex + 1), nextCursor]; pageIndex++; loadExecutions();
};
$('#execution-back').onclick = () => navigate('executions');
function refreshExecutions(poll = false) {
  return selectedId ? detail(selectedId, poll) : loadExecutions(poll);
}
function scheduleDetail() {
  clearTimeout(detailTimer);
  if (activeTab === 'executions' && selectedId && !document.hidden && !$('#shell').hidden && (!execution || execution.state === 'pending' || executionStale)) {
    detailTimer = setTimeout(() => detail(selectedId, true), 2000);
  }
}
function resumeDetail() {
  if (document.hidden) {
    clearTimeout(detailTimer); detailController?.abort();
    if (execution?.state === 'pending') { executionStale = true; window.resonateWalkthrough?.executionStale(selectedId); }
  }
  else if (activeTab === 'executions' && selectedId && !$('#shell').hidden && (!execution || execution.state === 'pending' || executionStale)) detail(selectedId, true);
}
document.addEventListener('visibilitychange', resumeDetail);
window.addEventListener('focus', resumeDetail);
function renderLiveExecution() {
  if (!execution || activeTab !== 'executions' || execution.id !== selectedId) return;
  const group = execution.workerGroup ?? catalogue.find(f => f.name === execution.function && f.version === execution.version)?.group;
  const known = Boolean(group && workersObservedAt && Date.now() - workersObservedAt < 15000);
  const online = exampleWorkers.filter(worker => worker.online && worker.group === group && worker.functions.some(f => f.name === execution.function && f.version === execution.version)).length;
  window.resonateWalkthrough?.setExecution(execution, { presence: { known, online }, observedAt: executionObservedAt, stale: executionStale,
    onRefresh: () => detail(selectedId),
    onSelect: id => {
      if (!execution.steps.some(step => step.id === id)) return;
      selectedStep = id; renderExecution(); $('.step-inspector').scrollIntoView({ behavior: 'instant', block: 'start' });
    } });
}
async function detail(id, poll = false) {
  if (poll && detailController && !detailController.signal.aborted) return;
  clearTimeout(detailTimer);
  detailController?.abort(); const controller = new AbortController(); detailController = controller;
  $('#execution-detail-content').hidden = !execution;
  $('#execution-detail-loading').hidden = !!execution;
  $('#execution-detail-error').hidden = true;
  try {
    const data = await api(`/v1/executions/${encodeURIComponent(id)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    if (controller.signal.aborted || id !== selectedId || activeTab !== 'executions') return;
    execution = data; executionObservedAt = Date.now(); executionStale = false;
    if (!data.steps.some(step => step.id === selectedStep)) selectedStep = data.steps.some(step => step.id === id) ? id : data.steps[0]?.id;
    renderExecution();
  } catch (error) {
    if (controller.signal.aborted || id !== selectedId || activeTab !== 'executions') return;
    executionStale = true; window.resonateWalkthrough?.executionStale(id);
    $('#execution-detail-error').textContent = `${execution ? 'Showing the last saved view. ' : ''}${error.message}. Retrying automatically.`;
    $('#execution-detail-error').hidden = false;
  } finally {
    if (detailController === controller) { detailController = undefined; $('#execution-detail-loading').hidden = true; scheduleDetail(); }
  }
}
// Iterative traversal keeps malformed or very deep lineage from blocking the UI.
function orderedSteps(steps) {
  const byId = new Map(steps.map(step => [step.id, step])), children = new Map(), roots = [], rows = [], seen = new Set();
  for (const step of steps) {
    if (step.parentId && step.parentId !== step.id && byId.has(step.parentId)) {
      if (!children.has(step.parentId)) children.set(step.parentId, []);
      children.get(step.parentId).push(step);
    } else roots.push(step);
  }
  function walk(root) {
    const stack = [{ step: root, depth: 0 }];
    while (stack.length) {
      const row = stack.pop(); if (seen.has(row.step.id)) continue;
      seen.add(row.step.id); rows.push(row);
      for (const child of [...(children.get(row.step.id) ?? [])].reverse()) stack.push({ step: child, depth: row.depth + 1 });
    }
  }
  for (const root of roots) walk(root);
  for (const step of steps) if (!seen.has(step.id)) walk(step);
  return rows;
}
function stepKind(step) {
  if (step.id === execution.id) return 'Execution';
  if (step.tags?.['cloud:wait'] === 'approval') return 'Approval';
  if (step.tags?.['resonate:timer']) return 'Durable timer';
  return step.function ? 'Checkpoint' : 'Promise';
}
function stepName(step) { return step.tags?.['cloud:label'] || step.function || (stepKind(step) === 'Approval' ? 'Human approval' : stepKind(step) === 'Durable timer' ? 'Durable sleep' : 'Durable promise'); }
function timerElapsed(step) { return stepKind(step) === 'Durable timer' && step.state === 'rejected_timedout'; }
function stepStateLabel(step) { return timerElapsed(step) ? 'Elapsed' : step.function === 'callMockTool' && step.result?.status === 429 ? '429 recorded' : stateLabels[step.state] ?? step.state; }
function renderExecution() {
  if (!execution) return;
  const run = execution;
  renderLiveExecution();
  $('#execution-detail-content').hidden = false;
  const name = run.function || run.steps.find(step => step.id === run.id)?.function || 'Execution';
  $('#execution-name').textContent = `${name}${run.version ? ` · v${run.version}` : ''}`;
  $('#execution-state').textContent = stateLabels[run.state] ?? run.state;
  $('#execution-state').className = `state ${run.state}`;
  $('#execution-id').textContent = run.id;
  $('#execution-created').textContent = stamp(run.createdAt);
  $('#execution-settled').textContent = settledAt(run) ? stamp(settledAt(run)) : 'Awaiting completion';
  $('#execution-duration').textContent = duration(run.createdAt, settledAt(run));
  $('#execution-timeout').textContent = stamp(run.timeoutAt);
  const example = exampleCatalogue.find(item => item.descriptor.name === run.function && item.descriptor.version === run.version);
  const context = $('#example-context'); context.hidden = !example;
  if (example) {
    context.replaceChildren(node('span', example.category, 'badge'), node('h3', example.title), node('p', example.value));
    if (run.result?.outcome) {
      const outcomes = { refunded: 'Refunded', declined: 'Declined', recovered: 'Recovered', exhausted: 'Retry budget exhausted', compensated: 'Compensated', fulfilled: 'Fulfilled', indexed: 'Indexed' };
      context.append(node('span', `Outcome: ${outcomes[run.result.outcome] ?? run.result.outcome}`, `state ${['exhausted', 'declined'].includes(run.result.outcome) ? 'rejected_canceled' : 'resolved'}`));
    }
    context.append(node('strong', run.result?.summary ?? (run.waits?.length ? 'Waiting for your decision. Completed checks are saved.' : run.state === 'pending' ? example.observe : `Execution ${stateLabels[run.state] ?? run.state}. Inspect the steps below.`)),
      node('small', 'Simulated business tools · Real checkpoints, timers and decisions persisted in TiDB.'));
  }
  $('#cancel-run').hidden = run.state !== 'pending'; $('#cancel-run').disabled = mutationPending;
  $('#cancel-note').hidden = run.state !== 'pending';
  $('#execution-truncated').hidden = !run.truncated;
  $('#step-count').textContent = `${run.steps.length} step${run.steps.length === 1 ? '' : 's'}`;
  const fingerprint = JSON.stringify([run.steps, selectedStep]);
  if (fingerprint !== renderedSteps) {
    renderedSteps = fingerprint;
    $('#execution-steps').replaceChildren(...orderedSteps(run.steps).map(({ step, depth }) => {
      const row = node('button', undefined, `step-row depth-${Math.min(depth, 6)}${step.id === selectedStep ? ' selected' : ''}`);
      row.setAttribute('aria-current', step.id === selectedStep ? 'step' : 'false');
      row.setAttribute('aria-label', `Inspect step ${stepName(step)} · ${stepStateLabel(step)}`);
      const name = node('span', undefined, 'step-row-name');
      name.append(node('strong', stepName(step)), node('small', `${stepKind(step)} · ${duration(step.createdAt, settledAt(step))}`));
      const badge = stateBadge(step.state);
      badge.textContent = stepStateLabel(step);
      if (timerElapsed(step)) { badge.textContent = 'Elapsed'; badge.className = 'state resolved'; }
      row.append(node('span', '', `step-marker ${timerElapsed(step) ? 'resolved' : step.state}`), name, badge);
      row.onclick = () => { selectedStep = step.id; renderExecution(); };
      return row;
    }));
  }
  const step = run.steps.find(item => item.id === selectedStep);
  if (step) {
    $('#step-kind').textContent = stepKind(step); $('#step-name').textContent = stepName(step);
    $('#step-state').textContent = stepStateLabel(step); $('#step-state').className = `state ${timerElapsed(step) ? 'resolved' : step.state}`;
    $('#step-id').textContent = step.id;
    $('#step-timing').textContent = `${stamp(step.createdAt)} · ${duration(step.createdAt, settledAt(step))}${settledAt(step) ? ` · Settled ${stamp(settledAt(step))}` : ''}`;
    const task = run.tasks?.find(item => item.id === step.taskId);
    $('#step-task').hidden = !task;
    if (task) $('#step-task').textContent = `Worker task: ${task.state} · ${task.resumes} resume${task.resumes === 1 ? '' : 's'}`;
    $('#step-input-title').textContent = step.inputKind === 'metadata' ? 'Invocation metadata' : 'Input';
    $('#step-input-note').hidden = step.inputKind !== 'metadata';
    $('#step-input').textContent = pretty(step.id === run.id ? run.input : step.input);
    $('#step-output-title').textContent = step.state === 'rejected' ? 'Error' : 'Result';
    $('#step-output').textContent = step.state === 'pending' ? 'This step is pending. Its result will appear here when it settles.' : timerElapsed(step) ? 'The durable timer elapsed.' : pretty(step.result);
    $('#step-tags').textContent = pretty(step.tags);
  }
  const actions = $('#wait-actions'); actions.replaceChildren();
  for (const wait of run.state === 'pending' ? run.waits : []) {
    const container = node('div', undefined, 'wait');
    const copy = node('div', undefined, 'wait-copy');
    const approvalStep = run.steps.find(step => step.id === wait.id);
    copy.append(node('strong', approvalStep?.tags?.['cloud:prompt'] || 'Waiting for your approval'), node('p', 'The decision is saved durably. A connected worker will resume this run.'));
    const resolve = approved => () => mutateExecution('waits', { waitId: wait.id, value: { approved } }, approved ? 'Approval submitted.' : 'Review declined.');
    const approve = button('Approve', resolve(true), ''), decline = button('Decline', resolve(false), 'outline');
    approve.disabled = decline.disabled = mutationPending;
    container.append(copy, approve, decline); actions.append(container);
  }
}
async function mutateExecution(action, body, message) {
  if (mutationPending || !execution) return;
  const id = execution.id; mutationPending = true; renderExecution();
  try {
    await api(`/v1/executions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
    if (activeTab === 'executions' && selectedId === id) { notice(message); await detail(id); }
  } catch (error) { if (activeTab === 'executions' && selectedId === id) notice(error.message, true); }
  finally { mutationPending = false; renderExecution(); }
}
$('#refresh-functions').onclick = refresh;
$('#cancel-run').onclick = () => mutateExecution('cancel', undefined, 'Cancellation recorded. In-flight external effects may still finish.');
async function workers() {
  let data;
  try { data = await api('/v1/workers'); }
  catch (error) { workersObservedAt = undefined; renderLiveExecution(); updateComposer(); throw error; }
  exampleWorkers = data.items; workersObservedAt = Date.now(); renderLiveExecution();
  updateComposer();
  const online = data.items.filter(worker => worker.online).length;
  $('#worker-summary').textContent = `${online} worker${online === 1 ? '' : 's'} reporting`;
  $('#workers-empty').hidden = data.items.length > 0; $('#workers-table').hidden = !data.items.length;
  $('#workers-table tbody').replaceChildren(...data.items.map(worker => {
    const row = node('tr'), identity = node('td'), state = node('td'), functions = node('td');
    identity.textContent = worker.id; state.append(node('span', worker.online ? 'Online' : 'Offline', `state ${worker.online ? 'resolved' : 'rejected_canceled'}`));
    functions.append(node('strong', worker.group), node('p', worker.functions.map(f => `${f.name} v${f.version}`).join(', '), 'muted'));
    row.append(identity, state, functions, node('td', stamp(worker.lastSeenAt))); return row;
  }));
}
async function loadExamples() {
  const data = await api('/v1/examples'); exampleCatalogue = data.items; examplesLoaded = true;
  if (execution) renderExecution();
}
function renderExamples() {
  const availability = exampleCatalogue.map(example => catalogue.some(f => f.name === example.descriptor.name && f.version === example.descriptor.version)
    && exampleWorkers.some(worker => worker.online && worker.group === example.descriptor.group && worker.functions.some(f => f.name === example.descriptor.name && f.version === example.descriptor.version)));
  $('#examples-guide').hidden = availability.length > 0 && availability.every(Boolean);
  window.resonateExamples?.render({ examples: exampleCatalogue, catalogue, workers: exampleWorkers, workersObservedAt, api, view: activeTab });
}

async function keys() {
  const [data, activity] = await Promise.all([api('/v1/api-keys'), api('/v1/audit')]);
  $('#keys-table tbody').replaceChildren(...data.items.map(key => {
    const row = node('tr'), identity = node('td'), state = node('td'), actions = node('td');
    identity.append(node('strong', key.name), node('p', key.prefix + '…', 'mono muted'));
    const status = key.revokedAt ? 'Revoked' : key.expiresAt && key.expiresAt <= Date.now() ? 'Expired' : 'Active';
    state.append(node('span', status, `state ${status === 'Active' ? 'resolved' : 'rejected_canceled'}`));
    const revoke = button(key.id === data.currentKeyId ? 'Current sign-in key' : 'Revoke', async () => {
      revoke.disabled = true;
      try { await api(`/v1/api-keys/${encodeURIComponent(key.id)}`, { method: 'DELETE' }); notice(`Revoked ${key.name}.`); await keys(); }
      finally { revoke.disabled = false; }
    });
    revoke.disabled = status !== 'Active' || key.id === data.currentKeyId;
    actions.append(revoke); row.append(identity, node('td', key.role), state, node('td', key.expiresAt ? stamp(key.expiresAt) : 'No expiry'), actions); return row;
  }));
  $('#audit-list').replaceChildren(...activity.items.slice(0, 15).map(event => {
    const entry = node('div', undefined, 'audit-entry');
    entry.append(node('strong', event.action), node('span', event.target), node('small', `${stamp(event.createdAt)} · key ${event.actorKeyId}`)); return entry;
  }));
}
$('#key-form').onsubmit = async event => {
  event.preventDefault(); $('#create-key').disabled = true;
  try {
    const key = await api('/v1/api-keys', { method: 'POST', body: JSON.stringify({ name: $('#key-name').value, role: $('#key-role').value, expiresAt: Date.now() + Number($('#key-days').value) * 86400000 }) });
    $('#key-secret').textContent = key.token; $('#key-created').hidden = false; $('#key-name').value = ''; await keys();
  } catch (error) { notice(error.message, true); }
  finally { $('#create-key').disabled = false; }
};
$('#dismiss-key').onclick = () => { $('#key-secret').textContent = ''; $('#key-created').hidden = true; };
$('#refresh-keys').onclick = () => keys().catch(error => notice(error.message, true));
$('#refresh-workers').onclick = () => workers().catch(error => notice(error.message, true));
async function init() {
  clearInterval(timer); clearTimeout(detailTimer);
  try { project = await api('/v1/project'); }
  catch (error) {
    try {
      if (error.status !== 401 || !(await api('/session')).testLoginEnabled) throw error;
      await api('/session', { method: 'POST', body: JSON.stringify({ test: true }) });
      project = await api('/v1/project');
    } catch { $('#login').hidden = false; $('#shell').hidden = true; return; }
  }
  $('#login').hidden = true; $('#shell').hidden = false; $('#project-name').textContent = project.name;
  $('#endpoint').textContent = project.endpoint;
  $('#expiry').textContent = project.databaseExpiresAt ? `Preview environment · Temporary database expires ${new Date(project.databaseExpiresAt).toLocaleString()}. Claim it before expiry to retain execution history.` : 'Persistent database · Execution history follows your database retention policy.';
  $('#metrics-example').textContent = `${project.endpoint}/health/live\n${project.endpoint}/health/ready\n${project.endpoint}/metrics\n${project.endpoint}/metrics/engine`;
  window.resonateWorkerGuide?.setEndpoint(project.endpoint);
  $('#api-example').textContent = `curl ${project.endpoint}/v1/executions \\\n  -H 'Authorization: Bearer <client credential>' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: research-001' \\\n  -d '{"function":"research","input":{"topic":"Durable agents","requireApproval":true}}'`;
  route(false);
  await Promise.all([refresh(), ...(activeTab === 'executions' ? [refreshExecutions()] : [])]);
  timer = setInterval(() => { if (!document.hidden) { refresh(); if (activeTab === 'executions' && !selectedId) loadExecutions(true); } }, 5000);
}
init().catch(e => notice(e.message, true));
