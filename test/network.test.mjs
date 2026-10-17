import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseLookup, lookupPublicDatabase } from '../network.mjs';
import { databaseOptions } from '../config.mjs';

function lookup(lookupFn, options = {}) {
  return new Promise((resolve, reject) => lookupFn('database.example', options, (error, address, family) => error ? reject(error) : resolve({ address, family })));
}
test('database connections preserve system resolution when it succeeds', async () => {
  const fn = createDatabaseLookup({ systemLookup: (_host, _options, cb) => cb(null, '127.0.0.1', 4), resolver: {} });
  assert.deepEqual(await lookup(fn), { address: '127.0.0.1', family: 4 });
});
test('system ENOTFOUND falls back to configured DNS and supports Node dual-stack lookup', async () => {
  const calls = [];
  const fn = createDatabaseLookup({ systemLookup: (_host, _options, cb) => cb(Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' })),
    resolver: { resolve4: async host => { calls.push(host); return ['192.0.2.1', '192.0.2.2']; }, resolve6: async () => { throw Object.assign(new Error('No IPv6'), { code: 'ENODATA' }); } } });
  assert.deepEqual(await lookup(fn, { all: true }), { address: [{ address: '192.0.2.1', family: 4 }, { address: '192.0.2.2', family: 4 }], family: undefined });
  assert.deepEqual(calls, ['database.example']);
});
test('DNS fallback respects requested family and preserves real resolution failures', async () => {
  const original = Object.assign(new Error('lookup failed'), { code: 'EAI_AGAIN' });
  const fn = createDatabaseLookup({ systemLookup: (_host, _options, cb) => cb(original),
    resolver: { resolve6: async () => ['2001:db8::1'] } });
  assert.deepEqual(await lookup(fn, { family: 6 }), { address: '2001:db8::1', family: 6 });
  const unavailable = createDatabaseLookup({ systemLookup: (_host, _options, cb) => cb(original),
    resolver: { resolve4: async () => { throw new Error('unavailable'); }, resolve6: async () => { throw new Error('unavailable'); } } });
  await assert.rejects(lookup(unavailable), error => error === original);
});
test('DNS fallback does not weaken TLS identity verification or replace the configured hostname', () => {
  const opts = databaseOptions({ database: 'test', zero: { connection: { host: 'database.example', port: 4000, username: 'user', password: 'test-only' } } });
  assert.equal(opts.host, 'database.example'); assert.equal(opts.ssl.rejectUnauthorized, true); assert.equal(opts.ssl.verifyIdentity, true);
  assert.equal(typeof opts.stream, 'function');
});
test('configured DNS SERVFAIL has a bounded public-domain fallback', async () => {
  const error = Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
  const fn = createDatabaseLookup({ systemLookup: (_host, _options, cb) => cb(error),
    resolver: { resolve4: async () => { throw Object.assign(new Error('failed'), { code: 'ESERVFAIL' }); } },
    publicLookup: async (host, families) => { assert.equal(host, 'database.example'); assert.deepEqual(families, [4]); return [{ address: '192.0.2.5', family: 4 }]; } });
  assert.deepEqual(await lookup(fn, { family: 4 }), { address: '192.0.2.5', family: 4 });
});
test('HTTPS DNS fallback never queries private hostnames and validates returned IP records', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url); assert.ok(options.signal); assert.equal(options.headers.Accept, 'application/dns-json');
    return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 5, data: 'alias.example' }, { type: 1, data: '192.0.2.10' }, { type: 1, data: 'invalid' }] }) };
  };
  assert.deepEqual(await lookupPublicDatabase('private.internal', [4], { fetchImpl }), []);
  assert.equal(requests.length, 0);
  assert.deepEqual(await lookupPublicDatabase('gateway.example.tidbcloud.com', [4], { fetchImpl }), [{ address: '192.0.2.10', family: 4 }]);
  assert.equal(requests[0].hostname, 'cloudflare-dns.com');
});
