import { describe, expect, it } from 'vitest';
import { bucketCandles, recentCandles } from '../candles';

const MIN = 60 * 1000;

describe('bucketCandles', () => {
  it('aggregates OHLC and volume per interval bucket', () => {
    const t0 = 1_700_000_000_000; // arbitrary epoch, minute-aligned check below
    const base = Math.floor(t0 / (5 * MIN)) * (5 * MIN);
    const candles = bucketCandles(
      [
        { time: base + 1 * MIN, price: 10, executedQuantity: 1 },
        { time: base + 2 * MIN, price: 12, executedQuantity: 2 },
        { time: base + 3 * MIN, price: 8, executedQuantity: 3 },
        { time: base + 4 * MIN, price: 11, executedQuantity: 4 },
      ],
      5,
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]).toEqual({ time: base, open: 10, high: 12, low: 8, close: 11, volume: 10 });
  });

  it('splits ticks across buckets and sorts unordered input', () => {
    const base = 0;
    const candles = bucketCandles(
      [
        { time: base + 6 * MIN, price: 20, executedQuantity: 1 },
        { time: base + 1 * MIN, price: 10, executedQuantity: 1 },
      ],
      5,
    );
    expect(candles.map((c) => c.time)).toEqual([0, 5 * MIN]);
    expect(candles[0].open).toBe(10);
    expect(candles[1].open).toBe(20);
  });

  it('returns an empty array for no data', () => {
    expect(bucketCandles(null, 1)).toEqual([]);
    expect(bucketCandles([], 1)).toEqual([]);
  });
});

describe('recentCandles', () => {
  it('keeps only the most recent n candles', () => {
    const ticks = Array.from({ length: 10 }, (_, i) => ({
      time: i * MIN,
      price: 100 + i,
      executedQuantity: 1,
    }));
    const candles = recentCandles(ticks, 1, 3);
    expect(candles).toHaveLength(3);
    expect(candles[2].close).toBe(109);
  });
});
