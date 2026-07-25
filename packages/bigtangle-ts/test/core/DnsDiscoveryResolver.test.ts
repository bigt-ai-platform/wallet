import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnsDiscoveryResolver } from '../../src/net/bigtangle/pool/server/DnsDiscoveryResolver';
import type { PeerInfo } from '../../src/net/bigtangle/pool/server/NodeRecord';

vi.mock('node:dns/promises', () => ({
  resolveTxt: vi.fn(),
  resolve4: vi.fn(),
}));

import * as dns from 'node:dns/promises';

const mockResolveTxt = dns.resolveTxt as ReturnType<typeof vi.fn>;
const mockResolve4 = dns.resolve4 as ReturnType<typeof vi.fn>;

describe('DnsDiscoveryResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseRootRecord', () => {
    it('parses valid root record', () => {
      const txt = 'enrtree-root:v1 e=ABCDEF seq=1 sig=0102030405060708090a0b0c0d0e0f10';
      const root = DnsDiscoveryResolver.parseRootRecord(txt);
      expect(root).not.toBeNull();
      expect(root!.entryHash).toBe('ABCDEF');
      expect(root!.seq).toBe(1);
      expect(root!.signature).toBeDefined();
    });

    it('rejects invalid root record', () => {
      expect(DnsDiscoveryResolver.parseRootRecord('garbage')).toBeNull();
      expect(DnsDiscoveryResolver.parseRootRecord('')).toBeNull();
    });

    it('rejects root without signature', () => {
      expect(DnsDiscoveryResolver.parseRootRecord('enrtree-root:v1 e=ABC seq=1')).toBeNull();
    });
  });

  describe('parseBranchRecord', () => {
    it('parses multiple hashes', () => {
      const hashes = DnsDiscoveryResolver.parseBranchRecord('enrtree-branch:abc def ghi');
      expect(hashes).toEqual(['abc', 'def', 'ghi']);
    });

    it('parses single hash', () => {
      const hashes = DnsDiscoveryResolver.parseBranchRecord('enrtree-branch:abc');
      expect(hashes).toEqual(['abc']);
    });

    it('returns empty for invalid', () => {
      expect(DnsDiscoveryResolver.parseBranchRecord('')).toEqual([]);
      expect(DnsDiscoveryResolver.parseBranchRecord('garbage')).toEqual([]);
    });
  });

  describe('resolve', () => {
    it('returns empty for null/empty', async () => {
      expect(await DnsDiscoveryResolver.resolve('')).toEqual([]);
    });

    it('returns empty for unrecognized format', async () => {
      expect(await DnsDiscoveryResolver.resolve('garbage')).toEqual([]);
    });

    it('returns empty for invalid port', async () => {
      expect(await DnsDiscoveryResolver.resolve('hostname:invalid')).toEqual([]);
    });

    it('resolves seed domain A records', async () => {
      mockResolve4.mockResolvedValueOnce(['10.0.0.1', '10.0.0.2']);

      const peers = await DnsDiscoveryResolver.resolveSeedDomain('seeds.example.com', 8089);
      expect(peers).toHaveLength(2);
      expect(peers[0].host).toBe('10.0.0.1');
      expect(peers[0].tcpPort).toBe(8089);
      expect(peers[1].host).toBe('10.0.0.2');
    });

    it('resolves domain:port format via resolve()', async () => {
      mockResolve4.mockResolvedValueOnce(['10.0.0.1']);

      const peers = await DnsDiscoveryResolver.resolve('seeds.example.com:8089');
      expect(peers).toHaveLength(1);
      expect(peers[0].host).toBe('10.0.0.1');
      expect(peers[0].tcpPort).toBe(8089);
    });

    it('handles DNS failure gracefully', async () => {
      mockResolve4.mockRejectedValueOnce(new Error('DNS failure'));

      const peers = await DnsDiscoveryResolver.resolveSeedDomain('unknown.example.com', 8089);
      expect(peers).toEqual([]);
    });

    it('resolves enrtree URL', async () => {
      const pubKeyHex = '0000000000000000000000000000000000000000000000000000000000000000';
      mockResolveTxt
        .mockResolvedValueOnce([[
          `enrtree-root:v1 e=abc123 seq=1 sig=00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000`,
        ]])
        .mockResolvedValueOnce([['enr:']]);

      const result = await DnsDiscoveryResolver.resolve(`enrtree://${pubKeyHex}@nodes.example.com`);
      expect(result).toEqual([]);
    });
  });

  describe('queryTxt', () => {
    it('returns joined TXT records', async () => {
      mockResolveTxt.mockResolvedValueOnce([['hello', 'world'], ['foo']]);
      const records = await DnsDiscoveryResolver.queryTxt('example.com');
      expect(records).toEqual(['helloworld', 'foo']);
    });

    it('returns empty on failure', async () => {
      mockResolveTxt.mockRejectedValueOnce(new Error('DNS error'));
      const records = await DnsDiscoveryResolver.queryTxt('bad.example.com');
      expect(records).toEqual([]);
    });
  });
});
