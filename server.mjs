import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { ControlStore } from './store.mjs';
import { Metrics, metricRoute } from './metrics.mjs';
import { examples } from './examples/catalogue.mjs';
import { loadConfig, databaseOptions, internalToken, encode, decode, digest, isLoopback, testLoginEnabled } from './config.mjs';

import { ApiError, check, validateFunction, validateSchema, validateInput, canonical, executionId } from './domain.mjs';
export { ApiError, check, validateFunction, validateSchema, validateInput, canonical, executionId } from './domain.mjs';

async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    check(size <= 1024 * 1024, 'Request exceeds 1 MiB', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new ApiError(400, 'Invalid JSON'); }
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
const protocolKinds = new Set(['promise.create', 'promise.get', 'promise.settle', 'promise.search', 'promise.register_listener', 'promise.register_callback',
  'task.create', 'task.get', 'task.acquire', 'task.release', 'task.fulfill', 'task.suspend', 'task.fence', 'task.halt', 'task.continue', 'task.heartbeat']);

export function createApp(config, db, { logError = console.error, store = new ControlStore(db, config), streamAuthIntervalMs = 15000, probeTimeoutMs = 3000 } = {}) {
  const metrics = new Metrics(), streams = new Map();
  const envelope = (kind, data) => ({ kind, head: { corrId: randomBytes(12).toString('hex'), version: '2026-04-01', auth: internalToken(config) }, data });
  async function rpc(kind, data, consoleRoute = false) {
    const response = await fetch(config.engineUrl + (consoleRoute ? '/console/rpc' : '/'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope(kind, data)), signal: AbortSignal.timeout(20000)
    });
    const result = await response.json();
    if (!response.ok || result.head.status >= 300) {
      const message = typeof result.data === 'string' ? result.data : result.data?.message ?? 'Execution service refused the request';
      throw new ApiError(result.head.status || response.status, message);
    }
    return result.data;
  }
  async function detail(id) {
    check(typeof id === 'string' && /^[\w.-]{1,128}$/.test(id), 'Invalid execution ID');
    const view = await rpc('ui.execution.get', { id }, true);
    return { id, function: view.nodes.find(n => n.id === id)?.func, version: decode(view.root.param)?.version, state: view.root.state, result: decode(view.root.value), input: decode(view.root.param)?.args?.[0],
      workerGroup: /^poll:\/\/any@([\w.-]{1,128})$/.exec(view.root.tags?.['resonate:target'])?.[1],
      createdAt: view.root.createdAt, settledAt: view.root.settledAt, timeoutAt: view.root.timeoutAt, truncated: view.truncated,
      consoleUrl: `${config.consoleUrl ?? config.publicUrl}/#executions/${encodeURIComponent(id)}`,
      steps: view.nodes.map(n => {
        const param = decode(n.param);
        return { id: n.id, parentId: n.parentId, function: n.func, state: n.state,
          input: param?.args ?? param, inputKind: param?.func && !Object.hasOwn(param, 'args') ? 'metadata' : 'input',
          result: decode(n.value), tags: n.tags, createdAt: n.createdAt, settledAt: n.settledAt, timeoutAt: n.timeoutAt, taskId: n.taskId };
      }),
      tasks: view.tasks,
      waits: view.nodes.filter(n => n.state === 'pending' && n.tags?.['cloud:wait'] === 'approval').map(n => ({ id: n.id, type: 'approval' })) };
  }
  async function proxy(req, res, path, actor) {
    const controller = new AbortController();
    metrics.streams++;
    if (!streams.has(actor.id)) streams.set(actor.id, new Set());
    streams.get(actor.id).add(res);
    let checking = false;
    const interval = setInterval(async () => {
      if (checking) return; checking = true;
      try { if (!await store.keyActive(actor.id)) res.destroy(); }
      catch { res.destroy(); }
      finally { checking = false; }
    }, streamAuthIntervalMs);
    interval.unref();
    res.once('close', () => {
      clearInterval(interval); metrics.streams--; streams.get(actor.id)?.delete(res);
      if (!streams.get(actor.id)?.size) streams.delete(actor.id);
    });
    res.once('close', () => controller.abort());
    const response = await fetch(config.engineUrl + path, { headers: { Authorization: `Bearer ${internalToken(config)}` }, signal: controller.signal });
    const headers = { 'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (response.headers.get('location')) headers.Location = response.headers.get('location');
    res.writeHead(response.status, headers);
    res.flushHeaders();
    if (response.body) await pipeline(Readable.fromWeb(response.body), res);
    else res.end();
  }
  const server = http.createServer(async (req, res) => {
    const requestId = randomBytes(12).toString('hex');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    const url = new URL(req.url, config.publicUrl);
    const started = performance.now();
    res.once('finish', () => metrics.observe(['GET', 'POST', 'DELETE'].includes(req.method) ? req.method : 'OTHER', metricRoute(url.pathname), res.statusCode, (performance.now() - started) / 1000));
    try {
      if (url.pathname === '/health/live' && req.method === 'GET') return json(res, 200, { live: true });
      if (['/healthz', '/health/ready'].includes(url.pathname) && req.method === 'GET') {
        let timeout;
        try {
          const [engine, control] = await Promise.race([
            Promise.all([fetch(config.engineUrl + '/ready', { signal: AbortSignal.timeout(probeTimeoutMs) }), store.ready()]),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new ApiError(503, 'Readiness check timed out')), probeTimeoutMs); })
          ]);
          return json(res, engine.ok && control ? 200 : 503, { ready: engine.ok && control });
        } finally { clearTimeout(timeout); }
      }
      // The independent Console forwards the original browser origin.
      if (req.headers.origin) check([config.publicUrl, config.consoleUrl].filter(Boolean).some(value => req.headers.origin === new URL(value).origin), 'Cross-origin request refused', 403);
      const localTestLogin = testLoginEnabled(config) && isLoopback(req.socket.remoteAddress)
        && req.headers.host === new URL(config.publicUrl).host;
      if (url.pathname === '/session' && req.method === 'GET') return json(res, 200, { testLoginEnabled: localTestLogin });
      if (url.pathname === '/session' && req.method === 'POST') {
        const input = await body(req);
        if (input?.test === true) check(localTestLogin && req.headers['content-type']?.split(';')[0].trim() === 'application/json'
          && req.headers['sec-fetch-site'] !== 'cross-site', 'Test sign-in is unavailable', 403);
        const key = input?.test === true ? config.adminKey : input?.key;
        check(typeof key === 'string', 'Administrator credential is required');
        const actor = await store.authenticate(key);
        check(actor?.role === 'admin', 'Use the administrator credential to sign in', 401);
        const token = randomBytes(32).toString('hex');
        await store.createSession(digest(token), actor, Date.now() + 8 * 3600000);
        return json(res, 200, { signedIn: true }, { 'Set-Cookie': `rc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.publicUrl.startsWith('https:') ? '; Secure' : ''}` });
      }
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      const cookie = req.headers.cookie?.match(/(?:^|;\s*)rc_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      const actor = bearer ? await store.authenticate(bearer) : cookie ? await store.authenticateSession(digest(cookie)) : undefined;
      const role = actor?.role;
      check(role, 'A valid project credential is required', 401);
      check(role !== 'metrics' || ['/metrics', '/metrics/engine'].includes(url.pathname), 'Metrics credential cannot access the project API', 403);
      if (url.pathname === '/session' && req.method === 'DELETE') {
        if (cookie) await store.deleteSession(digest(cookie));
        return json(res, 200, {}, { 'Set-Cookie': 'rc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (url.pathname === '/v1/project' && req.method === 'GET') return json(res, 200, {
        id: config.project, name: config.projectName, role, endpoint: config.publicUrl, databaseExpiresAt: config.zero?.expiresAt ?? null, keyId: actor.id,
        consoleUrl: config.consoleUrl ? `${config.consoleUrl}/#executions` : '/#executions'
      });
      if (url.pathname === '/v1/credentials' && req.method === 'POST') {
        check(role === 'admin', 'Administrator access required', 403);
        throw new ApiError(410, 'Existing secret values cannot be recovered. Create a scoped API key.');
      }
      if (url.pathname === '/v1/api-keys') {
        check(role === 'admin', 'Administrator access required', 403);
        if (req.method === 'GET') return json(res, 200, { items: await store.listKeys(), currentKeyId: actor.id });
        if (req.method === 'POST') return json(res, 201, await store.createKey(await body(req), actor));
      }
      const apiKey = url.pathname.match(/^\/v1\/api-keys\/([a-f0-9-]+)$/);
      if (apiKey && req.method === 'DELETE') {
        check(role === 'admin', 'Administrator access required', 403);
        await store.revokeKey(apiKey[1], actor);
        for (const stream of streams.get(apiKey[1]) ?? []) stream.destroy();
        return json(res, 200, { revoked: true });
      }
      if (url.pathname === '/v1/audit' && req.method === 'GET') {
        check(role === 'admin', 'Administrator access required', 403);
        return json(res, 200, { items: await store.listAudit() });
      }
      if (url.pathname === '/v1/examples' && req.method === 'GET') {
        check(role !== 'worker', 'Client credential required', 403);
        return json(res, 200, { items: examples });
      }
      if (url.pathname === '/v1/functions' && req.method === 'GET') return json(res, 200, { items: await store.listFunctions(url.searchParams.get('versions') === 'all') });
      if (url.pathname === '/v1/functions' && req.method === 'POST') {
        check(role === 'worker' || role === 'admin', 'Worker credential required', 403);
        const f = validateFunction(await body(req)); validateSchema(f.inputSchema);
        return json(res, 200, await store.registerFunction(f, actor));
      }
      if (url.pathname === '/v1/workers' && req.method === 'GET') {
        check(role !== 'worker', 'Client credential required', 403);
        return json(res, 200, { items: await store.listWorkers() });
      }
      const worker = url.pathname.match(/^\/v1\/workers\/([\w.-]{1,128})\/(heartbeat|offline)$/);
      if (worker && req.method === 'POST') {
        check(role === 'worker' || role === 'admin', 'Worker credential required', 403);
        if (worker[2] === 'offline') { await store.offlineWorker(worker[1], actor); return json(res, 200, { offline: true }); }
        return json(res, 200, await store.heartbeat({ ...await body(req), id: worker[1] }, actor));
      }
      if (['/metrics', '/metrics/engine'].includes(url.pathname) && req.method === 'GET') {
        check(role === 'admin' || role === 'metrics', 'Metrics credential required', 403);
        if (url.pathname === '/metrics/engine') {
          check(config.engineMetricsUrl, 'Engine metrics are not configured', 503);
          const upstream = await fetch(config.engineMetricsUrl, { signal: AbortSignal.timeout(3000) });
          check(upstream.ok, 'Engine metrics unavailable', 503);
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' }); return res.end(await upstream.text());
        }
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
        return res.end(metrics.render((await store.listWorkers()).filter(worker => worker.online).length));
      }
      if (url.pathname === '/v1/executions' && req.method === 'POST') {
        check(role !== 'worker', 'Client credential required', 403);
        const input = await body(req);
        check(input && typeof input === 'object' && !Array.isArray(input), 'Execution request must be an object');
        const key = req.headers['idempotency-key'];
        check(typeof key === 'string' && key.length >= 1 && key.length <= 200, 'Idempotency-Key header is required (1–200 characters)');
        check(typeof input.function === 'string' && /^[\w.-]{1,128}$/.test(input.function), 'A valid function name is required');
        check(input.version === undefined || Number.isInteger(input.version) && input.version > 0, 'Invalid function version');
        const timeoutMs = input.timeoutMs ?? 3600000;
        check(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 7 * 86400000, 'timeoutMs must be between one second and seven days');
        const identity = digest(JSON.stringify(canonical({ function: input.function, version: input.version ?? null, input: input.input, timeoutMs })));
        const id = executionId(config.project, key);
        const accepted = promise => {
          const saved = decode(promise.param);
          const legacy = digest(JSON.stringify(canonical({ function: input.function, version: input.version ?? saved?.version, input: input.input, timeoutMs })));
          check(promise.tags?.['cloud:project'] === config.project && (promise.tags['cloud:requestIdentity'] ? promise.tags['cloud:requestIdentity'] === identity : promise.tags['cloud:requestHash'] === legacy), 'Idempotency key was already used for a different request', 409);
          return json(res, 202, { id, state: promise.state, version: saved?.version, statusUrl: `/v1/executions/${id}`, consoleUrl: `${config.consoleUrl ?? ''}/#executions/${id}` });
        };
        // Lookup precedes current schema/version resolution: deployments must
        // not change the identity or validation of an already accepted request.
        let existing;
        try { existing = await rpc('promise.get', { id }); }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
        if (existing) return accepted(existing.promise);
        const f = await store.getFunction(input.function, input.version); validateInput(input.input, f.inputSchema);
        const hash = digest(JSON.stringify(canonical({ function: f.name, version: f.version, input: input.input, timeoutMs })));
        await store.audit('execution.start_requested', id, actor);
        const result = await rpc('promise.create', { id, timeoutAt: Date.now() + timeoutMs,
          param: { headers: {}, data: encode({ func: f.name, args: [input.input], version: f.version }) },
          tags: { 'resonate:target': `poll://any@${f.group}`, 'cloud:requestIdentity': identity, 'cloud:requestHash': hash, 'cloud:project': config.project } });
        return accepted(result.promise);
      }
      if (url.pathname === '/v1/executions' && req.method === 'GET') {
        check(role !== 'worker', 'Client credential required', 403);
        const query = { limit: Number(url.searchParams.get('limit') ?? 25), sort: 'createdAt:desc', countTotal: true };
        check(Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100, 'limit must be between 1 and 100');
        if (url.searchParams.has('cursor')) query.cursor = url.searchParams.get('cursor');
        if (url.searchParams.has('state')) {
          const state = url.searchParams.get('state');
          check(['pending', 'resolved', 'rejected', 'rejected_canceled', 'rejected_timedout'].includes(state), 'Invalid execution state');
          query.state = [state];
        }
        for (const field of ['func', 'idPrefix']) if (url.searchParams.has(field)) {
          const value = url.searchParams.get(field);
          check(value.length <= 128 && /^[\w.-]*$/.test(value), `Invalid ${field}`);
          if (value) query[field] = value;
        }
        for (const field of ['createdFrom', 'createdTo']) if (url.searchParams.has(field)) {
          const value = Number(url.searchParams.get(field));
          check(Number.isSafeInteger(value) && value >= 0, `Invalid ${field}`);
          query[field] = value;
        }
        return json(res, 200, await rpc('ui.executions.search', query, true));
      }
      const execution = url.pathname.match(/^\/v1\/executions\/([^/]+)(?:\/(cancel|waits))?$/);
      if (execution) {
        check(role !== 'worker', 'Client credential required', 403);
        const id = decodeURIComponent(execution[1]);
        const view = await detail(id);
        if (req.method === 'GET' && !execution[2]) return json(res, 200, view);
        if (req.method === 'POST' && execution[2] === 'cancel') {
          await store.audit('execution.cancel_requested', id, actor);
          await rpc('promise.settle', { id, state: 'rejected_canceled' });
          return json(res, 200, await detail(id));
        }
        if (req.method === 'POST' && execution[2] === 'waits') {
          const input = await body(req);
          check(input && typeof input === 'object', 'Approval request must be an object');
          const wait = view.steps.find(n => n.id === input.waitId && n.tags?.['cloud:wait'] === 'approval');
          check(wait && view.state === 'pending', 'No active approval with this ID belongs to this execution', 404);
          check(input.value && typeof input.value.approved === 'boolean', 'value.approved must be boolean');
          await store.audit(input.value.approved ? 'approval.approve_requested' : 'approval.decline_requested', wait.id, actor);
          await rpc('promise.settle', { id: wait.id, state: 'resolved', value: { headers: {}, data: encode(input.value) } });
          return json(res, 200, { id, waitId: wait.id, accepted: true });
        }
      }
      if (req.method === 'POST' && url.pathname === '/') {
        check(role !== 'client', 'Credential cannot access this endpoint', 403);
        const request = await body(req);
        check(request && typeof request === 'object', 'Protocol request must be an object');
        check(protocolKinds.has(request.kind), 'Operation is not exposed by this service', 403);
        // Supply the backend credential ourselves. Never trust head.auth or
        // debug fields submitted by a worker/browser.
        const forwarded = { kind: request.kind, data: request.data,
          head: { corrId: request.head?.corrId ?? randomBytes(12).toString('hex'), version: '2026-04-01', auth: internalToken(config) } };
        const response = await fetch(config.engineUrl + '/', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(forwarded), signal: AbortSignal.timeout(20000)
        });
        res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(await response.text());
      }
      if (req.method === 'GET' && url.pathname.startsWith('/poll/')) {
        check(role === 'worker' || role === 'admin', 'Worker credential required', 403);
        check(/^\/poll\/[\w.%~-]+\/[\w.%~-]+$/.test(url.pathname), 'Invalid worker subscription');
        return await proxy(req, res, url.pathname, actor);
      }
      if (req.method === 'GET' && (url.pathname === '/console' || /^\/console\/(executions(?:\/[^/]+)?|settings)\/?$/.test(url.pathname))) {
        check(role !== 'worker', 'Console credential required', 403);
        // Preserve old bookmarks while keeping the product on its native UI.
        const id = url.pathname.match(/^\/console\/executions\/([^/]+)\/?$/)?.[1];
        const target = id ? `/#executions/${encodeURIComponent(decodeURIComponent(id))}` : url.pathname.endsWith('/settings') ? '/#access' : '/#executions';
        res.writeHead(302, { Location: `${config.consoleUrl ?? ''}${target}`, 'Cache-Control': 'no-store' }); return res.end();
      }
      throw new ApiError(404, 'Endpoint not found');
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      const status = error instanceof ApiError ? error.status : 503;
      // Log only an error code and request ID: raw messages, SQL, headers,
      // tokens, and connection details can contain credentials.
      if (!(error instanceof ApiError)) logError(JSON.stringify({ event: 'request_failed', requestId, method: req.method,
        route: url.pathname.startsWith('/v1/') ? url.pathname.split('/').slice(0, 3).join('/') : 'upstream',
        code: typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'UPSTREAM_ERROR' }));
      json(res, status >= 400 && status <= 599 ? status : 500, { error: error instanceof ApiError ? error.message : 'Service temporarily unavailable', requestId });
    }
  });
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = await loadConfig();
  const db = mysql.createPool(databaseOptions(config));
  const store = new ControlStore(db, config);
  if (!await store.ready()) throw new Error('Control database is not initialized. Run setup before serve.');
  const server = createApp(config, db, { store });
  const maintenance = setInterval(() => store.cleanup().catch(() => console.error('{"event":"session_cleanup_failed"}')), 3600000);
  maintenance.unref();
  server.listen(config.port, config.bind, () => console.log(`Single-project service ready: ${config.publicUrl}`));
  const stop = () => {
    clearInterval(maintenance);
    server.close(() => db.end().then(() => process.exit()));
    setTimeout(() => { server.closeAllConnections(); process.exit(); }, 5000).unref();
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
