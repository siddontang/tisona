// Bounded labels: execution IDs, credentials, and arbitrary paths never become
// metric labels. This endpoint is authenticated separately from public probes.
export class Metrics {
  requests = new Map(); latencies = new Map(); streams = 0;
  observe(method, route, status, elapsed) {
    const key = `${method}|${route}|${status}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    if (route.startsWith('/poll/')) return; // Stream lifetime is not API latency.
    const series = `${method}|${route}`;
    const histogram = this.latencies.get(series) ?? { sum: 0, count: 0, buckets: [0, 0, 0, 0, 0, 0] };
    histogram.sum += elapsed; histogram.count++;
    [0.1, 0.5, 1, 2, 5, 10].forEach((limit, i) => { if (elapsed <= limit) histogram.buckets[i]++; });
    this.latencies.set(series, histogram);
  }
  render(online) {
    const lines = ['# TYPE cloud_http_requests_total counter'];
    for (const [key, value] of this.requests) {
      const [method, route, status] = key.split('|');
      lines.push(`cloud_http_requests_total{method="${method}",route="${route}",status="${status}"} ${value}`);
    }
    lines.push('# TYPE cloud_http_duration_seconds histogram');
    for (const [key, value] of this.latencies) {
      const [method, route] = key.split('|'), labels = `method="${method}",route="${route}"`;
      [0.1, 0.5, 1, 2, 5, 10].forEach((limit, i) => lines.push(`cloud_http_duration_seconds_bucket{${labels},le="${limit}"} ${value.buckets[i]}`));
      lines.push(`cloud_http_duration_seconds_bucket{${labels},le="+Inf"} ${value.count}`,
        `cloud_http_duration_seconds_count{${labels}} ${value.count}`, `cloud_http_duration_seconds_sum{${labels}} ${value.sum}`);
    }
    lines.push('# TYPE cloud_worker_streams gauge', `cloud_worker_streams ${this.streams}`,
      '# TYPE cloud_workers_online gauge', `cloud_workers_online ${online}`);
    return lines.join('\n') + '\n';
  }
}
export function metricRoute(path) {
  if (path.startsWith('/poll/')) return '/poll/:group/:worker';
  if (path.startsWith('/v1/executions/')) return '/v1/executions/:id' + (path.endsWith('/waits') ? '/waits' : path.endsWith('/cancel') ? '/cancel' : '');
  if (path.startsWith('/v1/workers/')) return '/v1/workers/:id';
  if (path.startsWith('/v1/api-keys/')) return '/v1/api-keys/:id';
  return ['/', '/session', '/healthz', '/health/live', '/health/ready', '/metrics', '/metrics/engine', '/v1/project', '/v1/functions', '/v1/executions', '/v1/api-keys', '/v1/workers', '/v1/audit', '/v1/examples'].includes(path) ? path : 'other';
}
