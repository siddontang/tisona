import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDatabaseRelay } from '../database-relay.mjs';

test('database relay forwards bytes unchanged, restricts socket access, and preserves an active relay', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rc-relay-'));
  const path = join(directory, 'db.sock');
  const peers = new Set();
  const remote = createServer(socket => { peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.pipe(socket); });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  const config = { zero: { connection: { host: '127.0.0.1', port: remote.address().port } } };
  const relay = await startDatabaseRelay(config, { path });
  t.after(async () => { await relay.close(); for (const peer of peers) peer.destroy(); await new Promise(r => remote.close(r)); await rm(directory, { recursive: true }); });
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  await assert.rejects(startDatabaseRelay(config, { path }), /already running/);
  const client = connect(path); await once(client, 'connect');
  const payload = Buffer.from([0, 255, 7, 13, 10, 84, 76, 83]);
  const response = once(client, 'data'); client.write(payload);
  assert.deepEqual((await response)[0], payload);
  client.destroy();
});
