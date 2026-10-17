// One independent execution per example. View changes never create executions,
// and a start whose response was lost is retried with the same request identity.
export function exampleAvailability(example, catalogue, workers, observedAt, now = Date.now()) {
  const descriptor = example.descriptor, known = Boolean(observedAt && now - observedAt >= 0 && now - observedAt < 15000);
  const online = known ? workers.filter(worker => worker.online && worker.group === descriptor.group && worker.functions.some(f => f.name === descriptor.name && f.version === descriptor.version)).length : 0;
  return { known, online, available: Boolean(online && catalogue.some(f => f.name === descriptor.name && f.version === descriptor.version && f.group === descriptor.group)) };
}
export function createExampleSession({ example, api, changed, restore = {}, save = () => {}, clock = globalThis }) {
  let active = false, timer, controller, generation = 0;
  const state = { id: restore.id, intent: restore.intent, run: undefined, mode: restore.id ? 'live' : 'preview', busy: false, stale: false, error: '', feedback: '', observedAt: undefined };
  const emit = () => changed(state);
  const persist = () => save({ id: state.id, intent: state.intent });
  function stop() { clock.clearTimeout(timer); controller?.abort(); controller = undefined; }
  function schedule() {
    clock.clearTimeout(timer);
    if (active && state.id && (!state.run || state.run.state === 'pending' || state.stale)) timer = clock.setTimeout(() => load(), 2000);
  }
  async function load() {
    if (!active || !state.id || controller) return;
    clock.clearTimeout(timer);
    const id = state.id, revision = generation, request = new AbortController(); controller = request;
    try {
      const run = await api(`/v1/executions/${encodeURIComponent(id)}`, { signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) });
      if (request.signal.aborted || revision !== generation || id !== state.id || !active) return;
      if (run.id !== id || run.function !== example.descriptor.name || run.version !== example.descriptor.version) throw new Error('This saved run belongs to a different example.');
      state.run = run; state.observedAt = Date.now(); state.stale = false; state.error = ''; emit();
    } catch (error) {
      if (request.signal.aborted || revision !== generation || !active) return;
      if (error.status === 404 && !state.run) { state.id = undefined; state.mode = 'preview'; persist(); state.error = 'The saved execution is no longer available. You can start a new run.'; }
      else { state.stale = true; state.error = `${state.run ? 'Keeping the last saved view. ' : ''}${error.message} Retrying automatically.`; }
      emit();
    } finally {
      if (controller === request) { controller = undefined; schedule(); }
    }
  }
  return {
    state,
    activate(value) {
      if (active === value) return;
      active = value;
      if (!active) { stop(); if (state.run?.state === 'pending') { state.stale = true; emit(); } }
      else { emit(); if (state.id && (!state.run || state.run.state === 'pending' || state.stale)) load(); }
    },
    async start(input) {
      if (state.busy || state.run?.state === 'pending' || state.id && !state.run) return;
      let accepted = false;
      state.intent ??= { key: crypto.randomUUID(), input: structuredClone(input) };
      persist(); state.busy = true; state.error = ''; state.feedback = ''; emit();
      try {
        const result = await api('/v1/executions', { method: 'POST', headers: { 'Idempotency-Key': state.intent.key },
          body: JSON.stringify({ function: example.descriptor.name, version: example.descriptor.version, input: state.intent.input }), signal: AbortSignal.timeout(15000) });
        stop(); generation++;
        state.id = result.id; state.mode = 'live'; state.run = { id: result.id, function: example.descriptor.name, version: example.descriptor.version, workerGroup: example.descriptor.group,
          state: 'pending', input: state.intent.input, steps: [], waits: [], tasks: [] };
        state.intent = undefined; state.observedAt = undefined; state.stale = false; accepted = true; persist();
      } catch (error) {
        // Validation/auth failures are definitive. Transport/server failures can
        // have committed the start, so keep the original body and key.
        if (error.status && error.status < 500 && error.status !== 408 && error.status !== 429) { state.intent = undefined; persist(); }
        state.error = error.message + (state.intent ? ' Use Retry start to reconnect to the same request.' : '');
      } finally { state.busy = false; emit(); if (accepted) load(); }
    },
    async mutate(action, body) {
      if (!['waits', 'cancel'].includes(action) || state.busy || !state.id || state.run?.state !== 'pending') return;
      if (action === 'waits' && !state.run.waits.some(wait => wait.id === body?.waitId)) return;
      const id = state.id; state.busy = true; state.error = ''; state.feedback = ''; emit();
      try {
        await api(`/v1/executions/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15000) });
        if (id === state.id) state.feedback = action === 'cancel' ? 'Cancellation recorded.' : body.value.approved ? 'Approval saved. Continuing this run.' : 'Decision saved. No refund will be issued.';
      } catch (error) { if (id === state.id) state.error = error.message; }
      finally { state.busy = false; emit(); if (active && state.id === id) { stop(); await load(); } }
    },
    preview() { if (state.busy || state.intent || state.run?.state === 'pending') return false; state.mode = 'preview'; emit(); return true; },
    follow() { if (state.id) { state.mode = 'live'; emit(); load(); } },
    refresh: load,
    dispose() { active = false; generation++; stop(); }
  };
}
