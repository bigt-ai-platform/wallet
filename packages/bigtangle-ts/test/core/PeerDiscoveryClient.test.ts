import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PeerDiscoveryClient } from '../../src/net/bigtangle/pool/server/PeerDiscoveryClient';
import { OkHttp3Util } from '../../src/net/bigtangle/utils/OkHttp3Util';
import type { PeerInfo } from '../../src/net/bigtangle/pool/server/NodeRecord';

describe('PeerDiscoveryClient', () => {
  it('returns empty array when no bootnodes', async () => {
    const client = new PeerDiscoveryClient([]);
    const peers = await client.discover(10);
    expect(peers).toEqual([]);
  });

  it('parses getPeers response correctly', () => {
    const json = JSON.stringify({
      self: 'abc123',
      count: 2,
      peers: [
        { nodeId: 'node1', host: '10.0.0.1', tcpPort: 8081, udpPort: 30303, seq: 1, score: '0.95', chainLength: 1000 },
        { nodeId: 'node2', host: '10.0.0.2', tcpPort: 8082, udpPort: 30303, seq: 2 },
      ],
    });

    const parsed = JSON.parse(json);
    expect(parsed.self).toBe('abc123');
    expect(parsed.count).toBe(2);
    expect(parsed.peers.length).toBe(2);
    expect(parsed.peers[0].host).toBe('10.0.0.1');
    expect(parsed.peers[0].tcpPort).toBe(8081);
    expect(parsed.peers[0].chainLength).toBe(1000);
    expect(parsed.peers[1].nodeId).toBe('node2');
  });
});
