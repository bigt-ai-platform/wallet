import { describe, expect, it } from 'vitest';
import { collapseTokenEmissions } from '../tokenlist';
import type { TokenItem } from '@/types/api';

const token = (over: Partial<TokenItem>): TokenItem => ({
  tokenid: 'id1',
  tokenname: 'Token',
  ...over,
});

describe('collapseTokenEmissions', () => {
  it('collapses emissions of one token into a single row', () => {
    const rows = collapseTokenEmissions([
      token({ tokenid: 'rmb', tokenname: '人民币', tokenindex: 0, amount: 10_000_000 }),
      token({ tokenid: 'rmb', tokenname: '人民币', tokenindex: 1, amount: 10_000_000 }),
      token({ tokenid: 'rmb', tokenname: '人民币', tokenindex: 2, amount: 10_000_000 }),
    ]);
    expect(rows).toHaveLength(1);
    // 3 emissions × 10,000,000 summed client-side.
    expect(rows[0].amount).toBe('30000000');
    expect(rows[0].tokenname).toBe('人民币');
  });

  it('prefers the server amountMap (the summed supply)', () => {
    const rows = collapseTokenEmissions(
      [token({ tokenid: 'rmb', amount: 10_000_000 }), token({ tokenid: 'rmb', amount: 10_000_000 })],
      { rmb: 80_000_000 },
    );
    expect(rows[0].amount).toBe(80_000_000);
  });

  it('keeps distinct tokenids as separate rows', () => {
    const rows = collapseTokenEmissions([
      token({ tokenid: 'a', tokenname: 'A', amount: 1 }),
      token({ tokenid: 'b', tokenname: 'B', amount: 2 }),
    ]);
    expect(rows.map((r) => r.tokenid)).toEqual(['a', 'b']);
  });

  it('sums amounts as bigint without losing precision', () => {
    const rows = collapseTokenEmissions([
      token({ tokenid: 'big', amount: '9007199254740993' }),
      token({ tokenid: 'big', amount: '1' }),
    ]);
    expect(rows[0].amount).toBe('9007199254740994');
  });
});
