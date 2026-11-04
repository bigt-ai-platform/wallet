import { describe, expect, it } from 'vitest';
import { BIG_TOKEN, includeNativeBig, matchesBigToken } from '../tokenSearch';
import { BC_DECIMALS } from '../tokenformat';

describe('tokenSearch / native BIG', () => {
  it('matches BIG by name prefix and by its raw id', () => {
    for (const keyword of ['b', 'bi', 'BIG', 'big', 'bigtangle', 'bc', 'BC', '  big  ']) {
      expect(matchesBigToken(keyword), keyword).toBe(true);
    }
    for (const keyword of ['', '   ', 'usdt', 'nvidia', 'x']) {
      expect(matchesBigToken(keyword), keyword).toBe(false);
    }
  });

  it('exposes BIG with the chain decimals', () => {
    expect(BIG_TOKEN).toEqual({ tokenid: 'bc', tokenname: 'BIG', decimals: BC_DECIMALS });
  });

  it('prepends BIG when the query matches', () => {
    const rows = [{ tokenid: '02aa', tokenname: 'BIGCOIN' }];
    const out = includeNativeBig(rows, 'big', BIG_TOKEN);
    expect(out.map((r) => r.tokenid)).toEqual(['bc', '02aa']);
  });

  it('does not duplicate BIG when the search already returned it', () => {
    const out = includeNativeBig([{ tokenid: 'bc', tokenname: 'BIG' }], 'bc', BIG_TOKEN);
    expect(out).toHaveLength(1);
  });

  it('leaves unrelated searches untouched', () => {
    const rows = [{ tokenid: '02aa', tokenname: 'USDT' }];
    const out = includeNativeBig(rows, 'usdt', BIG_TOKEN);
    expect(out.map((r) => r.tokenid)).toEqual(['02aa']);
  });
});
