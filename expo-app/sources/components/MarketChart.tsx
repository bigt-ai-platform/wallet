import * as React from 'react';
import Svg, { Rect, Polyline, Line as SvgLine, Text as SvgText } from 'react-native-svg';
import { recentCandles, type Candle } from '@/lib/candles';

export type { Candle } from '@/lib/candles';
export { MAX_CANDLES } from '@/lib/candles';

export interface ChartPoint {
  price: number;
  executedQuantity: number;
  time: number; // epoch ms
}

export interface ChartData {
  tokenid: string;
  tokenname: string;
  datas: ChartPoint[];
}

/**
 * Interval options (minutes). Mirrors the Java `chartdata` HTML selectors and
 * the values understood by the L1 `getOrdersTicker` time-series mode.
 */
export const INTERVALS: { label: string; minutes: number }[] = [
  { label: '1m', minutes: 1 },
  { label: '3m', minutes: 3 },
  { label: '5m', minutes: 5 },
  { label: '15m', minutes: 15 },
  { label: '30m', minutes: 30 },
  { label: '1h', minutes: 60 },
  { label: '2h', minutes: 120 },
  { label: '4h', minutes: 240 },
  { label: '6h', minutes: 360 },
  { label: '12h', minutes: 720 },
  { label: '1d', minutes: 1440 },
  { label: '1w', minutes: 10080 },
  { label: '1M', minutes: 43200 },
];

export const CHART_PAD = 8;

/** Formats an axis value: integers stay whole, fractions show at most 2 decimals. */
export function formatAxisValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

/** Date label for the x-axis: day when the window is long, time when short. */
export function formatAxisDate(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime
    ? `${date} ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getFullYear()}-${date}`;
}

interface CandleLayout {
  candles: Candle[];
  x: (i: number) => number;
  y: (v: number) => number;
  bodyW: number;
  maxY: number;
  minY: number;
}

/**
 * Map candles onto pixel space. The price range is scaled around the traded
 * values with ±10% headroom (at least ±2% of the latest close) so the candles
 * are not pinned to the pane edges.
 */
function layout(candles: Candle[], height: number, width: number): CandleLayout {
  const pricePad = 4;
  const plotH = Math.max(height - pricePad * 2, 1);
  const plotW = Math.max(width - CHART_PAD * 2, 1);
  let maxY = -Infinity;
  let minY = Infinity;
  for (const c of candles) {
    maxY = Math.max(maxY, c.high);
    minY = Math.min(minY, c.low);
  }
  const last = candles[candles.length - 1]?.close ?? 0;
  const span0 = maxY - minY;
  const pad = Math.max(span0 * 0.1, Math.abs(last) * 0.02, 1e-9);
  maxY += pad;
  minY = Math.max(0, minY - pad);
  const span = Math.max(maxY - minY, 1e-9);
  const step = plotW / Math.max(candles.length, 1);
  const x = (i: number) => CHART_PAD + step * (i + 0.5);
  const y = (v: number) => pricePad + (1 - (v - minY) / span) * plotH;
  const bodyW = Math.max(Math.min(step * 0.7, 14), 1);
  return { candles, x, y, bodyW, maxY, minY };
}

export interface PriceChartProps {
  chart: ChartData | null;
  width: number;
  height?: number;
  lineColor?: string;
  dividerColor: string;
  textColor: string;
  posColor: string;
  negColor: string;
  /** Candle pane or a close-price line (Binance's line chart type). */
  mode?: 'line' | 'candles';
  /** Candle bucket size in minutes; must match the selected interval. */
  intervalMinutes?: number;
  testID?: string;
}

/**
 * Price pane. In `line` mode it draws a close-price line (Binance's line chart
 * type); in `candles` mode it draws OHLC candlesticks (green up / red down).
 * A light price grid with high/low axis labels frames both. Uses
 * react-native-svg so the same renderer works on web and native.
 */
