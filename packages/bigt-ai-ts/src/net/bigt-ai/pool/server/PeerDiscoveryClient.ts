import { OkHttp3Util } from '../../utils/OkHttp3Util';
import { Json } from '../../utils/Json';
import { PeerInfo, GetPeersResponse } from './NodeRecord';
import { DnsDiscoveryResolver } from './DnsDiscoveryResolver';

export class PeerDiscoveryClient {
  private readonly bootnodes: string[];

  public static async fromDnsSeeds(dnsSeeds: string[]): Promise<PeerDiscoveryClient> {
    const bootnodes: string[] = [];
    for (const seed of dnsSeeds) {
      const peers = await DnsDiscoveryResolver.resolve(seed);
      for (const p of peers) {
        const url = `http://${p.host}:${p.tcpPort}/getPeers`;
        if (!bootnodes.includes(url)) {
          bootnodes.push(url);
        }
      }
    }
    return new PeerDiscoveryClient(bootnodes);
  }

  constructor(bootnodes: string[]) {
    this.bootnodes = bootnodes;
  }

  public async discover(maxNodes: number = 100): Promise<PeerInfo[]> {
    if (this.bootnodes.length === 0) return [];

    const seen = new Set<string>();
    const peers: PeerInfo[] = [];

    for (const bootnode of this.bootnodes) {
      try {
        const list = await this.queryPeers(bootnode);
        for (const p of list) {
          if (!seen.has(p.nodeId)) {
            seen.add(p.nodeId);
            peers.push(p);
          }
        }
      } catch {
        // skip unreachable bootnode
      }
      if (peers.length >= maxNodes) break;
    }

    return peers.slice(0, maxNodes);
  }

  private async queryPeers(node: string): Promise<PeerInfo[]> {
    const url = node.endsWith('/getPeers')
      ? node
      : `${node.replace(/\/+$/, '')}/getPeers`;

    const response = await OkHttp3Util.post(url, new Uint8Array(0));
    const result: GetPeersResponse = Json.jsonmapper().parse(response);

    if (!result || !result.peers) return [];
    return result.peers;
  }
}
