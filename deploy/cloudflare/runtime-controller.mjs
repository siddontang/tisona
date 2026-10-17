export class RuntimeController {
  constructor(ctx, env, { pause = ms => new Promise(done => setTimeout(done, ms)) } = {}) {
    this.ctx = ctx; this.env = env; this.pause = pause; this.starting = null; this.healthyUntil = 0;
  }
  async ready() {
    if (this.starting) return this.starting;
    this.starting = this.ensureReady();
    try { await this.starting; } finally { this.starting = null; }
  }
  async ensureReady() {
    const c = this.ctx.container;
    if (!c || !this.env.TISONA_RUNTIME || !this.env.RELEASE) throw new Error('Missing runtime configuration');
    // Alarms keep the timer engine active without any browser/worker traffic.
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    if (c.running) {
      const current = await c.inspect();
      if (current?.labels?.release !== this.env.RELEASE) {
        // Stop the previous engine before starting its replacement on this DB.
        await c.destroy('Application release changed'); this.healthyUntil = 0;
      }
    }
    if (!c.running) {
      c.start({ image: c.images.app, instance: 'basic', enableInternet: true,
        env: { TISONA_RUNTIME: this.env.TISONA_RUNTIME, TISONA_RELEASE: this.env.RELEASE },
        labels: { release: this.env.RELEASE } });
      this.healthyUntil = 0;
    }
    // Reapply after DO eviction/deploy as this timeout belongs to the DO instance.
    await c.setInactivityTimeout(10 * 60000);
    if (Date.now() < this.healthyUntil) return;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await c.getTcpPort(8787).fetch('http://container/health/ready');
        if (response.ok && (await response.json()).ready) { this.healthyUntil = Date.now() + 5000; return; }
        await response.body?.cancel();
      } catch { /* Port is not ready until setup, gateway and engine start. */ }
      await this.pause(500);
    }
    throw new Error('Runtime readiness timed out');
  }
}
