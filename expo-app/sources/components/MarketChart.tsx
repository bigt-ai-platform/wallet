import * as React from 'react';
import Svg, { Polyline, Rect, Line as SvgLine, Text as SvgText } from 'react-native-svg';

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

function sorted(datas: ChartPoint[]): ChartPoint[] {
  return [...datas].sort((a, b) => a.time - b.time);
}

/**
 * Build the price polyline + volume bars for a chart at a given height/width.
 * The price range is scaled around the traded values with ±15% headroom (at
 * least ±2% of the latest price) instead of pinning the line to the edges.
 */
export function buildPoints(
  chart: ChartData | null,
  chartHeight: number,
  chartWidth: number,
  posColor: string,
  negColor: string,
): {
  line: string;
  bars: React.ReactNode[];
  maxY: number;
  minY: number;
  maxVol: number;
} {
  if (!chart || chart.datas.length === 0) {
    return { line: '', bars: [], maxY: 0, minY: 0, maxVol: 0 };
  }
  const datas = sorted(chart.datas);
  const prices = datas.map((d) => d.price);
  const vols = datas.map((d) => d.executedQuantity);
  let maxY = Math.max(...prices);
  let minY = Math.min(...prices);
  const span0 = maxY - minY;
  const lastPrice = prices[prices.length - 1] ?? 0;
  const pad = Math.max(span0 * 0.15, Math.abs(lastPrice) * 0.02, 1);
  maxY += pad;
  minY = Math.max(0, minY - pad);
  const maxVol = Math.max(...vols, 0);
  const span = maxY - minY;
  const step = (chartWidth - CHART_PAD * 2) / Math.max(datas.length - 1, 1);
  const x = (i: number) => CHART_PAD + i * step;
  const y = (v: number) => CHART_PAD + (1 - (v - minY) / span) * (chartHeight - CHART_PAD * 2);

  const linePts = datas.map((d, i) => `${x(i).toFixed(1)},${y(d.price).toFixed(1)}`).join(' ');
  const bars = datas.map((d, i) => {
    const h = Math.max((d.executedQuantity / Math.max(maxVol, 1)) * (chartHeight - CHART_PAD * 2), 1);
    return (
      <Rect
        key={i}
        x={x(i) - step / 4}
        y={chartHeight - CHART_PAD - h}
        width={Math.max(step / 2, 1)}
        height={h}
        fill={d.price >= (i > 0 ? datas[i - 1].price : d.price) ? posColor : negColor}
        opacity={0.7}
      />
    );
  });
  return { line: linePts, bars, maxY, minY, maxVol };
}

export interface PriceChartProps {
  chart: ChartData | null;
  width: number;
  height?: number;
  lineColor: string;
  dividerColor: string;
  textColor: string;
  posColor: string;
  negColor: string;
  testID?: string;
}

/** Price line with y-axis min/max labels and x/y axes. */
export function PriceChart({
  chart, width, height = 220, lineColor, dividerColor, textColor, posColor, negColor, testID,
}: PriceChartProps) {
  const { line, maxY, minY } = buildPoints(chart, height, width, posColor, negColor);
  return (
    <Svg width={width} height={height} testID={testID}>
      {chart && chart.datas.length > 0 && (
        <>
          <SvgLine x1={CHART_PAD} y1={CHART_PAD} x2={CHART_PAD} y2={height - CHART_PAD} stroke={dividerColor} strokeWidth={1} />
          <SvgLine x1={CHART_PAD} y1={height - CHART_PAD} x2={width - CHART_PAD} y2={height - CHART_PAD} stroke={dividerColor} strokeWidth={1} />
          <SvgText x={CHART_PAD + 2} y={CHART_PAD + 10} fill={textColor} fontSize={9}>{formatAxisValue(maxY)}</SvgText>
          <SvgText x={CHART_PAD + 2} y={height - CHART_PAD - 4} fill={textColor} fontSize={9}>{formatAxisValue(minY)}</SvgText>
          <Polyline points={line} fill="none" stroke={lineColor} strokeWidth={2} />
        </>
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
  testID?: string;
}

/** Volume bars with a max-volume axis label. */
export function VolumeChart({
  chart, width, height = 140, textColor, posColor, negColor, testID,
}: VolumeChartProps) {
  const { bars, maxVol } = buildPoints(chart, height, width, posColor, negColor);
  return (
    <Svg width={width} height={height} testID={testID}>
      <SvgText x={CHART_PAD + 2} y={CHART_PAD + 10} fill={textColor} fontSize={9}>{formatAxisValue(maxVol)}</SvgText>
      {bars}
    </Svg>
  );
}
