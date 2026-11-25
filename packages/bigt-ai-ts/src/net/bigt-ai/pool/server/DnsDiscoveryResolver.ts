import * as dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { PeerInfo } from './NodeRecord';

interface RootRecord {
  entryHash: string;
  seq: number;
  signature: Uint8Array;
}

export class DnsDiscoveryResolver {

  static async resolve(url: string): Promise<PeerInfo[]> {
    if (!url) return [];

    if (url.startsWith('enrtree://')) {
      return this.resolveEnrTree(url);
    }

    const parts = url.split(':');
    if (parts.length === 2) {
      const port = parseInt(parts[1], 10);
      if (!isNaN(port)) {
        return this.resolveSeedDomain(parts[0], port);
      }
    }

    return [];
  }

  static async resolveEnrTree(enrTreeUrl: string): Promise<PeerInfo[]> {
    if (!enrTreeUrl.startsWith('enrtree://'))
      throw new Error('Invalid enrtree URL: ' + enrTreeUrl);

    const rest = enrTreeUrl.slice('enrtree://'.length);
    const atIndex = rest.indexOf('@');
    if (atIndex < 0)
      throw new Error('Missing @ in enrtree URL: ' + enrTreeUrl);

    const pubkeyHex = rest.slice(0, atIndex);
    const domain = rest.slice(atIndex + 1);
    const expectedPubKey = hexToBytes(pubkeyHex);

    const rootTxts = await this.queryTxt(domain);
    if (rootTxts.length === 0) return [];

    const root = this.parseRootRecord(rootTxts[0]);
    if (!root) return [];

    const rootData = serializeRootForSigning(root);
    if (!verifyEd25519(expectedPubKey, rootData, root.signature)) {
      return [];
    }

    const result: PeerInfo[] = [];
    const visited = new Set<string>();
    await this.resolveEnrTreeRecursive(domain, root.entryHash, result, visited);
    return result;
  }

  static async resolveSeedDomain(domain: string, defaultPort: number): Promise<PeerInfo[]> {
    try {
      const addresses = await dns.resolve4(domain);
      return addresses.map(addr => ({
        nodeId: '',
        host: addr,
        tcpPort: defaultPort,
        udpPort: defaultPort,
        seq: 0,
      }));
    } catch {
      return [];
    }
  }

  private static async resolveEnrTreeRecursive(
    domain: string,
    hash: string,
    result: PeerInfo[],
    visited: Set<string>,
  ): Promise<void> {
    if (!hash || visited.has(hash)) return;
    visited.add(hash);

    const subdomain = `${hash}.${domain}`;
    const txts = await this.queryTxt(subdomain);
    if (txts.length === 0) return;

    const record = txts[0];

    if (record.startsWith('enrtree-branch:')) {
      const childHashes = this.parseBranchRecord(record);
      for (const childHash of childHashes) {
        await this.resolveEnrTreeRecursive(domain, childHash, result, visited);
      }
    } else if (record.startsWith('enr:')) {
      const peerInfo = parseLeafRecord(record);
      if (peerInfo) {
        result.push(peerInfo);
      }
    }
  }

  static async queryTxt(domain: string): Promise<string[]> {
    try {
      const records = await dns.resolveTxt(domain);
      return records.map(r => r.join(''));
    } catch {
      return [];
    }
  }

  static parseRootRecord(txt: string): RootRecord | null {
    if (!txt || !txt.startsWith('enrtree-root:v1')) return null;

    let eHash: string | null = null;
    let seq = 0;
    let sig: Uint8Array | null = null;

    const parts = txt.split(' ');
    for (const part of parts) {
      if (part.startsWith('e=')) {
        eHash = part.slice(2);
      } else if (part.startsWith('seq=')) {
        seq = parseInt(part.slice(4), 10);
      } else if (part.startsWith('sig=')) {
        sig = hexToBytes(part.slice(4));
      }
    }

    if (!eHash || !sig) return null;

    return { entryHash: eHash, seq, signature: sig };
  }

  static parseBranchRecord(txt: string): string[] {
    if (!txt || !txt.startsWith('enrtree-branch:')) return [];
    const rest = txt.slice('enrtree-branch:'.length).trim();
    return rest.split(' ').filter(s => s.length > 0);
  }
}

function parseLeafRecord(txt: string): PeerInfo | null {
  if (!txt || !txt.startsWith('enr:')) return null;
  const enrHex = txt.slice('enr:'.length).trim();
  return parseEnrHex(enrHex);
}

function parseEnrHex(hex: string): PeerInfo | null {
  try {
    const bytes = hexToBytes(hex);

    let offset = 0;
    const publicKey = bytes.slice(offset, offset + 32);
    offset += 32;
    const udpPort = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    const tcpPort = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    const seq = Number(
      (BigInt(bytes[offset]) << 56n) |
      (BigInt(bytes[offset + 1]) << 48n) |
      (BigInt(bytes[offset + 2]) << 40n) |
      (BigInt(bytes[offset + 3]) << 32n) |
      (BigInt(bytes[offset + 4]) << 24n) |
      (BigInt(bytes[offset + 5]) << 16n) |
      (BigInt(bytes[offset + 6]) << 8n) |
      BigInt(bytes[offset + 7]),
    );
    offset += 8;
    const hostLen = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 4;
    const host = new TextDecoder().decode(bytes.slice(offset, offset + hostLen));

    const idBytes = sha256(publicKey);
    const nodeId = Array.from(idBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    return { nodeId, host, tcpPort, udpPort, seq };
  } catch {
    return null;
  }
}

function serializeRootForSigning(root: RootRecord): Uint8Array {
  const content = `enrtree-root:v1 e=${root.entryHash} seq=${root.seq}`;
  return new TextEncoder().encode(content);
}

function verifyEd25519(pubKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    const spkiHeader = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
    const derKey = new Uint8Array(spkiHeader.length + pubKey.length);
    derKey.set(spkiHeader);
    derKey.set(pubKey, spkiHeader.length);
    const key = crypto.createPublicKey({ key: Buffer.from(derKey), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(signature));
  } catch (e) {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}
