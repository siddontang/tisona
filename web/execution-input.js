// Shared by the creation UI and its tests. The server still validates every request.
export const fieldLabel = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/^./, c => c.toUpperCase());

export function initialInput(descriptor, examples = []) {
  const example = examples.find(e => e.descriptor.name === descriptor.name && e.descriptor.version === descriptor.version);
  if (example && !inputErrors(example.variants[0].input, descriptor.inputSchema).length) return structuredClone(example.variants[0].input);
  if (descriptor.name === 'research') {
    const sample = { topic: 'Durable agents on TiDB', delaySeconds: 2, requireApproval: true };
    if (!inputErrors(sample, descriptor.inputSchema).length) return sample;
  }
  const schema = descriptor.inputSchema;
  if (Object.hasOwn(schema, 'default')) return structuredClone(schema.default);
  if (schema.type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, s]) => Object.hasOwn(s, 'default')).map(([k, s]) => [k, structuredClone(s.default)]));
  return schema.type === 'array' ? [] : schema.type === 'null' ? null : schema.type === 'boolean' ? false : schema.type === 'string' ? '' : 0;
}

export function inputErrors(value, schema, path = 'input') {
  const errors = [], fail = message => errors.push({ path, message });
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (schema.type !== type && !(schema.type === 'integer' && Number.isInteger(value))) { fail(`Must be ${schema.type}.`); return errors; }
  if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) fail('Choose an allowed value.');
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push({ path: `${path}.${key}`, message: 'This field is required.' });
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) errors.push(...inputErrors(item, schema.properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'Unknown field.' });
    }
  }
  if (type === 'array' && schema.items) value.forEach((v, i) => errors.push(...inputErrors(v, schema.items, `${path}[${i}]`)));
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) fail(`Use at least ${schema.minLength} characters.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`Use at most ${schema.maxLength} characters.`);
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) fail('Enter a finite number.');
    if (schema.minimum !== undefined && value < schema.minimum) fail(`Minimum: ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`Maximum: ${schema.maximum}.`);
  }
  return errors;
}

export function compatibleWorkers(descriptor, workers, observedAt, now = Date.now()) {
  const known = Boolean(observedAt && now >= observedAt && now - observedAt < 15000);
  const online = known ? workers.filter(w => w.online && (!w.expiresAt || w.expiresAt > now) && w.group === descriptor.group && w.functions.some(f => f.name === descriptor.name && f.version === descriptor.version)).length : 0;
  return { known, online };
}

// Lock the body and key before sending. An ambiguous result must be retried
// with the same identity, even if the catalogue changes or the page reloads.
export function createStartRequest({ api, changed = () => {}, save = () => {}, restore, uuid = () => crypto.randomUUID() }) {
  const state = { intent: restore, busy: false, result: undefined, error: '' };
  return {
    state,
    reset() { if (state.busy || state.intent) return false; state.result = undefined; state.error = ''; return true; },
    async start(body) {
      if (state.busy || state.result) return;
      state.intent ??= { key: uuid(), body: structuredClone(body) };
      save(state.intent); state.busy = true; state.error = ''; changed(state);
      try {
        const result = await api('/v1/executions', { method: 'POST', headers: { 'Idempotency-Key': state.intent.key }, body: JSON.stringify(state.intent.body), signal: AbortSignal.timeout(15000) });
        if (typeof result.id !== 'string' || !result.id) throw new Error('The service did not return an execution ID.');
        state.result = result; state.intent = undefined; save(undefined);
      } catch (error) {
        if (error.status && error.status < 500 && ![408, 429].includes(error.status)) { state.intent = undefined; save(undefined); }
        state.error = error.message;
      } finally { state.busy = false; changed(state); }
    }
  };
}
