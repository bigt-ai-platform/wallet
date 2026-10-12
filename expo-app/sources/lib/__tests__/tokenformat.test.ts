import { describe, expect, it } from 'vitest';
import { formatTokenAmount, parseTokenAmount } from '../tokenformat';

describe('tokenformat', () => {
  it('formatTokenAmount trims trailing zeros like Java MonetaryFormat', () => {
    expect(formatTokenAmount(123450000n, 8)).toBe('1.2345');
    expect(formatTokenAmount(0n, 8)).toBe('0');
    expect(formatTokenAmount(100000n, 0)).toBe('100000');
    expect(formatTokenAmount(-250n, 2)).toBe('-2.5');
  });

  it('parseTokenAmount de-scales a display string (BigInt() alone throws)', () => {
    expect(() => BigInt('3999999.99463')).toThrow();
    expect(parseTokenAmount('3999999.99463', 8)).toBe(399999999463000n);
    expect(parseTokenAmount('100000', 0)).toBe(100000n);
    expect(parseTokenAmount('0', 8)).toBe(0n);
    expect(parseTokenAmount('-1.5', 2)).toBe(-150n);
    expect(parseTokenAmount('', 0)).toBe(0n);
    expect(parseTokenAmount('1.999', 2)).toBe(199n);
  });

  it('round-trips formatTokenAmount', () => {
    const cases: Array<[bigint, number]> = [
      [3999999994630n, 8],
      [0n, 6],
      [100000n, 0],
      [123450000n, 8],
      [-250n, 2],
      [999999999999999999n, 8],
    ];
    for (const [value, decimals] of cases) {
      expect(parseTokenAmount(formatTokenAmount(value, decimals), decimals)).toBe(value);
    }
  });
});
