import { describe, expect, it } from 'vitest';
import {
  activeUrlsForChain,
  cacheStale,
  demote,
  isOnionUrl,
  orderEndpoints,
  orderOnionLast,
  parseChainProbe,
  rankProbes,
  withSlash,
  type ProbeResult,
  type RankedEndpoint,
} from '../endpoints';

const p = (url: string, chainLength: number, latencyMs: number): ProbeResult => ({
  url,
  chainLength,
  latencyMs,
});

describe('parseChainProbe', () => {
  it('reads txReward.chainLength + checkpoints from a served head', () => {
    expect(
      parseChainProbe({
        txReward: { chainLength: 65139, blockHashHex: 'abc' },
        finalizedChainLength: 63952,
        finalizedEpoch: 7994,
        justifiedEpoch: 8086,
      }),
    ).toEqual({
      chainLength: 65139,
      finalizedChainLength: 63952,
      finalizedEpoch: 7994,
      justifiedEpoch: 8086,
      head: 'abc',
    });
  });

  it('accepts txReward as a JSON string', () => {
    expect(parseChainProbe({ txReward: '{"chainLength":42}' })?.chainLength).toBe(42);
  });

  it('rejects a not-ready/diverged node (errorcode, see checkchain.sh)', () => {
    expect(parseChainProbe({ errorcode: 103, message: 'service is not ready' })).toBeNull();
  });

  it('rejects a response without a usable chainLength', () => {
    expect(parseChainProbe(null)).toBeNull();
    expect(parseChainProbe({ txReward: {} })).toBeNull();
    expect(parseChainProbe({ txReward: { chainLength: 0 } })).toBeNull();
    expect(parseChainProbe({ txReward: 'not json' })).toBeNull();
  });
});

describe('rankProbes', () => {
  it('orders by most chain progress, then lowest latency', () => {
    const ranked = rankProbes([p('a', 100, 10), p('b', 100, 5), p('c', 101, 50)], { now: 7 });
    expect(ranked.map((r) => r.url)).toEqual(['c', 'b', 'a']);
    expect(ranked.every((r) => r.at === 7)).toBe(true);
  });

  it('keeps every responsive node as a failover target, even if behind', () => {
    const ranked = rankProbes([p('fresh', 100, 90), p('ok', 98, 10), p('slow', 20, 1)]);
    expect(ranked.map((r) => r.url)).toEqual(['fresh', 'ok', 'slow']);
  });

  it('drops nodes with no chain (0) when another node has progress', () => {
    const ranked = rankProbes([p('a', 50, 10), p('dead', 0, 1)]);
    expect(ranked.map((r) => r.url)).toEqual(['a']);
  });

  it('returns [] for no successful probes', () => {
    expect(rankProbes([])).toEqual([]);
  });
});

describe('cacheStale', () => {
  it('is stale when missing or past the ttl', () => {
    expect(cacheStale(undefined, 1000, 5000)).toBe(true);
    expect(cacheStale({ at: 4500 }, 1000, 5000)).toBe(false);
    expect(cacheStale({ at: 3999 }, 1000, 5000)).toBe(true);
  });
});

describe('orderEndpoints', () => {
  const cached: RankedEndpoint[] = [
    { url: 'eu2', chainLength: 10, latencyMs: 5, at: 1 },
    { url: 'eu3', chainLength: 9, latencyMs: 5, at: 1 },
  ];

  it('prefers the user URL, then the ranking, then remaining defaults', () => {
    expect(orderEndpoints(['eu1', 'eu2', 'eu3'], cached, 'eu3')).toEqual(['eu3', 'eu2', 'eu1']);
  });

  it('dedupes a preferred URL that is also a default', () => {
    expect(orderEndpoints(['eu1', 'eu2', 'eu3'], cached, 'eu1')).toEqual(['eu1', 'eu2', 'eu3']);
  });

  it('falls back to defaults without a ranking', () => {
    expect(orderEndpoints(['eu1'], [], 'eu1')).toEqual(['eu1']);
  });
});

describe('activeUrlsForChain', () => {
  const list = [
    { url: 'https://l0.example', chain: 'L0', status: 'active' },
    { url: 'https://order.example', chain: 'ordermatch', status: 'active' },
    { url: 'https://dead.example', chain: 'L0', status: 'inactive' },
    { url: 'https://legacy.example', chain: '', status: 'active' },
    { url: '', chain: 'L0', status: 'active' },
  ];

  it('keeps chain matches first, then unlabelled, filtered to active', () => {
    expect(activeUrlsForChain(list, 'L0')).toEqual(['https://l0.example', 'https://legacy.example']);
    expect(activeUrlsForChain(list, 'ordermatch')).toEqual([
      'https://order.example',
      'https://legacy.example',
    ]);
  });

  it('matches case-insensitively, dedupes, tolerates null', () => {
    expect(activeUrlsForChain([{ url: 'https://a/', chain: 'l0' }, { url: 'https://a', chain: 'L0' }], 'L0')).toEqual([
      'https://a',
    ]);
    expect(activeUrlsForChain(null, 'L0')).toEqual([]);
  });
});

describe('onion ordering', () => {
  it('detects .onion hosts (with or without scheme/port)', () => {
    expect(isOnionUrl('http://abcdefghijklmnop.onion')).toBe(true);
    expect(isOnionUrl('http://abcdefghijklmnop.onion:8089')).toBe(true);
    expect(isOnionUrl('abcdefghijklmnop.onion')).toBe(true);
    expect(isOnionUrl('https://eu1.bigtangle.org')).toBe(false);
    expect(isOnionUrl('/l0/')).toBe(false);
  });

  it('keeps clear-net first and onion last, preserving order', () => {
    expect(
      orderOnionLast(['https://eu1', 'http://x.onion', 'https://eu2', 'http://y.onion']),
    ).toEqual(['https://eu1', 'https://eu2', 'http://x.onion', 'http://y.onion']);
  });
});

describe('demote / withSlash', () => {
  it('moves a failing endpoint to the end', () => {
    expect(demote(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
    expect(demote(['a', 'b'], 'z')).toEqual(['a', 'b']);
  });

  it('adds exactly one trailing slash', () => {
    expect(withSlash('https://x')).toBe('https://x/');
    expect(withSlash('https://x/')).toBe('https://x/');
    expect(withSlash('/l0/')).toBe('/l0/');
  });
});
