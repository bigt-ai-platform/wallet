/**
 * OHLC candle aggregation for the market chart.
 *
 * The L1 `getOrdersTicker` endpoint returns individual match events as a
 * `{ price, executedQuantity, time }` series (not OHLC), so the candles are
 * bucketed client-side: open/high/low/close come from the events falling in
 * each interval bucket, and volume is their sum.
 */

export interface Tick {
  price: number;
  executedQuantity: number;
  time: number; // epoch ms
}

/** A single OHLC candle aggregated from the raw match events. */
export interface Candle {
  time: number; // bucket start, epoch ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** How many candles the price/volume panes render at most. */
export const MAX_CANDLES = 120;

function sorted(ticks: Tick[]): Tick[] {
  return [...ticks].sort((a, b) => a.time - b.time);
}

/**
 * Aggregate a raw tick series into OHLC candles. Empty buckets are skipped
 * (markets can be sparse), keeping the candle sequence contiguous in time.
 */
export function bucketCandles(ticks: Tick[] | null | undefined, intervalMinutes: number): Candle[] {
  if (!ticks || ticks.length === 0) return [];
  const bucketMs = Math.max(intervalMinutes, 1) * 60 * 1000;
  const data = sorted(ticks);
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curBucket = -1;
  for (const d of data) {
    const bucket = Math.floor(d.time / bucketMs) * bucketMs;
    if (bucket !== curBucket) {
      if (cur) out.push(cur);
      curBucket = bucket;
      cur = { time: bucket, open: d.price, high: d.price, low: d.price, close: d.price, volume: d.executedQuantity };
    } else if (cur) {
      cur.high = Math.max(cur.high, d.price);
      cur.low = Math.min(cur.low, d.price);
      cur.close = d.price;
      cur.volume += d.executedQuantity;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The most recent `n` candles (Binance shows the latest window on the right). */
export function recentCandles(ticks: Tick[] | null | undefined, intervalMinutes: number, n = MAX_CANDLES): Candle[] {
  const all = bucketCandles(ticks, intervalMinutes);
  return all.length > n ? all.slice(all.length - n) : all;
}
