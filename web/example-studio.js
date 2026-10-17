import { createPlayer } from './walkthrough.js';
import { exampleStory } from './walkthrough-data.js';
import { liveExecutionScene } from './live-execution.js';
import { createExampleSession, exampleAvailability } from './example-session.js';

const cards = new Map(), reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let currentView = '', overviewExample = 'tool-retry';
const el = (tag, className, text) => { const node = document.createElement(tag); node.className = className ?? ''; if (text != null) node.textContent = text; return node; };
const button = (label, action, className = 'outline') => { const node = el('button', className, label); node.type = 'button'; node.onclick = action; return node; };
const outcomes = { refunded: 'Refunded', declined: 'Declined', recovered: 'Recovered', exhausted: 'Retry budget exhausted', compensated: 'Compensated', fulfilled: 'Fulfilled', indexed: 'Indexed' };
function saved(id) {
  try {
    const value = JSON.parse(sessionStorage.getItem(`resonate.example.${id}.v1`) ?? '{}');
    return { id: /^[\w.-]{1,128}$/.test(value.id ?? '') ? value.id : undefined,
      intent: typeof value.intent?.key === 'string' && value.intent.key.length < 100 && value.intent.input && typeof value.intent.input === 'object' ? value.intent : undefined };
  } catch { return {}; }
}
function store(id, value) { try { sessionStorage.setItem(`resonate.example.${id}.v1`, JSON.stringify(value)); } catch { /* Optional local continuity. */ } }
function createCard(example, host, api) {
  let available = false, enabled = false, presence = {}, previewKey, lastRunId, lastMode, selectedStep, actionsKey, current, projection;
  const card = el('article', 'case-card'); card.id = `case-${example.id}`; card.setAttribute('aria-label', example.title);
  const top = el('div', 'case-top'), badge = el('span', 'badge', example.category), number = el('span', 'case-number', example.number), status = el('span', 'case-status', 'Interactive preview');
  top.append(badge, status, number);
  const layout = el('div', 'case-layout'), copy = el('div', 'case-copy'), stage = el('div', 'case-stage');
  const heading = el('h2', '', example.title), description = el('p', 'case-description', example.description);
  const value = el('div', 'case-value'); value.append(el('span', '', 'WHAT SURVIVES'), el('p', '', example.value));
  const select = el('select'); select.id = `example-${example.id}`;
  for (const [index, variant] of example.variants.entries()) { const option = el('option', '', variant.name); option.value = String(index); select.append(option); }
  const label = el('label', '', 'Scenario'); label.setAttribute('for', select.id);
  const input = el('details', 'case-input'), pre = el('pre'); input.append(el('summary', '', 'View scenario input'), pre);
  const controls = el('div', 'case-controls'), message = el('p', 'case-message'); message.setAttribute('role', 'status'); message.hidden = true;
  const workerHelp = el('div', 'case-worker-help'); workerHelp.hidden = true;
  const workerGuide = el('a', '', 'Worker setup guide →'); workerGuide.href = '#access';
  workerHelp.append(el('strong', '', 'Live runs need a compatible worker.'), el('p', '', 'For this local demo, start the bundled example worker and keep it running.'), el('pre', '', 'npm run worker:examples'), workerGuide);
  const loading = el('p', 'case-loading', 'Loading the saved execution…'); loading.setAttribute('role', 'status'); loading.hidden = true;
  const visual = el('div', 'case-visual'), actions = el('div', 'case-decisions'), runInfo = el('details', 'case-run-info'), runId = el('code'), runResult = el('pre');
  runInfo.append(el('summary', '', 'Execution ID & result'), runId, runResult); runInfo.hidden = true;
  const inspector = el('details', 'case-inspector'), inspectorSummary = el('summary'), inspectorId = el('code'), inspectorInput = el('pre'), inspectorResult = el('pre'), inspectorInputTitle = el('h4', '', 'Input');
  inspector.append(inspectorSummary, inspectorId, inspectorInputTitle, inspectorInput, el('h4', '', 'Result'), inspectorResult); inspector.hidden = true;
  stage.append(loading, visual, actions, inspector, runInfo);
  const player = createPlayer(visual, `${example.title} animation`);
  player.interaction.append(actions);
  const session = createExampleSession({ example, api, restore: saved(example.id), save: value => store(example.id, value), changed: render });
  const launch = button('Run example →', () => session.start(preset()), 'case-run'); launch.setAttribute('aria-label', `Run ${example.title}`);
  const preview = button('Replay preview', () => { if (session.preview()) { previewKey = undefined; render(session.state); if (!reduced.matches) player.play(); } }); preview.setAttribute('aria-label', `Preview ${example.title}`);
  const follow = button('Show last run', () => session.follow(), 'text-button'); follow.hidden = true;
  const cancel = button('Cancel run', () => session.mutate('cancel'), 'text-button danger'); cancel.hidden = true;
  controls.append(launch, preview, follow, cancel);
  copy.append(heading, description, value, label, select, input, controls, workerHelp, message);
  layout.append(copy, stage); card.append(top, layout); host.append(card);
  const preset = () => example.variants[Number(select.value) || 0].input;
  const selectPreset = input => {
    const normalized = value => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    const variant = example.variants.findIndex(variant => normalized(variant.input) === normalized(input));
    if (variant >= 0) select.value = String(variant);
  };
  const updateInput = () => { pre.textContent = JSON.stringify(preset(), null, 2); };
  const entryLabel = () => session.state.busy && session.state.run?.state !== 'pending' ? 'Starting demo…' : session.state.run?.state === 'pending' || session.state.id && !session.state.run ? 'Follow live demo ↓' : session.state.intent ? 'Retry demo request →' : available ? 'Run this example →' : 'Preview this example ↓';
  select.onchange = () => { updateInput(); session.preview(); previewKey = undefined; render(session.state); };
  function showInspector() {
    const step = current.run?.steps.find(step => step.id === selectedStep);
    inspector.hidden = !step || current.mode !== 'live';
    if (!step) return;
    const record = projection?.live.records.find(record => record.id === step.id);
    inspectorSummary.textContent = record ? `${record.label} · ${record.text}` : `${step.function || 'Execution'} · ${step.state}`;
    inspectorId.textContent = step.id;
    inspectorInputTitle.textContent = step.inputKind === 'metadata' ? 'Invocation metadata' : 'Input';
    inspectorInput.textContent = JSON.stringify(step.id === current.run.id ? current.run.input : step.input, null, 2) ?? 'No input recorded.';
    inspectorResult.textContent = step.state === 'pending' ? 'Pending — waiting for the service to record a result.' : record?.text === 'Timer elapsed' ? 'The durable timer elapsed.' : JSON.stringify(step.result, null, 2) ?? 'No result recorded.';
  }
  function render(state) {
    current = state;
    const pending = state.run?.state === 'pending', live = state.mode === 'live';
    if (state.id && state.run && (state.id !== lastRunId || live && lastMode !== 'live')) {
      if (state.id !== lastRunId) { selectedStep = undefined; inspector.open = false; }
      lastRunId = state.id;
      selectPreset(state.run.input);
    }
    if (state.intent) selectPreset(state.intent.input);
    updateInput();
    card.dataset.mode = state.mode; card.dataset.state = state.run?.state ?? 'preview';
    status.textContent = state.busy && !pending ? 'Starting…' : live ? state.stale ? 'Updates paused' : pending ? state.run.waits?.length ? 'Waiting for approval' : 'Live execution' : outcomes[state.run?.result?.outcome] ?? (state.run?.state === 'resolved' ? 'Completed' : state.run?.state === 'rejected_canceled' ? 'Canceled' : state.run ? 'Execution ended' : 'Loading run…') : 'Interactive preview';
    select.disabled = state.busy || pending || Boolean(state.intent) || Boolean(state.id && !state.run);
    launch.disabled = state.busy || pending || Boolean(state.id && !state.run) || !available && !state.intent;
    launch.textContent = state.busy ? 'Working…' : pending ? 'Execution running' : state.intent ? 'Retry start →' : !available ? 'Worker offline' : state.id ? 'Run again →' : 'Run example →';
    preview.disabled = state.busy || pending || Boolean(state.intent); follow.hidden = live || !state.id;
    cancel.hidden = !pending; cancel.disabled = state.busy;
    message.textContent = state.error || (live ? state.feedback : ''); message.hidden = !message.textContent; message.dataset.error = String(Boolean(state.error));
    loading.hidden = !live || Boolean(state.run); visual.hidden = live && !state.run;
    if (live && state.run) {
      const scene = liveExecutionScene(state.run, presence);
      projection = scene;
      if (scene) player.load(scene, { compact: true, observedAt: state.observedAt, stale: state.stale, onRefresh: () => session.refresh(),
        onSelect: id => { selectedStep = id; showInspector(); inspector.open = true; } });
    } else if (!live) {
      const key = JSON.stringify(preset());
      if (previewKey !== key || visual.dataset.mode !== 'preview') { player.load(exampleStory(example.id, preset()), { compact: true }); previewKey = key; }
    }
    visual.dataset.mode = state.mode;
    runInfo.hidden = !live || !state.run;
    if (state.run) { runId.textContent = state.id; runResult.textContent = state.run.state === 'pending' ? 'Result will appear here when this run finishes.' : JSON.stringify(state.run.result, null, 2) ?? 'No result recorded.'; }
    const key = JSON.stringify([live, state.run?.state, state.run?.waits, state.busy]);
    if (actionsKey !== key) {
      actionsKey = key; actions.replaceChildren();
      for (const wait of live && pending ? state.run.waits ?? [] : []) {
        const step = state.run.steps.find(step => step.id === wait.id), group = el('div', 'case-approval');
        group.append(el('strong', '', step?.tags?.['cloud:prompt'] || 'Approve this run to continue?'), el('p', '', 'Your decision is saved with this execution.'));
        const buttons = el('div');
        for (const approved of [true, false]) { const action = button(approved ? 'Approve & continue' : 'Decline', () => session.mutate('waits', { waitId: wait.id, value: { approved } }), approved ? '' : 'outline'); action.disabled = state.busy; buttons.append(action); }
        group.append(buttons); actions.append(group);
      }
    }
    showInspector();
    player.activate(enabled && !document.hidden);
    if (card.parentElement?.id === 'overview-example') document.querySelector('#overview-try').textContent = entryLabel();
    lastMode = state.mode;
  }
  render(session.state);
  return { card,
    entryLabel,
    enter() {
      if (session.state.run?.state === 'pending' || session.state.id && !session.state.run) session.follow();
      else if (!launch.disabled) launch.click();
      else if (!available && !preview.disabled) preview.click();
      stage.scrollIntoView({ block: 'center', behavior: reduced.matches ? 'instant' : 'smooth' });
    },
    update(eligible, workerPresence) { available = eligible; presence = workerPresence; workerHelp.hidden = eligible; render(session.state); },
    activate(value) { enabled = value; session.activate(value); player.activate(value); },
    pauseMotion() { player.pause(); },
    dispose() { session.dispose(); player.dispose(); card.remove(); }
  };
}
// Move the same card between surfaces. Its session, pending request, inspector
// and animation remain intact; switching pages never creates a second run.
function placeCards() {
  const gallery = document.querySelector('#examples-list'), overview = document.querySelector('#overview-example');
  for (const [id, value] of cards) {
    const target = currentView === 'overview' && id === overviewExample ? overview : gallery;
    if (value.card.parentElement !== target) {
      if (target === overview) target.replaceChildren(value.card);
      else gallery.append(value.card);
    }
    value.activate(!document.hidden && !document.querySelector('#shell').hidden && (currentView === 'examples' || currentView === 'overview' && id === overviewExample));
  }
  if (currentView === 'examples') {
    let index = 0;
    for (const value of cards.values()) { if (gallery.children[index] !== value.card) gallery.insertBefore(value.card, gallery.children[index] ?? null); index++; }
  }
  for (const b of document.querySelectorAll('[data-overview-example]')) b.setAttribute('aria-pressed', String(b.dataset.overviewExample === overviewExample));
  const entry = document.querySelector('#overview-try'), selected = cards.get(overviewExample);
  entry.disabled = !selected;
  entry.textContent = selected ? selected.entryLabel() : 'Loading demo…';
}
document.querySelector('#overview-try').onclick = () => cards.get(overviewExample)?.enter();
for (const b of document.querySelectorAll('[data-overview-example]')) b.onclick = () => { overviewExample = b.dataset.overviewExample; placeCards(); };
window.resonateExamples = {
  render({ examples, catalogue, workers, workersObservedAt, api, view }) {
    currentView = view;
    const host = document.querySelector('#examples-list');
    for (const [id, value] of cards) if (!examples.some(example => example.id === id)) { value.dispose(); cards.delete(id); }
    for (const example of examples) {
      if (!cards.has(example.id)) cards.set(example.id, createCard(example, host, api));
      const value = cards.get(example.id), availability = exampleAvailability(example, catalogue, workers, workersObservedAt);
      value.update(availability.available, availability);
    }
    placeCards();
  },
  setView(view) { currentView = view; placeCards(); },
  pause() { currentView = ''; for (const value of cards.values()) value.activate(false); },
  clear() { for (const value of cards.values()) value.dispose(); cards.clear(); }
};
document.addEventListener('visibilitychange', placeCards);
reduced.addEventListener('change', () => { if (reduced.matches) for (const value of cards.values()) value.pauseMotion(); });
window.dispatchEvent(new Event('resonate:examples-ready'));
