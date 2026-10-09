import { describe, expect, it } from 'vitest';
import { sma, ema, rsi, boll, macd, kdj } from '../indicators';

describe('sma', () => {
  it('averages the trailing window and leaves a null warm-up', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
});

describe('ema', () => {
  it('seeds with the SMA then smooths', () => {
    expect(ema([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
  });
});

describe('rsi', () => {
  it('is 100 for a monotonically rising series', () => {
    const out = rsi([1, 2, 3, 4, 5, 6, 7], 3);
    expect(out[3]).toBe(100);
    expect(out[6]).toBe(100);
  });
});

describe('boll', () => {
  it('centres the mid band on the SMA', () => {
    const { mid, upper, lower } = boll([1, 2, 3, 4, 5], 3, 2);
    expect(mid[2]).toBe(2);
    expect(upper[2]! > mid[2]!).toBe(true);
    expect(lower[2]! < mid[2]!).toBe(true);
  });
});

describe('macd', () => {
  it('produces the DIF/DEA/histogram triple with hist = (dif - dea) * 2', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.1);
    const { dif, dea, hist } = macd(closes);
    expect(dif.length).toBe(closes.length);
    const last = closes.length - 1;
    expect(dif[last]).not.toBeNull();
    expect(dea[last]).not.toBeNull();
    expect(hist[last]).toBeCloseTo(((dif[last] as number) - (dea[last] as number)) * 2, 6);
  });
});

describe('kdj', () => {
  it('stays within 0..100 for K/D on a bounded series', () => {
    const n = 40;
    const high = Array.from({ length: n }, (_, i) => 10 + (i % 5));
    const low = Array.from({ length: n }, (_, i) => 5 + (i % 5));
    const close = Array.from({ length: n }, (_, i) => 7 + (i % 5));
    const { k, d } = kdj(high, low, close);
    const last = n - 1;
    expect(k[last]!).toBeGreaterThanOrEqual(0);
    expect(k[last]!).toBeLessThanOrEqual(100);
    expect(d[last]!).toBeGreaterThanOrEqual(0);
    expect(d[last]!).toBeLessThanOrEqual(100);
  });
});
