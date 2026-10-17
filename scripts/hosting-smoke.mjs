import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// All errors are summarized without headers, credentials or response payloads.
async function main() {
  const runtime = JSON.parse(process.env.TISONA_RUNTIME);
  const base = process.env.TISONA_API_ORIGIN;
  const consoleOrigin = process.env.TISONA_CONSOLE_ORIGIN;
  const release = process.env.TISONA_RELEASE;
  const wait = ms => new Promise(done => setTimeout(done, ms));
  let ready = false;
  for (let i = 0; i < 36; i++) {
    try {
      const response = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (response.ok && data.ready && data.release === release) { ready = true; break; }
    } catch { /* Cold start, image activation or readiness is pending. */ }
    await wait(5000);
  }
  assert(ready, 'New backend release did not become ready');
  if (process.argv.includes('--console')) {
    const login = await fetch(consoleOrigin + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: consoleOrigin },
      body: JSON.stringify({ key: runtime.adminKey }), signal: AbortSignal.timeout(20000) });
    assert.equal(login.status, 200, 'Console session proxy failed');
    const cookie = login.headers.get('set-cookie');
    assert(cookie?.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Strict'), 'Session cookie security attributes are missing');
    const project = await fetch(consoleOrigin + '/v1/project', { headers: { Cookie: cookie.split(';')[0] }, signal: AbortSignal.timeout(20000) });
    assert.equal(project.status, 200, 'Console cookie session failed');
    assert.equal((await project.json()).endpoint, base, 'Console points to a different backend');
    console.log('Netlify session proxy, secure cookie and authenticated project verified.'); return;
  }
  const headers = { Authorization: `Bearer ${runtime.clientKey}`, 'Content-Type': 'application/json' };
  let functions;
  for (let i = 0; i < 20; i++) {
    const response = await fetch(base + '/v1/functions', { headers, signal: AbortSignal.timeout(10000) });
    if (response.ok) { functions = (await response.json()).items; if (functions.some(f => f.name === 'tool_retry')) break; }
    await wait(1000);
  }
  assert(functions?.some(f => f.name === 'tool_retry'), 'Bundled example worker did not register');
  const rejected = await fetch(base + '/v1/project', { headers: { ...headers, Origin: 'https://untrusted.example' } });
  assert.equal(rejected.status, 403, 'Untrusted browser origin was accepted');
  const request = { method: 'POST', headers: { ...headers, 'Idempotency-Key': `deploy-${release}-${randomUUID()}` },
    body: JSON.stringify({ function: 'tool_retry', version: 1, input: { task: 'Deployment recovery check', failTimes: 1, maxAttempts: 2, backoffSeconds: 1 } }) };
  const response = await fetch(base + '/v1/executions', request);
  assert(response.ok, 'Cannot create a deployment smoke execution');
  const run = await response.json();
  const repeated = await fetch(base + '/v1/executions', request);
  assert(repeated.ok && (await repeated.json()).id === run.id, 'Execution start is not idempotent');
  for (let i = 0; i < 60; i++) {
    const current = await fetch(base + '/v1/executions/' + encodeURIComponent(run.id), { headers });
    assert(current.ok, 'Cannot inspect smoke execution');
    const view = await current.json();
    if (view.state === 'resolved') {
      assert.equal(view.result?.outcome, 'recovered', 'Retry example did not recover');
      console.log(`Backend release ${release} verified: registered worker, execution ${run.id}, idempotent start and durable retry recovery.`); return;
    }
    assert(view.state === 'pending', 'Smoke execution failed');
    await wait(1000);
  }
  throw new Error('Smoke execution did not finish');
}
main().catch(error => { console.error(error instanceof assert.AssertionError ? error.message : 'Hosted smoke check failed; inspect readiness and deployment status.'); process.exitCode = 1; });
