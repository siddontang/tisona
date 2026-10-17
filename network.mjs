import { lookup } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { connect, isIP } from 'node:net';

export async function lookupPublicDatabase(hostname, families, { fetchImpl = fetch } = {}) {
  // Never send private/custom hostnames to a public resolver. This last
  // resort is restricted to the public TiDB Cloud domain, after local DNS
  // has already failed, and sends no database credentials.
  if (!/^[a-z0-9.-]+\.tidbcloud\.com\.?$/i.test(hostname)) return [];
  const results = await Promise.allSettled(families.map(async family => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', hostname); url.searchParams.set('type', family === 4 ? 'A' : 'AAAA');
    const response = await fetchImpl(url, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(3000) });
    if (!response.ok) return [];
    const data = await response.json();
    if (data.Status !== 0) return [];
    return (data.Answer ?? []).filter(record => record.type === (family === 4 ? 1 : 28) && isIP(record.data) === family)
      .map(record => ({ address: record.data, family }));
  }));
  return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
}

// System getaddrinfo can temporarily fail even while the configured DNS
// servers still answer for Cloud Zero. Only use direct DNS after a lookup
// failure; keep the original hostname for MySQL's TLS identity verification.
export function createDatabaseLookup({ systemLookup = lookup, resolver = new Resolver({ timeout: 1500, tries: 2 }), publicLookup = lookupPublicDatabase } = {}) {
  return (hostname, options, callback) => {
    systemLookup(hostname, options, (error, address, family) => {
      if (!error || !['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return callback(error, address, family);
      const opts = typeof options === 'number' ? { family: options } : options ?? {};
      const families = opts.family === 4 || opts.family === 6 ? [opts.family] : [4, 6];
      Promise.allSettled(families.map(async family => {
        const addresses = await (family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname));
        return addresses.map(address => ({ address, family }));
      })).then(async results => {
        let addresses = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        if (!addresses.length) addresses = await publicLookup(hostname, families);
        if (!addresses.length) return callback(error);
        if (opts.order === 'ipv6first') addresses.sort((a, b) => b.family - a.family);
        if (opts.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }).catch(() => callback(error));
    });
  };
}

const databaseLookup = createDatabaseLookup();
export function databaseStream({ config }) {
  const socket = connect({ host: config.host, port: config.port, lookup: databaseLookup });
  socket.setNoDelay(true);
  socket.on('connect', () => socket.setKeepAlive(true, 10000));
  return socket;
}
