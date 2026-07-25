export interface PeerInfo {
  nodeId: string;
  host: string;
  tcpPort: number;
  udpPort: number;
  seq: number;
  score?: string;
  chainLength?: number;
  responseTime?: number;
}

export interface GetPeersResponse {
  self: string;
  count: number;
  peers: PeerInfo[];
}
