import { describe, expect, it } from 'vitest';
import { directionSign, summarizeBalances } from '../balanceSummary';

const row = (over: Partial<Parameters<typeof summarizeBalances>[0] extends Iterable<infer T> ? T : never> = {}) => ({
  tokenid: 'bc',
  tokenname: 'BIG',
  value: '100',
  spent: false,
  layer: 0,
  ...over,
});

describe('summarizeBalances (wallet balance page)', () => {
  it('sums unspent outputs per token and keeps the token name', () => {
    const out = summarizeBalances([
      row({ value: '100' }),
      row({ value: '250' }),
      row({ tokenid: 'usdc', tokenname: 'USDC', value: '7' }),
    ]);
    expect(out.map((t) => [t.tokenId, t.tokenName, t.count])).toEqual([
      ['bc', 'BIG', 2],
      ['usdc', 'USDC', 1],
    ]);
    expect(out[0].total).toBe(BigInt(350));
  });

  it('never adds spent history rows to the balance', () => {
    const out = summarizeBalances([
      row({ value: '100' }),
      row({ value: '900', spent: true }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(BigInt(100));
    expect(out[0].count).toBe(1);
  });

  it('keeps a token row when every output is spent (history mode)', () => {
    const out = summarizeBalances([row({ value: '900', spent: true, tokenid: 'old', tokenname: 'OLD' })]);
    expect(out).toEqual([
      { tokenId: 'old', tokenName: 'OLD', total: BigInt(0), count: 0, layers: [] },
    ]);
  });

  it('lists only the layers holding unspent outputs, ascending', () => {
    const out = summarizeBalances([
      row({ layer: 2, value: '5' }),
      row({ layer: 0, value: '5' }),
      row({ layer: 2, value: '5', spent: true }),
    ]);
    expect(out[0].layers).toEqual([0, 2]);
    expect(out[0].count).toBe(2);
  });

  it('leaves layers empty for rows without a layer (public balance page)', () => {
    const out = summarizeBalances([{ tokenid: 'bc', value: '12', spent: false }]);
    expect(out).toEqual([
      { tokenId: 'bc', tokenName: 'bc', total: BigInt(12), count: 1, layers: [] },
    ]);
  });

  it('sorts by descending total', () => {
    const out = summarizeBalances([
      row({ tokenid: 'usdc', tokenname: 'USDC', value: '1' }),
      row({ value: '10' }),
    ]);
    expect(out.map((t) => t.tokenId)).toEqual(['bc', 'usdc']);
  });

  it('uses the U+2212 minus for the sent direction', () => {
    expect(directionSign(false)).toBe('+');
    expect(directionSign(true)).toBe('\u2212');
  });
});
