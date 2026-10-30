import { describe, it, expect } from 'vitest';
import {
  hostOf, normalizeUrl, shortHash, buildChainTargets, nodeNameForUrl, proxyBaseForUrl,
} from '../chainstatus';

describe('hostOf', () => {
  it('strips scheme, path and trailing slash', () => {
    expect(hostOf('https://eu1.bigtangle.org/')).toBe('eu1.bigtangle.org');
    expect(hostOf('http://127.0.0.1:24089/')).toBe('127.0.0.1:24089');
    expect(hostOf('https://ordereu1.bigtangle.org')).toBe('ordereu1.bigtangle.org');
  });

  it('keeps relative proxy paths usable and tolerates empty input', () => {
    expect(hostOf('/l0/')).toBe('/l0');
    expect(hostOf('')).toBe('');
  });
});

describe('normalizeUrl', () => {
  it('is case-insensitive and slash-insensitive', () => {
    expect(normalizeUrl('https://EU1.bigtangle.org/')).toBe('https://eu1.bigtangle.org');
    expect(normalizeUrl('https://eu1.bigtangle.org')).toBe('https://eu1.bigtangle.org');
  });
});

describe('shortHash', () => {
  it('keeps short ids and truncates long hashes at both ends', () => {
    expect(shortHash('abcdef')).toBe('abcdef');
    expect(shortHash('147f2fe2505c1880fbbdaac26ae996009ed2e7612f4995b22a5f6ed92529861c'))
      .toBe('147f2fe2…2529861c');
    expect(shortHash(null)).toBe('');
  });
});

describe('buildChainTargets', () => {
  it('lists all L0 candidates then all configured L1 chains and shared L1 candidates', () => {
    const rows = buildChainTargets(
      ['https://eu1.bigtangle.org', 'https://eu2.bigtangle.org'],
      [
        { name: 'Main', url: 'https://ordereu1.bigtangle.org' },
        { name: '', url: 'https://ordereu2.bigtangle.org' },
      ],
      ['https://ordereu1.bigtangle.org', 'https://ordereu3.bigtangle.org'],
    );
    expect(rows.map((r) => [r.role, r.name, r.url])).toEqual([
      ['l0', 'L0', 'https://eu1.bigtangle.org'],
      ['l0', 'L0', 'https://eu2.bigtangle.org'],
      ['l1', 'Main', 'https://ordereu1.bigtangle.org'],
      ['l1', 'L1', 'https://ordereu2.bigtangle.org'],
      ['l1', 'L1', 'https://ordereu3.bigtangle.org'],
    ]);
  });

  it('dedupes per role and keeps the same URL under both roles', () => {
    const rows = buildChainTargets(
      ['https://shared.example'],
      [{ name: 'Order', url: 'https://shared.example/' }],
      ['https://shared.example', 'https://shared.example/'],
    );
    expect(rows.map((r) => r.key)).toEqual([
      'l0:https://shared.example',
      'l1:https://shared.example',
    ]);
    expect(rows[1].name).toBe('Order');
  });

  it('skips blank urls', () => {
    expect(buildChainTargets([''], [{ name: 'x', url: '  ' }], [''])).toEqual([]);
  });

  it('names per-node web proxy rows from their L1 chain config', () => {
    const rows = buildChainTargets(
      ['/l0/eu1/', '/l0/eu2/', '/l0/eu3/', '/l0/eu4/', '/l0/eu5/'],
      [
        { name: 'ordereu1', url: '/l1/ordereu1/' },
        { name: 'ordereu2', url: '/l1/ordereu2/' },
        { name: 'ordereu3', url: '/l1/ordereu3/' },
        { name: 'ordereu4', url: '/l1/ordereu4/' },
        { name: 'ordereu5', url: '/l1/ordereu5/' },
      ],
      ['/l1/ordereu1/', '/l1/ordereu2/', '/l1/ordereu3/', '/l1/ordereu4/', '/l1/ordereu5/'],
    );
    expect(rows.map((r) => [r.role, r.name, r.url])).toEqual([
      ['l0', 'L0', '/l0/eu1/'],
      ['l0', 'L0', '/l0/eu2/'],
      ['l0', 'L0', '/l0/eu3/'],
      ['l0', 'L0', '/l0/eu4/'],
      ['l0', 'L0', '/l0/eu5/'],
      ['l1', 'ordereu1', '/l1/ordereu1/'],
      ['l1', 'ordereu2', '/l1/ordereu2/'],
      ['l1', 'ordereu3', '/l1/ordereu3/'],
      ['l1', 'ordereu4', '/l1/ordereu4/'],
      ['l1', 'ordereu5', '/l1/ordereu5/'],
    ]);
  });

  it('names L0 rows from the optional l0Chains list', () => {
    const rows = buildChainTargets(
      ['/l0/eu1/', '/l0/eu2/'],
      [],
      [],
      [
        { name: 'eu1', url: '/l0/eu1/' },
        { name: 'eu2', url: '/l0/eu2/' },
      ],
    );
    expect(rows.map((r) => [r.role, r.name])).toEqual([
      ['l0', 'eu1'],
      ['l0', 'eu2'],
    ]);
  });
});

