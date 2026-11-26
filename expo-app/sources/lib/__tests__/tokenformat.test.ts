import { describe, expect, it } from 'vitest';
import { formatTokenAmount, orderPriceDecimals, orderRawEncodable, orderRawTotal, parseTokenAmount } from '../tokenformat';

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

  it('scales the raw order price by the quote token decimals, not the traded token', () => {
    // Java: base.getDecimals() + getOrderPriceShift(baseToken) (Wallet.java:1868-1872).
    // USDT (6dp) quote: 12 decimals for a token quote; BC (6dp) quote: 6.
    expect(orderPriceDecimals(6, 'usdt')).toBe(12);
    expect(orderPriceDecimals(6, 'bc')).toBe(6);
    // The scale follows the quote, whatever the traded token's decimals are.
    expect(orderPriceDecimals(2, 'usdt')).toBe(8);
  });

  it('rejects raw order fields the JS-number SDK cannot encode exactly', () => {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    // 10 USDT per whole zero-decimal token → 10 USDT (6dp) for one unit.
    const price = 10n * 10n ** 12n;
    expect(orderRawTotal(price, 1n, 0, 'usdt')).toBe(10n ** 7n);
    expect(orderRawEncodable(price, 1n, 0, 'usdt')).toBe(true);
    expect(orderRawEncodable(max + 1n, 1n, 0, 'usdt')).toBe(false);
    expect(orderRawEncodable(max, max, 0, 'usdt')).toBe(false);
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
