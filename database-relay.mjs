import { createServer, connect } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { databaseSocket } from './config.mjs';
import { createDatabaseLookup } from './network.mjs';

// SQLx does not expose a custom hostname resolver. Its existing Unix-socket
// option lets this small local byte relay supply the same resilient DNS as
// the gateway. MySQL negotiates TLS end to end through it: the relay neither
// terminates TLS nor sees credentials, and SQLx verifies the original host.
export async function startDatabaseRelay(config, { path = databaseSocket } = {}) {
  try {
    const old = await lstat(path);
    if (!old.isSocket()) throw new Error('Database relay path is not a socket');
    const alive = await new Promise((resolve, reject) => {
      const probe = connect(path);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', error => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error));
    });
    if (alive) throw new Error('A database relay is already running');
    if ((await lstat(path)).ino !== old.ino) throw new Error('Database relay path changed during startup');
    await unlink(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }

  const sockets = new Set();
  const lookup = createDatabaseLookup();
  const connection = config.connection ?? config.zero.connection;
  const server = createServer(client => {
    const remote = connect({ host: connection.host, port: connection.port ?? 4000, lookup });
    sockets.add(client); sockets.add(remote);
    const timer = setTimeout(() => { client.destroy(); remote.destroy(); }, 20000);
    timer.unref();
    const close = () => {
      clearTimeout(timer); client.destroy(); remote.destroy(); sockets.delete(client); sockets.delete(remote);
    };
    client.on('error', close); remote.on('error', close);
    client.on('close', close); remote.on('close', close);
    remote.on('connect', () => { clearTimeout(timer); remote.setKeepAlive(true, 10000); });
    client.setNoDelay(true); remote.setNoDelay(true);
    client.pipe(remote); remote.pipe(client);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
