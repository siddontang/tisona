// Reusable control-plane companion to the unmodified Resonate SDK. Heartbeats
// report process presence, not the health of a particular task or SSE stream.
export async function registerWorker({ url, token, id, group, functions, intervalMs = 20000, onAuthError, log = console.error }) {
  let stopped = false, inflight = false;
  const controller = new AbortController();
  async function request(path, body) {
    const response = await fetch(url + path, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
    if (!response.ok) {
      const error = new Error(`Worker registration request failed (${response.status})`); error.status = response.status; throw error;
    }
    return response.json();
  }
  for (const descriptor of functions) await request('/v1/functions', descriptor);
  const path = `/v1/workers/${encodeURIComponent(id)}`;
  const heartbeat = () => request(path + '/heartbeat', { group, functions: functions.map(({ name, version }) => ({ name, version })) });
  await heartbeat();
  const interval = setInterval(async () => {
    if (inflight || stopped) return; inflight = true;
    try { await heartbeat(); }
    catch (error) {
      if (stopped) return;
      log(JSON.stringify({ event: 'worker_heartbeat_failed', status: error.status ?? 'NETWORK_ERROR' }));
      if ([401, 403].includes(error.status)) { stopped = true; clearInterval(interval); await onAuthError?.(); }
    } finally { inflight = false; }
  }, intervalMs);
  interval.unref();
  return {
    async stop() {
      if (stopped) return; stopped = true; clearInterval(interval); controller.abort();
      try { await fetch(url + path + '/offline', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }); } catch { /* TTL handles an abrupt exit */ }
    }
  };
}