describe('nodeNameForUrl', () => {
  it('maps web proxy paths, bare primary and native hosts', () => {
    expect(nodeNameForUrl('/l0/eu2/', 'l0')).toBe('eu2');
    expect(nodeNameForUrl('/l1/ordereu2/', 'l1')).toBe('ordereu2');
    expect(nodeNameForUrl('/l0/', 'l0')).toBe('eu1');
    expect(nodeNameForUrl('/l1/', 'l1')).toBe('ordereu1');
    expect(nodeNameForUrl('https://hk1.bigtangle.org', 'l0')).toBe('hk1');
    expect(nodeNameForUrl('https://orderhk1.bigtangle.org', 'l1')).toBe('orderhk1');
  });

  it('maps the raw addresses a node publishes in the live registry', () => {
    expect(nodeNameForUrl('http://85.215.91.140:8082', 'l0')).toBe('eu2');
    expect(nodeNameForUrl('http://43.129.198.77:8082/', 'l0')).toBe('hk1');
    expect(nodeNameForUrl('http://85.214.37.95:8082', 'l0')).toBe('eu1');
    expect(nodeNameForUrl('https://ordereu2.bigtangle.org', 'l1')).toBe('ordereu2');
  });

  it('returns null for retired nodes, unknown hosts and empty urls', () => {
    expect(nodeNameForUrl('', 'l0')).toBeNull();
    expect(nodeNameForUrl('https://example.com', 'l0')).toBeNull();
    expect(nodeNameForUrl('/l0/eu3/', 'l0')).toBeNull();
  });
});

describe('proxyBaseForUrl', () => {
  it('turns a live registry peer into a probeable same-origin base', () => {
    expect(proxyBaseForUrl('http://43.129.198.77:8082', 'l0')).toBe('/l0/hk1/');
    expect(proxyBaseForUrl('https://ordereu2.bigtangle.org', 'l1')).toBe('/l1/ordereu2/');
  });

  it('keeps a node that already is a proxy path on that path', () => {
    expect(proxyBaseForUrl('/l0/eu2/', 'l0')).toBe('/l0/eu2/');
  });

  it('returns null for a peer the browser has no proxy for', () => {
    expect(proxyBaseForUrl('http://203.0.113.9:8082', 'l0')).toBeNull();
  });

  it('normalizes the bare primary alias and retired node paths', () => {
    // The catch-all proxy answers /l0 and /l1 with the primary node; they are
    // aliases of eu1/ordereu1, never chains of their own.
    expect(proxyBaseForUrl('/l0/', 'l0')).toBe('/l0/eu1/');
    expect(proxyBaseForUrl('/l0', 'l0')).toBe('/l0/eu1/');
    expect(proxyBaseForUrl('/l1/', 'l1')).toBe('/l1/ordereu1/');
    // Paths from an earlier deployment that no longer carry a node.
    expect(proxyBaseForUrl('/l0/eu3/', 'l0')).toBeNull();
    expect(proxyBaseForUrl('/l0/eu5/', 'l0')).toBeNull();
    expect(proxyBaseForUrl('/l1/ordereu4/', 'l1')).toBeNull();
    expect(proxyBaseForUrl('/l1p', 'l1')).toBeNull();
  });
});
