import { workerExamples, workerGuide } from './worker-examples.js';

const root = document.querySelector('#worker-guide');
let selected = 'typescript', endpoint;
const el = (tag, text, className) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
};
function codeBlock(title, code) {
  const block = el('div', undefined, 'sdk-code');
  const toolbar = el('div', undefined, 'sdk-code-heading');
  const copy = el('button', 'Copy', 'outline'); copy.type = 'button'; copy.setAttribute('aria-label', `Copy ${title}`);
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copy.textContent = 'Copied'; }
    catch { copy.textContent = 'Select code to copy'; }
    setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
  };
  toolbar.append(el('span', title), copy);
  const pre = el('pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', title); pre.append(el('code', code));
  block.append(toolbar, pre); return block;
}
function section(number, title, description, open = false) {
  const details = el('details', undefined, 'sdk-guide-step'); details.open = open;
  const summary = el('summary'); summary.append(el('span', number, 'sdk-step-number'), el('strong', title));
  details.append(summary, el('p', description, 'sdk-step-description')); return details;
}
function render() {
  if (!root || !endpoint) return;
  const example = workerExamples.find(e => e.id === selected), guide = workerGuide(example, endpoint);
  root.replaceChildren();
  const tabs = el('div', undefined, 'sdk-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Worker example language');
  for (const item of workerExamples) {
    const tab = el('button', item.label); tab.type = 'button'; tab.id = `sdk-tab-${item.id}`; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(item.id === selected)); tab.setAttribute('aria-controls', 'sdk-example-panel'); tab.tabIndex = item.id === selected ? 0 : -1;
    const select = () => { selected = item.id; render(); document.querySelector(`#sdk-tab-${selected}`).focus(); };
    tab.onclick = select;
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = workerExamples.findIndex(e => e.id === selected), last = workerExamples.length - 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? last : (index + (event.key === 'ArrowRight' ? 1 : last)) % workerExamples.length;
      selected = workerExamples[next].id; render(); document.querySelector(`#sdk-tab-${selected}`).focus();
    };
    tabs.append(tab);
  }
  const panel = el('div'); panel.id = 'sdk-example-panel'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `sdk-tab-${selected}`);
  const heading = el('div', undefined, 'sdk-example-heading');
  const docs = el('a', 'Official SDK guide ↗'); docs.href = example.docs; docs.target = '_blank'; docs.rel = 'noreferrer';
  heading.append(el('h3', `${example.label} example`), el('span', example.version), docs); panel.append(heading);
  const introduction = el('p', undefined, 'sdk-example-description');
  introduction.append('Publish ', el('code', `${guide.name} v1`), ' and run it with ', el('code', '{"name":"Ada"}'), '. The greeting is saved as a checkpoint. The final result is ', el('code', '"Hello, Ada!"'), '.'); panel.append(introduction);
  const install = section('01', 'Install & configure', 'In a new project folder, install the SDK. Create a Worker key above and set these values in your terminal. Use a unique WORKER_ID for each process.');
  install.append(codeBlock('Install dependencies', example.install));
  if (example.build) install.append(codeBlock(example.buildFile, example.build));
  if (example.note) install.append(el('p', example.note, 'sdk-step-description'));
  install.append(codeBlock('Worker environment', guide.environment));
  const worker = section('02', 'Write & start the worker', `Save this as ${example.file}, then run the start command. Keep this process running while you create executions.`, true);
  worker.append(codeBlock(example.file, example.code), codeBlock('Start worker', example.run));
  const publish = section('03', 'Publish the function & report presence', 'For local testing, save this as register-worker.sh and run it in another terminal with the same environment from step 1. It publishes the input schema and reports every 20 seconds. Stop it when you stop the worker.');
  publish.append(codeBlock('register-worker.sh', guide.publish), codeBlock('Start registration companion', 'sh register-worker.sh'));
  publish.append(el('p', 'For deployment, make these API calls from the worker lifecycle so heartbeats stop when the worker stops. SDK task heartbeats and this project presence API serve separate purposes.', 'sdk-step-description'));
  const invoke = section('04', 'Create an execution', `Once published, select ${guide.name} in New execution, or use the API below with an Agent / client key. Reuse an idempotency key to retry the same request; change it for a new run.`);
  invoke.append(codeBlock('Create & inspect · HTTP', guide.invoke));
  const create = el('a', 'Open New execution →', 'outline'); create.href = '#new'; invoke.append(create);
  panel.append(install, worker, publish, invoke); root.append(tabs, panel);
}
window.resonateWorkerGuide = { setEndpoint(value) { if (value === endpoint) return; endpoint = value; render(); } };
window.dispatchEvent(new Event('resonate:worker-guide-ready'));
