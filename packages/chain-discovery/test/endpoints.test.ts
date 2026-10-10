import { describe, expect, it } from 'vitest';
import {
  FIN_LAG_MAX,
  RATE_WINDOW_MS,
  SPREAD_MAX,
  activeUrlsForChain,
  cacheStale,
  demote,
  isOnionUrl,
  orderEndpoints,
  orderOnionLast,
  parseChainProbe,
  rankProbes,
  selectAndRank,
  withSlash,
  type ChainSample,
  type ProbeResult,
  type RankedEndpoint,
} from '../src/endpoints.js';

const p = (url: string, chainLength: number, latencyMs: number, extra: Partial<ProbeResult> = {}): ProbeResult => ({
  url,
  chainLength,
  latencyMs,
  ...extra,
});

describe('parseChainProbe', () => {
  it('reads txReward.chainLength + checkpoints from a served head', () => {
    expect(
      parseChainProbe({
        txReward: { chainLength: 65139, blockHashHex: 'abc', confirmed: true, version: 1 },
        finalizedChainLength: 63952,
        finalizedEpoch: 7994,
        justifiedEpoch: 8086,
        justifiedBlockHash: 'def',
        finalizedBlockHash: 'fed',
      }),
    ).toEqual({
      chainLength: 65139,
      finalizedChainLength: 63952,
      finalizedEpoch: 7994,
      justifiedEpoch: 8086,
      head: 'abc',
      confirmed: true,
      version: 1,
      justifiedBlockHash: 'def',
      finalizedBlockHash: 'fed',
    });
  });

  it('defaults optional head/checkpoint fields when absent', () => {
    expect(parseChainProbe({ txReward: { chainLength: 42 } })).toEqual({
      chainLength: 42,
      finalizedChainLength: null,
      finalizedEpoch: null,
      justifiedEpoch: null,
      head: '',
      confirmed: null,
      version: null,
      justifiedBlockHash: '',
      finalizedBlockHash: '',
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

describe('selectAndRank (checkchains.sh pass criteria)', () => {
  const now = 1_000_000;
  const prevAt = now - (RATE_WINDOW_MS + 1000);
  const sample = (chainLength: number, at = prevAt): ChainSample => ({ at, chainLength });

  it('ranks survivors by chain length, then latency', () => {
    const { ranked, excluded } = selectAndRank(
      [p('a', 100, 10), p('b', 104, 50), p('c', 104, 5)],
      { now },
    );
    expect(ranked.map((r) => r.url)).toEqual(['c', 'b', 'a']);
    expect(excluded).toEqual([]);
    expect(ranked.every((r) => r.at === now)).toBe(true);
  });

  it('excludes nodes more than SPREAD_MAX behind the head', () => {
    const { ranked, excluded } = selectAndRank(
      [p('head', 100, 10), p('edge', 100 - SPREAD_MAX, 5), p('laggard', 100 - SPREAD_MAX - 1, 1)],
      { now },
    );
    expect(excluded).toEqual([{ url: 'laggard', reason: 'behind' }]);
    expect(ranked.map((r) => r.url)).toEqual(['head', 'edge']);
  });

  it('excludes a node whose finality lag exceeds FIN_LAG_MAX', () => {
    const { ranked, excluded } = selectAndRank(
      [
        p('stuck-finality', 130, 5, { finalizedChainLength: 130 - FIN_LAG_MAX - 1 }),
        p('finalized', 130, 10, { finalizedChainLength: 120 }),
        p('no-finality', 130, 20, { finalizedChainLength: null }),
      ],
      { now },
    );
    expect(excluded).toEqual([{ url: 'stuck-finality', reason: 'finality-lag' }]);
    expect(ranked.map((r) => r.url)).toEqual(['finalized', 'no-finality']);
  });

  it('excludes a minority head hash at the same chain length', () => {
    const { ranked, excluded } = selectAndRank(
      [
        p('a', 100, 10, { head: 'aaa' }),
        p('b', 100, 20, { head: 'aaa' }),
        p('forked', 100, 1, { head: 'ccc' }),
      ],
      { now },
    );
    expect(excluded).toEqual([{ url: 'forked', reason: 'fork' }]);
    expect(ranked.map((r) => r.url)).toEqual(['a', 'b']);
  });

  it('keeps everyone when heads at the same length tie or are unknown', () => {
    const tie = selectAndRank([p('a', 100, 1, { head: 'aaa' }), p('b', 100, 2, { head: 'ccc' })], { now });
    expect(tie.excluded).toEqual([]);
    expect(tie.ranked.map((r) => r.url)).toEqual(['a', 'b']);

    const unknown = selectAndRank([p('a', 100, 1, { head: 'aaa' }), p('b', 100, 2, { head: '' })], { now });
    expect(unknown.excluded).toEqual([]);
    expect(unknown.ranked.map((r) => r.url)).toEqual(['a', 'b']);
  });

  it('excludes a node that stopped advancing while others did', () => {
    const { ranked, excluded } = selectAndRank(
      [p('advancing', 105, 10), p('stalled', 100, 5)],
      {
        now,
        prev: { advancing: sample(100), stalled: sample(100) },
      },
    );
    expect(excluded).toEqual([{ url: 'stalled', reason: 'stalled' }]);
    expect(ranked.map((r) => r.url)).toEqual(['advancing']);
  });

  it('keeps everyone on a chain-wide stall or before the rate window elapses', () => {
    const wide = selectAndRank([p('a', 100, 10), p('b', 100, 5)], {
      now,
      prev: { a: sample(100), b: sample(101) },
    });
    expect(wide.excluded).toEqual([]);
    expect(wide.ranked.map((r) => r.url)).toEqual(['b', 'a']);

    const fresh = selectAndRank([p('a', 105, 10), p('b', 100, 5)], {
      now,
      prev: { a: sample(100, now - 1000), b: sample(100, now - 1000) },
    });
    expect(fresh.excluded).toEqual([]);
    expect(fresh.ranked.map((r) => r.url)).toEqual(['a', 'b']);
  });

  it('never returns an empty selection when probes exist', () => {
    const allLagging = [
      p('a', 130, 10, { finalizedChainLength: 1 }),
      p('b', 130, 20, { finalizedChainLength: 1 }),
    ];
    const { ranked, excluded } = selectAndRank(allLagging, { now });
    expect(ranked.map((r) => r.url)).toEqual(['a', 'b']);
    expect(excluded.map((e) => e.reason)).toEqual(['finality-lag', 'finality-lag']);

    // mirrors rankProbes: with no progress at all, the responsive set is kept
    expect(selectAndRank([p('dead', 0, 1)], { now }).ranked.map((r) => r.url)).toEqual(['dead']);
    expect(selectAndRank([], { now })).toEqual({ ranked: [], excluded: [] });
  });

  it('drops chainless nodes the same way rankProbes does', () => {
    const { ranked, excluded } = selectAndRank([p('ok', 50, 10), p('dead', 0, 1)], { now });
    expect(ranked.map((r) => r.url)).toEqual(['ok']);
    expect(excluded).toEqual([]);
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
