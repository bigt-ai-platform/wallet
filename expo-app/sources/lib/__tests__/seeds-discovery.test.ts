import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { orderEndpoints, parseChainProbe, rankProbes, type ProbeResult } from '../endpoints';
import { fetchRegistryNodes } from '../registry';

/**
 * End-to-end verification that a *newly published* seed is usable by the
 * client without a rebuild: the client queries the registry, filters to its
 * chain, verifies each node with getChainNumber, ranks, and selects one.
 */
function start(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/** Probe a chain node the way services/discovery.ts does. */
async function probe(url: string): Promise<ProbeResult | null> {
  try {
    const res = await fetch(`${url}/getChainNumber`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return null;
    const parsed = parseChainProbe(await res.json());
    return parsed ? { url, chainLength: parsed.chainLength, latencyMs: 1 } : null;
  } catch {
    return null;
  }
}

describe('new seeds are usable without a client update', () => {
  let nodeA: http.Server;
  let deadNode: http.Server;
  let registry: http.Server;
  let nodeAUrl: string;
  let deadUrl: string;
  let registryUrl: string;
  const OTHER_CHAIN = 'https://ordereu9.example';

  beforeAll(async () => {
    nodeA = (
      await start((req, res) => {
        if (req.url === '/getChainNumber') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ txReward: { chainLength: 424242 } }));
          return;
        }
        res.writeHead(404).end();
      })
    ).server;
    nodeAUrl = `http://127.0.0.1:${(nodeA.address() as AddressInfo).port}`;

    // A node that advertises in the registry but never answers (retired/dead).
    deadNode = (await start((_req, res) => res.writeHead(503).end())).server;
    deadUrl = `http://127.0.0.1:${(deadNode.address() as AddressInfo).port}`;

    registry = (
      await start((req, res) => {
        if (req.url === '/serverinfolist') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              serverInfoList: [
                { url: nodeAUrl, servertype: 'bigtangle', chain: 'L0', status: 'active' },
                { url: OTHER_CHAIN, chain: 'ordermatch', status: 'active' },
                { url: deadUrl, chain: 'L0', status: 'active' },
              ],
              duration: 1,
            }),
          );
          return;
        }
        res.writeHead(404).end();
      })
    ).server;
    registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    nodeA?.close();
    deadNode?.close();
    registry?.close();
  });

  it('discovers, verifies and selects a newly published node', async () => {
    // 1. query the (configurable) registry — no rebuild needed for a new seed
    const urls = await fetchRegistryNodes([registryUrl], 'L0');
    // only our chain, other-chains excluded; the new node is present
    expect(urls).toContain(nodeAUrl);
    expect(urls).not.toContain(OTHER_CHAIN);

    // 2. verify: health-check each candidate, drop the dead one
    const probed = (await Promise.all(urls.map(probe))).filter((r): r is ProbeResult => r !== null);
    expect(probed.map((r) => r.url)).toEqual([nodeAUrl]);

    // 3. rank + order: the request layer would use the live node
    const ranked = rankProbes(probed, { now: 1 });
    expect(ranked[0].url).toBe(nodeAUrl);
    expect(orderEndpoints(urls, ranked)[0]).toBe(nodeAUrl);
  });

  it('skips an unreachable registry and still uses a live one', async () => {
    const urls = await fetchRegistryNodes(['http://127.0.0.1:1', registryUrl], 'L0');
    expect(urls).toContain(nodeAUrl);
  });

  it('falls back to cached/static sources when every registry is down', async () => {
    // No reachable registry → the caller keeps its static/learned candidates.
    const urls = await fetchRegistryNodes(['http://127.0.0.1:1'], 'L0');
    expect(urls).toEqual([]);
  });
});
