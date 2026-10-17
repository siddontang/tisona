import { liveExecutionScene } from './live-execution.js';

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const colors = { idle: 'var(--flow-idle)', active: 'var(--flow-active)', saved: 'var(--flow-saved)', waiting: 'var(--flow-waiting)', failed: 'var(--flow-failed)' };
let sequence = 0;
function element(tag, className, text) {
  const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el;
}
function svgElement(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value); return el;
}
export function createPlayer(host, label, live = false) {
  const uid = `walkthrough-${++sequence}`;
  const root = element('div', 'walkthrough-player'); root.setAttribute('role', 'region'); root.setAttribute('aria-label', label);
  const top = element('div', 'walkthrough-top');
  const title = element('strong'), type = element('span', 'walkthrough-type', live ? 'Live execution' : 'Illustrated walkthrough'); top.append(title, type);
  root.dataset.mode = live ? 'live' : 'preview';
  const update = element('div', 'live-update'), freshness = element('span'), refresh = element('button', 'text-button', 'Refresh now');
  refresh.type = 'button'; update.append(freshness, refresh); update.hidden = !live;
  const context = element('p', 'live-context'); context.hidden = !live;
  const records = element('details', 'live-records'), recordsTitle = element('summary'), recordsList = element('div', 'live-record-list');
  records.append(recordsTitle, recordsList); records.hidden = !live;
  const scene = element('div', 'walkthrough-scene');
  const svg = svgElement('svg', { class: 'walkthrough-links', 'aria-hidden': 'true' });
  const defs = svgElement('defs', {});
  for (const [status, color] of Object.entries(colors)) {
    const marker = svgElement('marker', { id: `${uid}-${status}`, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto' });
    marker.append(svgElement('path', { d: 'M 0 1 L 8 5 L 0 9', fill: 'none', stroke: color, 'stroke-width': 1.5 })); defs.append(marker);
  }
  svg.append(defs); scene.append(svg);
  const ledger = element('div', 'walkthrough-ledger'); ledger.setAttribute('aria-label', 'Saved progress');
  const interaction = element('div', 'walkthrough-interaction');
  const caption = element('div', 'walkthrough-caption'), headline = element('h3'), copy = element('p'); caption.append(headline, copy);
  const controls = element('div', 'walkthrough-controls');
  const play = element('button', 'walkthrough-play', 'Play'); play.type = 'button';
  const previous = element('button', 'walkthrough-step', '←'), next = element('button', 'walkthrough-step', '→');
  previous.type = next.type = 'button'; previous.setAttribute('aria-label', 'Previous walkthrough step'); next.setAttribute('aria-label', 'Next walkthrough step');
  const seek = element('input', 'walkthrough-seek'); seek.type = 'range'; seek.min = 0; seek.step = 1; seek.setAttribute('aria-label', 'Walkthrough step');
  const position = element('span', 'walkthrough-position'); controls.append(play, previous, seek, next, position);
  const legend = element('div', 'walkthrough-legend');
  for (const [status, name] of [['active', live ? 'Pending work' : 'Running'], ['saved', 'Saved'], ['waiting', 'Waiting'], ['failed', live ? 'Failed response / step' : 'Unavailable']]) legend.append(element('span', `legend-${status}`, name));
  controls.hidden = live;
  root.append(top, update, scene, interaction, ledger, caption, context, records, controls, legend); host.replaceChildren(root);
  let story, index = 0, playing = false, active = false, visible = false, started = false, timeout;
  let options = {}, stale = false, recordsFingerprint;
  const nodeViews = new Map(), paths = [], packets = [];
  function drawLinks() {
    if (!story || !scene.clientWidth) return;
    const area = scene.getBoundingClientRect(); svg.setAttribute('viewBox', `0 0 ${area.width} ${area.height}`);
    story.edges.forEach(([from, to], i) => {
      const a = nodeViews.get(from).el.getBoundingClientRect(), b = nodeViews.get(to).el.getBoundingClientRect();
      const vertical = Math.abs(a.x - b.x) < 3 || story.layout === 'line' && Math.abs(a.y - b.y) > 3;
      const backwards = vertical ? a.y > b.y : a.x > b.x;
      let x1, y1, x2, y2, d;
      if (vertical) {
        x1 = a.x + a.width / 2 - area.x; x2 = b.x + b.width / 2 - area.x;
        y1 = (backwards ? a.top : a.bottom) - area.y; y2 = (backwards ? b.bottom : b.top) - area.y;
        // Reverse compensation takes its own lane instead of covering the
        // forward edge. Anchors still belong to the same persistent nodes.
        const bend = backwards ? 18 : 0;
        d = `M ${x1} ${y1} C ${x1 + bend} ${(y1 + y2) / 2}, ${x2 + bend} ${(y1 + y2) / 2}, ${x2} ${y2}`;
      } else {
        x1 = (backwards ? a.left : a.right) - area.x; x2 = (backwards ? b.right : b.left) - area.x;
        y1 = a.y + a.height / 2 - area.y; y2 = b.y + b.height / 2 - area.y;
        const bend = backwards ? 18 : 0;
        d = `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1 + bend}, ${(x1 + x2) / 2} ${y2 + bend}, ${x2} ${y2}`;
      }
      paths[i].setAttribute('d', d);
    });
  }
  function render() {
    const frame = story.frames[index];
    root.dataset.frame = String(index); root.dataset.story = story.id;
    if (headline.textContent !== frame.title) headline.textContent = frame.title;
    if (copy.textContent !== frame.caption) copy.textContent = frame.caption;
    for (const [id, view] of nodeViews) {
      const value = frame.nodes[id] ?? { status: 'idle', text: 'Not started' };
      view.el.dataset.state = value.status; view.detail.textContent = value.text;
      view.symbol.textContent = { saved: '✓', active: '↗', waiting: 'Ⅱ', failed: '×', idle: '·' }[value.status];
      if (live) {
        view.el.disabled = !story.live.stepIds[id];
        view.el.setAttribute('aria-label', `${view.label} · ${value.text}${view.el.disabled ? '' : ' · Inspect recorded step'}`);
      } else { view.el.disabled = true; view.el.setAttribute('aria-label', `${view.label} · ${value.text}`); }
    }
    story.edges.forEach((_, i) => {
      const status = frame.activeEdges.includes(i) ? 'active' : frame.doneEdges.includes(i) ? 'saved' : 'idle';
      paths[i].setAttribute('class', `walkthrough-edge edge-${status}`); paths[i].setAttribute('marker-end', `url(#${uid}-${status})`);
      packets[i].setAttribute('class', `flow-packet packet-${status}`);
    });
    ledger.replaceChildren(element('span', 'ledger-label', 'Saved progress'), ...(frame.saved.length ? frame.saved.map(text => element('span', 'ledger-checkpoint', `✓ ${text}`)) : [element('span', 'ledger-empty', 'No checkpoint yet')]));
    position.textContent = `${index + 1} / ${story.frames.length}`; seek.value = String(index); seek.setAttribute('aria-valuetext', `${index + 1}: ${frame.title}`);
    previous.disabled = index === 0; next.disabled = index === story.frames.length - 1;
    play.textContent = playing ? 'Pause' : index === story.frames.length - 1 ? 'Replay' : 'Play';
    play.setAttribute('aria-label', `${playing ? 'Pause' : index === story.frames.length - 1 ? 'Replay' : 'Play'} walkthrough`);
    root.dataset.playing = String(live ? active && visible && !document.hidden && !stale && story.live.state === 'pending' : playing);
    caption.setAttribute('aria-live', playing ? 'off' : 'polite');
    if (!live) { type.textContent = 'Illustrated preview'; delete root.dataset.execution; delete root.dataset.stale; }
    if (live) {
      const data = story.live;
      type.textContent = stale ? 'Updates paused' : data.state === 'pending' ? 'Live execution' : 'Recorded outcome';
      root.dataset.stale = String(stale); root.dataset.execution = data.executionId;
      const at = options.observedAt ? new Date(options.observedAt).toLocaleTimeString() : '—';
      freshness.textContent = `${stale ? 'Connection interrupted · Last update' : data.state === 'pending' ? 'Updates every 2s · Last update' : 'Final update'} ${at}`;
      context.textContent = `${data.completedSteps} saved checkpoints · ${data.failedSteps} recorded failure${data.failedSteps === 1 ? '' : 's'}. ${data.workerText}${data.taskState ? ` · Task ${data.taskState}` : ''}. ${data.truncated ? 'Partial view; some steps are outside this response.' : 'Select a node or recorded step to inspect its data.'}`;
      recordsTitle.textContent = `Recorded steps (${data.records.length})`;
      const fingerprint = JSON.stringify(data.records);
      if (recordsFingerprint !== fingerprint) {
        recordsFingerprint = fingerprint;
        recordsList.replaceChildren(...data.records.map(record => {
          const row = element('button', 'live-record'); row.type = 'button'; row.dataset.state = record.status;
          row.append(element('strong', '', record.label), element('span', '', record.text), element('time', '', record.timestamp ? new Date(record.timestamp).toLocaleTimeString() : '—'));
          row.setAttribute('aria-label', `Inspect recorded ${record.label} · ${record.text}`);
          row.onclick = () => options.onSelect?.(record.id); return row;
        }));
      }
    }
    drawLinks();
  }
  function pause() { playing = false; clearTimeout(timeout); if (story) render(); }
  function schedule() {
    clearTimeout(timeout);
    if (!playing || !active || !visible || document.hidden) return;
    timeout = setTimeout(() => {
      if (index < story.frames.length - 1) index++;
      if (index === story.frames.length - 1) playing = false;
      render(); schedule();
    }, 3400);
  }
  function start() { if (live || !story || !active) return; if (index === story.frames.length - 1) index = 0; playing = true; started = true; render(); schedule(); }
  function enter() { if (live) { if (story) render(); return; } if (active && visible && !started && !motion.matches && !document.hidden) start(); }
  play.onclick = () => playing ? pause() : start();
  previous.onclick = () => { pause(); index = Math.max(0, index - 1); render(); };
  next.onclick = () => { pause(); index = Math.min(story.frames.length - 1, index + 1); render(); };
  seek.oninput = () => { const value = Number(seek.value); pause(); index = value; render(); };
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; if (!visible) pause(); else { enter(); schedule(); } }, { threshold: 0.15 }); observer.observe(root);
  const resize = new ResizeObserver(drawLinks); resize.observe(scene);
  refresh.onclick = () => options.onRefresh?.();
  return {
    interaction,
    load(value, config = {}) {
      const same = story && JSON.stringify([story.nodes, story.edges]) === JSON.stringify([value.nodes, value.edges]);
      const continuing = live && value.live && story?.id === value.id;
      if (!continuing) pause();
      options = config; stale = Boolean(config.stale);
      live = Boolean(value.live); story = value;
      root.dataset.mode = live ? 'live' : 'preview'; root.dataset.compact = String(Boolean(config.compact));
      if (!continuing) { index = 0; started = false; recordsFingerprint = undefined; records.open = live && !config.compact; }
      controls.hidden = live; update.hidden = !live; context.hidden = !live || config.compact; records.hidden = !live;
      title.textContent = config.compact ? 'Execution flow' : story.title;
      for (const [status, name] of [['active', live ? 'Pending work' : 'Running'], ['saved', 'Saved'], ['waiting', 'Waiting'], ['failed', 'Failed']]) legend.querySelector(`.legend-${status}`).textContent = name;
      if (same) { seek.max = String(story.frames.length - 1); render(); if (!continuing) enter(); return; }
      for (const view of nodeViews.values()) view.el.remove(); nodeViews.clear();
      for (const path of paths) path.remove(); paths.length = 0;
      for (const packet of packets) packet.remove(); packets.length = 0;
      scene.className = `walkthrough-scene scene-${story.layout} nodes-${story.nodes.length} docs-${story.nodes.length - 2}`;
      for (const item of story.nodes) {
        const el = element('button', `walkthrough-node node-${item.id}`), label = element('strong', '', item.label), detail = element('span', 'node-detail'), symbol = element('span', 'node-symbol');
        el.type = 'button'; el.onclick = () => { if (live) options.onSelect?.(story.live.stepIds[item.id]); };
        symbol.setAttribute('aria-hidden', 'true'); el.append(symbol, label, detail); scene.append(el); nodeViews.set(item.id, { el, detail, symbol, label: item.label });
      }
      for (const [i, [from, to]] of story.edges.entries()) {
        const backwards = story.nodes.findIndex(n => n.id === from) > story.nodes.findIndex(n => n.id === to);
        const path = svgElement('path', { id: `${uid}-edge-${i}`, 'data-reverse': String(backwards) }); paths.push(path); svg.append(path);
        const packet = svgElement('circle', { r: 3, class: 'flow-packet' });
        const travel = svgElement('animateMotion', { dur: '1.8s', repeatCount: 'indefinite' });
        travel.append(svgElement('mpath', { href: `#${uid}-edge-${i}` })); packet.append(travel); svg.append(packet); packets.push(packet);
      }
      seek.max = String(story.frames.length - 1); render(); enter();
    },
    activate(value) { active = value; if (!active) pause(); else enter(); },
    stale(id) { if (story?.id === id) { stale = true; render(); } },
    dispose() { pause(); observer.disconnect(); resize.disconnect(); root.remove(); },
    pause,
    play: start
  };
}

const live = createPlayer(document.querySelector('#execution-walkthrough'), 'Live execution progress', true);
window.resonateWalkthrough = {
  setView(name) { live.activate(name === 'executions'); },
  setExecution(run, options) {
    const scene = liveExecutionScene(run, options.presence);
    document.querySelector('#live-execution').hidden = !scene;
    if (scene) live.load(scene, options);
  },
  executionStale(id) { live.stale(id); },
  clearExecution() { document.querySelector('#live-execution').hidden = true; live.pause(); }
};
document.addEventListener('visibilitychange', () => { live.activate(!document.hidden && !document.querySelector('[data-panel="executions"]').hidden); });
