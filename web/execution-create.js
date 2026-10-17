import { fieldLabel, initialInput, inputErrors, compatibleWorkers, createStartRequest } from './execution-input.js';

const root = document.querySelector('#execution-composer');
const el = (tag, text, className) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
};
const link = (label, href) => { const n = el('a', label, 'outline'); n.href = href; return n; };
function action(label, fn, className = 'outline') { const b = el('button', label, className); b.type = 'button'; b.onclick = fn; return b; }
const keyOf = d => JSON.stringify([d.name, d.version]);
let data = { catalogue: [], examples: [], workers: [], loaded: false }, descriptor, step = 0, mode = 'fields', draft, controls = [], jsonEditor, fieldPanel, errorBox, request, storageKey, receiptBody;
let active = false, freshnessTimer;
const drafts = new Map();
const headings = ['Choose a function', 'Set the input', 'Review & create'];

function showError(message, field) {
  errorBox.textContent = message; errorBox.hidden = !message;
  if (field) { field.setAttribute('aria-invalid', 'true'); field.focus(); }
  else if (message) errorBox.focus();
}
function supportsFields() { return descriptor?.inputSchema.type === 'object' && Object.keys(descriptor.inputSchema.properties ?? {}).length > 0; }
function readInput() {
  if (mode === 'json') {
    try { return JSON.parse(jsonEditor.value); }
    catch { throw { message: 'Enter valid JSON. Check quotes, commas and brackets.', field: jsonEditor }; }
  }
  const value = { ...draft };
  for (const { name, schema, control } of controls) {
    const raw = control.value;
    if (raw === '' && schema.type !== 'string') { delete value[name]; continue; }
    if (raw === '' && !descriptor.inputSchema.required?.includes(name)) { delete value[name]; continue; }
    let next;
    if (schema.enum) { if (raw === '') { delete value[name]; continue; } next = schema.enum[Number(raw)]; }
    else if (schema.type === 'string') next = raw;
    else if (['number', 'integer'].includes(schema.type)) next = Number(raw);
    else { try { next = JSON.parse(raw); } catch { throw { message: `${fieldLabel(name)}: enter valid JSON.`, field: control }; } }
    Object.defineProperty(value, name, { value: next, writable: true, enumerable: true, configurable: true });
  }
  return value;
}
function capture() {
  if (step !== 1 || !descriptor) return true;
  try { draft = readInput(); drafts.set(keyOf(descriptor), structuredClone(draft)); return true; }
  catch (e) { showError(e.message, e.field); return false; }
}
function choose(name, version) {
  if (request?.state.busy || request?.state.intent) return;
  const next = data.catalogue.filter(d => d.name === name && (version === undefined || d.version === version)).sort((a, b) => b.version - a.version)[0];
  if (!next) return;
  descriptor = next; draft = drafts.has(keyOf(next)) ? structuredClone(drafts.get(keyOf(next))) : initialInput(next, data.examples);
  mode = supportsFields() ? 'fields' : 'json'; step = 0; receiptBody = undefined; request?.reset(); render();
}
function presence() {
  if (!descriptor) return;
  const status = compatibleWorkers(descriptor, data.workers, data.workersObservedAt);
  const box = el('div', undefined, `create-presence ${status.known && status.online ? 'ready' : 'waiting'}`);
  box.append(el('strong', !status.known ? 'Worker status unavailable' : status.online ? `${status.online} compatible worker${status.online === 1 ? '' : 's'} reporting` : 'No compatible worker reporting'));
  box.append(el('p', status.online ? `Reports support for ${descriptor.name} v${descriptor.version}. Your code runs on that worker; TiSona saves its progress.` : `${status.known ? 'It will wait' : 'It may wait'} for a worker supporting ${descriptor.name} v${descriptor.version}, until the 1-hour timeout. You can still create the execution.`));
  if (!status.online) box.append(link('View workers →', '#workers'));
  return box;
}
function refreshPresence() {
  const target = root.querySelector('.create-presence');
  if (target && descriptor) target.replaceWith(presence());
  const submit = root.querySelector('#create-submit');
  if (submit && !request.state.intent) submit.textContent = compatibleWorkers(descriptor, data.workers, data.workersObservedAt).online ? 'Create execution →' : 'Create & wait for worker →';
}
function steps() {
  const nav = el('ol', undefined, 'create-steps'); nav.setAttribute('aria-label', 'Creation steps');
  headings.forEach((title, i) => {
    const item = el('li'); const b = action('', () => { if (i < step && !request?.state.intent && !request?.state.busy && capture()) { step = i; render(true); } }, 'create-step');
    b.append(el('span', i < step ? '✓' : String(i + 1)), el('strong', title));
    b.disabled = i > step || Boolean(request?.state.intent || request?.state.busy);
    if (i === step) b.setAttribute('aria-current', 'step'); item.append(b); nav.append(item);
  }); return nav;
}
function selection(panel) {
  panel.append(el('h2', 'What do you want to run?'), el('p', 'A function is code published by your worker. An execution is one run of that function, with its own input, progress and result.', 'create-help'));
  if (!data.loaded || !data.catalogue.length) {
    const empty = el('div', undefined, 'create-empty');
    empty.append(el('h3', data.loaded ? 'No functions registered yet' : 'Loading functions…'), el('p', data.loaded ? 'Connect a worker and publish a function before creating an execution.' : 'The catalogue will appear here when the service responds.'));
    if (data.loaded) empty.append(link('Connect a worker →', '#access')); panel.append(empty); return;
  }
  const label = el('label', 'Function'); label.htmlFor = 'create-function';
  const select = el('select'); select.id = 'create-function';
  const placeholder = el('option', 'Choose a function…'); placeholder.value = ''; select.append(placeholder);
  [...new Set(data.catalogue.map(d => d.name))].sort().forEach(name => { const o = el('option', name); o.value = name; select.append(o); });
  select.value = descriptor?.name ?? ''; select.onchange = () => { if (select.value) choose(select.value); else { descriptor = undefined; render(); } };
  panel.append(label, select);
  if (!descriptor) { panel.append(el('p', 'Looking for a guided demo? Examples include live animations and sample scenarios.', 'create-help'), link('Explore examples →', '#examples')); return; }
  const description = el('div', undefined, 'create-description'); description.append(el('strong', descriptor.name), el('p', descriptor.description)); panel.append(description);
  const versionLabel = el('label', 'Version'); versionLabel.htmlFor = 'create-version'; const versions = el('select'); versions.id = 'create-version';
  const available = data.catalogue.filter(d => d.name === descriptor.name).sort((a, b) => b.version - a.version);
  available.forEach((d, i) => { const o = el('option', `v${d.version}${i === 0 ? ' · Latest' : ''}`); o.value = d.version; versions.append(o); });
  versions.value = String(descriptor.version); versions.onchange = () => choose(descriptor.name, Number(versions.value));
  panel.append(versionLabel, versions, el('p', `This run stays pinned to v${descriptor.version}, even if a newer version is published.`, 'create-help'), presence());
  const advanced = el('details', undefined, 'create-technical'); advanced.append(el('summary', 'Worker routing'), el('p', `Worker group: ${descriptor.group}. Only workers advertising this function version in that group match.`)); panel.append(advanced);
}
const descriptions = {
  topic: 'The topic this research run will investigate.', delaySeconds: 'Seconds to wait at a durable checkpoint.', requireApproval: 'When enabled, the execution pauses for your approval before continuing.',
  ticketId: 'Support ticket reference for this simulated refund.', amountCents: 'Amount in cents. For example, 8900 means 89.00.',
  task: 'The task sent to the simulated tool.', failTimes: 'Number of simulated rate-limit responses before success.', maxAttempts: 'Total tool-call budget, including the first attempt.', backoffSeconds: 'Seconds to wait between attempts.',
  orderId: 'Order reference for this simulated fulfillment.', failShipment: 'Simulate a shipping failure to see refund and stock recovery.', batchId: 'Reference for this document batch.', documentCount: 'Number of documents processed concurrently.'
};
function fields(container) {
  controls = [];
  for (const [name, schema] of Object.entries(descriptor.inputSchema.properties)) {
    const wrap = el('div', undefined, 'create-field'), label = el('label', schema.title ?? fieldLabel(name));
    const id = `create-field-${controls.length}`; label.htmlFor = id;
    label.append(el('span', descriptor.inputSchema.required?.includes(name) ? 'Required' : 'Optional', 'field-requirement'));
    let control;
    if (schema.enum || schema.type === 'boolean') {
      control = el('select'); const empty = el('option', 'Not set'); empty.value = ''; control.append(empty);
      const values = schema.enum ?? [true, false];
      values.forEach((value, i) => { const o = el('option', typeof value === 'boolean' ? value ? 'Yes' : 'No' : typeof value === 'object' ? JSON.stringify(value) : String(value)); o.value = schema.enum ? String(i) : JSON.stringify(value); control.append(o); });
      control.value = Object.hasOwn(draft, name) ? schema.enum ? String(schema.enum.findIndex(v => JSON.stringify(v) === JSON.stringify(draft[name]))) : JSON.stringify(draft[name]) : '';
    } else if (['array', 'object', 'null'].includes(schema.type)) {
      control = el('textarea'); control.rows = 4; control.spellcheck = false; control.value = Object.hasOwn(draft, name) ? JSON.stringify(draft[name], null, 2) : '';
    } else {
      control = el('input'); control.type = ['number', 'integer'].includes(schema.type) ? 'number' : 'text';
      if (control.type === 'number') { control.step = schema.type === 'integer' ? '1' : 'any'; if (schema.minimum !== undefined) control.min = schema.minimum; if (schema.maximum !== undefined) control.max = schema.maximum; }
      control.value = draft[name] ?? '';
    }
    control.id = id; control.setAttribute('aria-describedby', `${id}-help`); control.oninput = () => control.removeAttribute('aria-invalid');
    const constraints = [schema.type, schema.minimum !== undefined ? `min ${schema.minimum}` : '', schema.maximum !== undefined ? `max ${schema.maximum}` : '', schema.minLength !== undefined ? `min ${schema.minLength} characters` : '', schema.maxLength !== undefined ? `max ${schema.maxLength} characters` : ''].filter(Boolean).join(' · ');
    const isBuiltIn = descriptor.name === 'research' || data.examples.some(e => e.descriptor.name === descriptor.name && e.descriptor.version === descriptor.version);
    const help = el('p', [schema.description ?? (isBuiltIn ? descriptions[name] : undefined), constraints].filter(Boolean).join(' '), 'create-field-help'); help.id = `${id}-help`;
    wrap.append(label, control, help); controls.push({ name, schema, control }); container.append(wrap);
  }
}
function inputPanel(panel) {
  panel.append(el('h2', `Give ${descriptor.name} its input`), el('p', `These values belong to this execution only. They do not change the function or its code.`, 'create-help'));
  const example = data.examples.find(e => e.descriptor.name === descriptor.name && e.descriptor.version === descriptor.version);
  if (example) {
    const note = el('div', undefined, 'create-sample'); note.append(el('strong', 'Demo sample data · simulated tools'), el('p', 'Edit the values below, or load a scenario. Loading replaces the current input.'));
    const label = el('label', 'Load sample scenario'); label.htmlFor = 'create-scenario'; const scenarios = el('select'); scenarios.id = 'create-scenario';
    const placeholder = el('option', 'Choose sample…'); placeholder.value = ''; scenarios.append(placeholder);
    example.variants.forEach((v, i) => { const o = el('option', v.name); o.value = String(i); scenarios.append(o); });
    scenarios.onchange = () => { if (scenarios.value !== '') { draft = structuredClone(example.variants[Number(scenarios.value)].input); drafts.set(keyOf(descriptor), draft); render(); } };
    note.append(label, scenarios); panel.append(note);
  }
  const toolbar = el('div', undefined, 'create-input-toolbar'); toolbar.append(el('strong', 'Execution input'));
  if (supportsFields()) toolbar.append(action(mode === 'fields' ? 'Edit as JSON' : 'Use form fields', () => {
    if (!capture()) return;
    if (mode === 'json') {
      const errors = inputErrors(draft, descriptor.inputSchema).filter(e => e.path === 'input' || e.message !== 'This field is required.');
      if (errors.length) { showError(`Fix the JSON before switching to fields. ${errors[0].path}: ${errors[0].message}`, jsonEditor); return; }
    }
    mode = mode === 'fields' ? 'json' : 'fields'; render(true);
  }, 'text-button'));
  panel.append(toolbar); fieldPanel = el('div');
  if (mode === 'fields') fields(fieldPanel);
  else {
    const label = el('label', 'Input JSON'); label.htmlFor = 'create-json'; jsonEditor = el('textarea'); jsonEditor.id = 'create-json'; jsonEditor.rows = 10; jsonEditor.spellcheck = false; jsonEditor.value = JSON.stringify(draft, null, 2); fieldPanel.append(label, jsonEditor);
  }
  panel.append(fieldPanel);
}
function review(panel) {
  panel.append(el('h2', 'Ready to create this execution?'), el('p', 'Creating saves a new run and its input. A compatible worker picks it up; the result is available after the function finishes.', 'create-help'));
  const facts = el('dl', undefined, 'create-review');
  [['Function', descriptor.name], ['Version', `v${descriptor.version} · pinned for this run`], ['Worker group', descriptor.group], ['Timeout', '1 hour from creation']].forEach(([key, value]) => { const row = el('div'); row.append(el('dt', key), el('dd', value)); facts.append(row); });
  panel.append(facts, presence());
  const payload = el('details', undefined, 'create-payload'); payload.open = true; payload.append(el('summary', 'Input for this run'), el('pre', JSON.stringify(draft, null, 2))); panel.append(payload);
  const behavior = el('div', undefined, 'create-after'); behavior.append(el('strong', 'After you create it'));
  const list = el('ol'); ['TiSona saves an execution ID, the input and the selected function version.', 'Your worker runs the function. Progress and completed checkpoints are saved.', 'Open the execution to follow steps, respond to approvals and inspect the result.'].forEach(s => list.append(el('li', s))); behavior.append(list); panel.append(behavior);
}
function receipt(panel) {
  panel.append(el('span', '✓ ACCEPTED BY TISONA', 'create-receipt-badge'), el('h2', 'Your execution has been created.'), el('p', 'The request was saved. Open the execution to see whether it is waiting, running, needs approval, or has finished.', 'create-help'));
  const id = el('pre', request.state.result.id); panel.append(id);
  const facts = el('p', `${receiptBody.function} · v${receiptBody.version} · timeout 1 hour`, 'create-help'); panel.append(facts);
  const footer = el('div', undefined, 'create-actions');
  footer.append(link('Follow execution →', `#executions/${encodeURIComponent(request.state.result.id)}`), action('Create another execution', () => { request.reset(); step = 0; render(true); })); panel.append(footer);
}
function render(focus = false) {
  if (!root) return;
  const busy = request?.state.busy, pending = request?.state.intent;
  root.replaceChildren();
  const intro = el('div', undefined, 'create-intro'); intro.append(el('p', 'Run code already published by a worker. Each execution has its own input, saved progress and result.')); root.append(intro);
  if (!request?.state.result) root.append(steps());
  const panel = el('article', undefined, 'create-panel'); root.append(panel);
  errorBox = el('div', '', 'inline-error'); errorBox.setAttribute('role', 'alert'); errorBox.tabIndex = -1; errorBox.hidden = true;
  if (request?.state.result) { receipt(panel); return; }
  if (step === 0) selection(panel); else if (step === 1) inputPanel(panel); else review(panel);
  panel.append(errorBox);
  if (request?.state.error) {
    errorBox.hidden = false; errorBox.textContent = `${request.state.error}${pending ? ' The request may already have been accepted. Retry to retrieve the same execution; your original input and request ID are kept.' : ''}`;
  }
  const footer = el('div', undefined, 'create-actions');
  if (step > 0) { const back = action('← Back', () => { if (capture()) { step--; render(true); } }); back.disabled = Boolean(busy || pending); footer.append(back); }
  if (step < 2) {
    const next = action(step === 0 ? 'Continue to input →' : 'Review execution →', () => {
      if (!descriptor || !capture()) return;
      if (step === 1) {
        const errors = inputErrors(draft, descriptor.inputSchema);
        if (errors.length) { const first = errors[0], match = controls.find(c => first.path === `input.${c.name}`); showError(`${first.path.replace(/^input\.?/, '') || 'Input'}: ${first.message}`, mode === 'json' ? jsonEditor : match?.control); return; }
      }
      step++; render(true);
    }, ''); next.disabled = !descriptor; footer.append(next);
  } else {
    const submit = action(busy ? 'Creating…' : pending ? 'Retry same request →' : 'Create execution →', () => {
      receiptBody = request.state.intent?.body ?? { function: descriptor.name, version: descriptor.version, input: structuredClone(draft), timeoutMs: 3600000 };
      request.start(receiptBody);
    }, ''); submit.id = 'create-submit'; submit.disabled = Boolean(busy); footer.append(submit);
  }
  panel.append(footer);
  if (busy) panel.setAttribute('aria-busy', 'true');
  refreshPresence();
  if (focus && active) { const heading = panel.querySelector('h2'); if (heading) { heading.tabIndex = -1; heading.focus(); } }
}
function ensureRequest() {
  if (!data.project || request) return;
  storageKey = `tisona:create:pending:${data.project.endpoint}`;
  let restore;
  try {
    const candidate = JSON.parse(sessionStorage.getItem(storageKey));
    if (candidate && typeof candidate.key === 'string' && /^[\w.-]{1,128}$/.test(candidate.body?.function) && Number.isInteger(candidate.body.version) && candidate.body.version > 0 && Object.hasOwn(candidate.body, 'input')) restore = candidate;
  } catch { /* Storage can be unavailable. The in-memory intent still protects retries. */ }
  request = createStartRequest({ api: (...args) => data.api(...args), changed: () => render(), restore,
    save: intent => { try { if (intent) sessionStorage.setItem(storageKey, JSON.stringify(intent)); else sessionStorage.removeItem(storageKey); } catch { /* In-memory retry remains available. */ } } });
  if (restore) {
    descriptor = data.catalogue.find(d => d.name === restore.body.function && d.version === restore.body.version) ?? { name: restore.body.function, version: restore.body.version, group: '(saved request)', inputSchema: { type: 'object' } };
    draft = structuredClone(restore.body.input); receiptBody = restore.body; step = 2;
    request.state.error = 'A creation request was interrupted.';
  }
}
window.resonateCreate = {
  update(next) {
    const previous = data; data = next; const hadRequest = Boolean(request); ensureRequest();
    if (descriptor) descriptor = data.catalogue.find(d => d.name === descriptor.name && d.version === descriptor.version) ?? descriptor;
    if (!hadRequest && request?.state.intent) render();
    else if (step === 0 && (JSON.stringify(previous.catalogue) !== JSON.stringify(data.catalogue) || previous.loaded !== data.loaded)) render();
    else refreshPresence();
  },
  choose,
  setView(name) {
    active = name === 'new'; clearInterval(freshnessTimer);
    if (active) { refreshPresence(); freshnessTimer = setInterval(refreshPresence, 5000); }
  },
  clear() { clearInterval(freshnessTimer); request = undefined; descriptor = undefined; draft = undefined; receiptBody = undefined; drafts.clear(); step = 0; render(); }
};
render();
window.dispatchEvent(new Event('resonate:create-ready'));
