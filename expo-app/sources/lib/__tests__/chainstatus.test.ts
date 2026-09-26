import { describe, it, expect } from 'vitest';
import { hostOf, normalizeUrl, shortHash, buildChainTargets } from '../chainstatus';

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
});