export function PriceChart({
  chart, width, height = 220, lineColor, dividerColor, textColor, posColor, negColor,
  mode = 'line', intervalMinutes = 60, testID,
}: PriceChartProps) {
  const candles = recentCandles(chart?.datas, intervalMinutes);
  if (candles.length === 0) {
    return <Svg width={width} height={height} testID={testID} />;
  }
  const { x, y, bodyW, maxY, minY } = layout(candles, height, width);
  const gridLines = 4;
  const linePoints = candles.map((c, i) => `${x(i).toFixed(1)},${y(c.close).toFixed(1)}`).join(' ');

  return (
    <Svg width={width} height={height} testID={testID}>
      {/* horizontal grid + price labels */}
      {Array.from({ length: gridLines + 1 }).map((_, i) => {
        const gy = CHART_PAD + ((height - CHART_PAD * 2) * i) / gridLines;
        const val = maxY - ((maxY - minY) * i) / gridLines;
        return (
          <React.Fragment key={`g-${i}`}>
            <SvgLine x1={CHART_PAD} y1={gy} x2={width - CHART_PAD} y2={gy} stroke={dividerColor} strokeWidth={1} opacity={0.5} />
            <SvgText x={CHART_PAD + 2} y={gy - 2} fill={textColor} fontSize={9}>{formatAxisValue(val)}</SvgText>
          </React.Fragment>
        );
      })}
      {mode === 'line' ? (
        <Polyline points={linePoints} fill="none" stroke={lineColor ?? posColor} strokeWidth={2} />
      ) : (
        candles.map((c, i) => {
          const up = c.close >= c.open;
          const color = up ? posColor : negColor;
          const cx = x(i);
          const yHigh = y(c.high);
          const yLow = y(c.low);
          const yOpen = y(c.open);
          const yClose = y(c.close);
          const top = Math.min(yOpen, yClose);
          const bodyH = Math.max(Math.abs(yClose - yOpen), 1);
          return (
            <React.Fragment key={`c-${i}`}>
              <SvgLine x1={cx} y1={yHigh} x2={cx} y2={yLow} stroke={color} strokeWidth={1} />
              <Rect x={cx - bodyW / 2} y={top} width={bodyW} height={bodyH} fill={color} />
            </React.Fragment>
          );
        })
      )}
    </Svg>
  );
}

export interface VolumeChartProps {
  chart: ChartData | null;
  width: number;
  height?: number;
  textColor: string;
  posColor: string;
  negColor: string;
  /** Candle bucket size in minutes; must match the price pane. */
  intervalMinutes?: number;
  testID?: string;
}

/** Volume bars aligned to the candles, colored by the candle direction. */
export function VolumeChart({
  chart, width, height = 140, textColor, posColor, negColor,
  intervalMinutes = 60, testID,
}: VolumeChartProps) {
  const candles = recentCandles(chart?.datas, intervalMinutes);
  if (candles.length === 0) {
    return <Svg width={width} height={height} testID={testID} />;
  }
  const plotH = Math.max(height - CHART_PAD * 2, 1);
  const plotW = Math.max(width - CHART_PAD * 2, 1);
  const step = plotW / Math.max(candles.length, 1);
  const bodyW = Math.max(Math.min(step * 0.7, 14), 1);
  const maxVol = Math.max(...candles.map((c) => c.volume), 0);

  return (
    <Svg width={width} height={height} testID={testID}>
      <SvgText x={CHART_PAD + 2} y={CHART_PAD + 9} fill={textColor} fontSize={9}>{formatAxisValue(maxVol)}</SvgText>
      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const h = Math.max((c.volume / Math.max(maxVol, 1)) * plotH, 1);
        const cx = CHART_PAD + step * (i + 0.5);
        return (
          <Rect
            key={`v-${i}`}
            x={cx - bodyW / 2}
            y={height - CHART_PAD - h}
            width={bodyW}
            height={h}
            fill={up ? posColor : negColor}
            opacity={0.7}
          />
        );
      })}
    </Svg>
  );
}
