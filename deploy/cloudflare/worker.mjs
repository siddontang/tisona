import { DurableObject } from 'cloudflare:workers';
import { RuntimeController } from './runtime-controller.mjs';

export class TiSonaRuntime extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.controller = new RuntimeController(ctx, env);
  }
  async fetch(request) {
    try {
      await this.controller.ready();
      return await this.ctx.container.getTcpPort(8787).fetch(request);
    } catch {
      // Never log caught errors: platform/network errors may contain secret env.
      console.error(JSON.stringify({ event: 'runtime_unavailable' }));
      return Response.json({ error: 'Execution service is starting or recovering. Retry with the same idempotency key.' }, { status: 503, headers: { 'Retry-After': '5', 'Cache-Control': 'no-store' } });
    }
  }
  async alarm() {
    // Rearm first, so an unsuccessful restart is retried without browser traffic.
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    try { await this.controller.ready(); }
    catch { console.error(JSON.stringify({ event: 'runtime_recovery_pending' })); }
  }
}

export default {
  fetch(request, env) {
    // One stable project ID, independent of request paths, headers or clients.
    return env.RUNTIME.get(env.RUNTIME.idFromName('starter')).fetch(request);
  }
};
