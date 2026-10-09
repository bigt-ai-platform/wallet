/**
 * Technical indicators over an OHLC/close series.
 *
 * All functions return arrays aligned with the input (index i corresponds to
 * candle i) using `null` for the warm-up region, so callers can map non-null
 * entries straight to `{ time, value }` chart points.
 */

export type Num = number | null;

/** Simple moving average. */
export function sma(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period`. */
export function ema(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(values: number[], period: number): Num[] {
  const out: Num[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const calc = () => (avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  out[period] = calc();
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = calc();
  }
  return out;
}

export interface BollResult { mid: Num[]; upper: Num[]; lower: Num[] }

/** Bollinger Bands (default period 20, ±2 standard deviations). */
export function boll(values: number[], period = 20, mult = 2): BollResult {
  const mid = sma(values, period);
  const upper: Num[] = new Array(values.length).fill(null);
  const lower: Num[] = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i];
    if (m == null) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (values[j] - m) ** 2;
    const sd = Math.sqrt(variance / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

export interface MacdResult { dif: Num[]; dea: Num[]; hist: Num[] }

/** EMA of a compact (no nulls) series, aligned from `period - 1`. */
function emaCompact(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** MACD (12, 26, 9): DIF = EMA12 − EMA26; DEA = EMA9(DIF); histogram = (DIF − DEA) × 2. */
export function macd(values: number[], fast = 12, slow = 26, signal = 9): MacdResult {
  const n = values.length;
  const ef = ema(values, fast);
  const es = ema(values, slow);
  const dif: Num[] = new Array(n).fill(null);
  const difIdx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ef[i] != null && es[i] != null) { dif[i] = (ef[i] as number) - (es[i] as number); difIdx.push(i); }
  }
  const difVals = difIdx.map((i) => dif[i] as number);
  const deaVals = emaCompact(difVals, signal);
  const dea: Num[] = new Array(n).fill(null);
  const hist: Num[] = new Array(n).fill(null);
  for (let k = 0; k < deaVals.length; k++) {
    const i = difIdx[signal - 1 + k];
    dea[i] = deaVals[k];
    hist[i] = ((dif[i] as number) - deaVals[k]) * 2;
  }
  return { dif, dea, hist };
}

export interface KdjResult { k: Num[]; d: Num[]; j: Num[] }

/** KDJ (9, 3, 3) — stochastic with the classic 2/3 + 1/3 smoothing. */
export function kdj(high: number[], low: number[], close: number[], period = 9, kPeriod = 3, dPeriod = 3): KdjResult {
  const n = close.length;
  const k: Num[] = new Array(n).fill(null);
  const d: Num[] = new Array(n).fill(null);
  const j: Num[] = new Array(n).fill(null);
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < n; i++) {
    if (i < period - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    for (let m = i - period + 1; m <= i; m++) { hh = Math.max(hh, high[m]); ll = Math.min(ll, low[m]); }
    const rsv = hh === ll ? 0 : ((close[i] - ll) / (hh - ll)) * 100;
    prevK = (prevK * (kPeriod - 1) + rsv) / kPeriod;
    prevD = (prevD * (dPeriod - 1) + prevK) / dPeriod;
    k[i] = prevK;
    d[i] = prevD;
    j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}
