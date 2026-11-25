import { describe, expect, it } from 'vitest';
import {
  normalizeSeed,
  parseDohSeeds,
  parseSrvSeeds,
  parseTxtSeeds,
  type DohResponse,
} from '../src/dnsseeds.js';

const txt = (data: string): DohResponse => ({
  Status: 0,
  Answer: [{ name: '_bigt-ai-l0.bigt-ai.org', type: 16, data }],
});
const srv = (data: string): DohResponse => ({
  Status: 0,
  Answer: [{ name: '_bigt-ai-l0._tcp.bigt-ai.org', type: 33, data }],
});

describe('normalizeSeed', () => {
  it('normalizes full URLs and bare host[:port]', () => {
    expect(normalizeSeed('https://eu1.bigt-ai.org/')).toBe('https://eu1.bigt-ai.org');
    expect(normalizeSeed('eu2.bigt-ai.org')).toBe('https://eu2.bigt-ai.org');
    expect(normalizeSeed('eu3.bigt-ai.org:8443')).toBe('https://eu3.bigt-ai.org:8443');
  });

  it('lowercases the scheme', () => {
    expect(normalizeSeed('HTTPS://eu1.bigt-ai.org')).toBe('https://eu1.bigt-ai.org');
  });

  it('rejects empty, whitespace and non-host TXT values', () => {
    expect(normalizeSeed('')).toBeNull();
    expect(normalizeSeed('  ')).toBeNull();
    expect(normalizeSeed('http://a b')).toBeNull();
    expect(normalizeSeed('google-site-verification=abc123')).toBeNull();
    expect(normalizeSeed('localhost')).toBeNull();
  });
});

describe('parseTxtSeeds', () => {
  it('reads one quoted URL', () => {
    expect(parseTxtSeeds(txt('"https://eu1.bigt-ai.org"'))).toEqual(['https://eu1.bigt-ai.org']);
  });

  it('reads multiple quoted strings in one RR', () => {
    expect(parseTxtSeeds(txt('"https://eu1.bigt-ai.org" "eu2.bigt-ai.org"'))).toEqual([
      'https://eu1.bigt-ai.org',
      'https://eu2.bigt-ai.org',
    ]);
  });

  it('reads multiple TXT RRs, deduped', () => {
    const resp: DohResponse = {
      Status: 0,
      Answer: [
        { name: 'x', type: 16, data: '"https://eu1.bigt-ai.org"' },
        { name: 'x', type: 16, data: '"https://eu1.bigt-ai.org"' },
        { name: 'x', type: 16, data: '"https://eu2.bigt-ai.org"' },
      ],
    };
    expect(parseTxtSeeds(resp)).toEqual(['https://eu1.bigt-ai.org', 'https://eu2.bigt-ai.org']);
  });

  it('ignores non-TXT answers and NXDOMAIN', () => {
    expect(parseTxtSeeds({ Status: 0, Answer: [{ name: 'x', type: 1, data: '1.2.3.4' }] })).toEqual([]);
    expect(parseTxtSeeds({ Status: 3 })).toEqual([]);
    expect(parseTxtSeeds(null)).toEqual([]);
  });
});

describe('parseSrvSeeds', () => {
  it('builds https URLs from SRV records, omitting the default 443', () => {
    expect(parseSrvSeeds(srv('0 0 443 eu1.bigt-ai.org.'))).toEqual(['https://eu1.bigt-ai.org']);
    expect(parseSrvSeeds(srv('0 0 8443 eu2.bigt-ai.org.'))).toEqual(['https://eu2.bigt-ai.org:8443']);
  });

  it('orders by priority then weight', () => {
    const resp: DohResponse = {
      Status: 0,
      Answer: [
        { name: 'x', type: 33, data: '20 0 443 eu3.bigt-ai.org.' },
        { name: 'x', type: 33, data: '10 5 443 eu1.bigt-ai.org.' },
        { name: 'x', type: 33, data: '10 50 443 eu2.bigt-ai.org.' },
      ],
    };
    expect(parseSrvSeeds(resp)).toEqual([
      'https://eu2.bigt-ai.org',
      'https://eu1.bigt-ai.org',
      'https://eu3.bigt-ai.org',
    ]);
  });

  it('ignores non-SRV answers and NXDOMAIN', () => {
    expect(parseSrvSeeds({ Status: 0, Answer: [{ name: 'x', type: 16, data: '"a"' }] })).toEqual([]);
    expect(parseSrvSeeds({ Status: 3 })).toEqual([]);
  });
});

describe('parseDohSeeds', () => {
  it('combines TXT and SRV records', () => {
    const resp: DohResponse = {
      Status: 0,
      Answer: [
        { name: 'x', type: 16, data: '"https://eu1.bigt-ai.org"' },
        { name: 'x', type: 33, data: '0 0 443 eu2.bigt-ai.org.' },
      ],
    };
    expect(parseDohSeeds(resp)).toEqual(['https://eu1.bigt-ai.org', 'https://eu2.bigt-ai.org']);
  });
});
