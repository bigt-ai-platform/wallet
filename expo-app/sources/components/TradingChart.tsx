import * as React from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { recentCandles, type Candle } from '@/lib/candles';
import { sma, boll, macd, rsi, kdj, type Num } from '@/lib/indicators';
import type { ChartData } from '@/components/MarketChart';

export interface TradingChartColors {
  up: string;
  down: string;
  line: string;
  text: string;
  grid: string;
  background: string;
}

export interface ChartIndicators {
  ma: boolean;
  boll: boolean;
  vol: boolean;
  macd: boolean;
  rsi: boolean;
  kdj: boolean;
}

export const DEFAULT_INDICATORS: ChartIndicators = {
  ma: true, boll: false, vol: true, macd: false, rsi: false, kdj: false,
};

export interface TradingChartProps {
  chart: ChartData | null;
  mode: 'line' | 'candles';
  intervalMinutes: number;
  height: number;
  colors: TradingChartColors;
  indicators?: ChartIndicators;
  testID?: string;
  onError?: () => void;
}

/** Binance-like MA colours. */
const MA_COLORS = ['#F0B90B', '#5B8FF9', '#B37FEB'];
const MA_PERIODS = [7, 25, 99];
const RSI_PERIODS = [6, 12, 24];
const RSI_COLORS = ['#F0B90B', '#5B8FF9', '#B37FEB'];
const BOLL_COLOR = '#8C8C8C';
const KDJ_COLORS = ['#F0B90B', '#5B8FF9', '#B37FEB'];

const T = (c: Candle): UTCTimestamp => (c.time / 1000) as UTCTimestamp;

/** Map an aligned indicator array (nulls = warm-up) to line points. */
function lineData(candles: Candle[], values: Num[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) out.push({ time: T(candles[i]), value: v as number });
  }
  return out;
}

/**
 * TradingView `lightweight-charts` pane (the same charting library family
 * Binance uses): line/candlestick price, an optional volume pane and the MA /
 * BOLL / MACD / RSI / KDJ technical indicators. Canvas-based, so crosshair,
 * tooltips and zoom/pan come for free. Both the web build and the Capacitor
 * Android shell run the same web bundle, so one implementation serves both.
 *
 * The whole chart is rebuilt whenever the data, interval, mode or indicator
 * selection changes — chart creation is cheap and this keeps pane management
 * simple (panes are created in a fixed order as the indicators are enabled).
 */
export default function TradingChart({
  chart, mode, intervalMinutes, height, colors, indicators = DEFAULT_INDICATORS, testID, onError,
}: TradingChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const indKey = `${indicators.ma}${indicators.boll}${indicators.vol}${indicators.macd}${indicators.rsi}${indicators.kdj}`;

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof document === 'undefined') { onError?.(); return undefined; }
    let api: IChartApi;
    try {
      api = createChart(el, {
        autoSize: true,
        layout: { background: { color: 'transparent' }, textColor: colors.text, attributionLogo: false },
        grid: { vertLines: { color: colors.grid, visible: false }, horzLines: { color: colors.grid } },
        rightPriceScale: { borderColor: colors.grid },
        timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
    } catch (e) {
      console.error('lightweight-charts init failed:', e);
      onError?.();
      return undefined;
    }

    const candles = recentCandles(chart?.datas, intervalMinutes);
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);

    // --- pane 0: price ---
    const price = mode === 'candles'
      ? api.addSeries(CandlestickSeries, {
        upColor: colors.up, downColor: colors.down,
        borderUpColor: colors.up, borderDownColor: colors.down,
        wickUpColor: colors.up, wickDownColor: colors.down,
      }, 0)
      : api.addSeries(LineSeries, { color: colors.line, lineWidth: 2 }, 0);
    price.setData(
      (mode === 'candles'
        ? candles.map((c) => ({ time: T(c), open: c.open, high: c.high, low: c.low, close: c.close }))
        : candles.map((c) => ({ time: T(c), value: c.close }))) as never,
    );

    if (indicators.ma) {
      MA_PERIODS.forEach((p, i) => {
        const s = api.addSeries(LineSeries, { color: MA_COLORS[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
        s.setData(lineData(candles, sma(closes, p)) as never);
      });
    }
    if (indicators.boll) {
      const b = boll(closes, 20, 2);
      [b.upper, b.mid, b.lower].forEach((band) => {
        const s = api.addSeries(LineSeries, { color: BOLL_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, 0);
        s.setData(lineData(candles, band) as never);
      });
    }

    // --- additional panes, created in a fixed order ---
    let paneCount = 1;
    const nextPane = () => { api.addPane(); return paneCount++; };

    if (indicators.vol) {
      const p = nextPane();
      const vol = api.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, p);
      vol.setData(candles.map((c) => ({
        time: T(c), value: c.volume, color: (c.close >= c.open ? colors.up : colors.down) + '80',
      })) as never);
    }

    if (indicators.macd) {
      const p = nextPane();
      const m = macd(closes);
      const hist = api.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, p);
      hist.setData(candles
        .map((c, i) => ({ time: T(c), value: m.hist[i], v: m.hist[i] }))
        .filter((d) => d.value != null)
        .map((d) => ({ time: d.time, value: d.value as number, color: (d.v as number) >= 0 ? colors.up : colors.down })) as never);
      const dif = api.addSeries(LineSeries, { color: '#F0B90B', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, p);
      dif.setData(lineData(candles, m.dif) as never);
      const dea = api.addSeries(LineSeries, { color: '#5B8FF9', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, p);
      dea.setData(lineData(candles, m.dea) as never);
    }

    if (indicators.rsi) {
      const p = nextPane();
      RSI_PERIODS.forEach((period, i) => {
        const s = api.addSeries(LineSeries, { color: RSI_COLORS[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, p);
        s.setData(lineData(candles, rsi(closes, period)) as never);
        if (i === 0) {
          s.createPriceLine({ price: 70, color: colors.grid, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
          s.createPriceLine({ price: 30, color: colors.grid, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false, title: '' });
        }
      });
    }

    if (indicators.kdj) {
      const p = nextPane();
      const kd = kdj(highs, lows, closes);
      [kd.k, kd.d, kd.j].forEach((arr, i) => {
        const s = api.addSeries(LineSeries, { color: KDJ_COLORS[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, p);
        s.setData(lineData(candles, arr) as never);
      });
    }

    // Give the price pane most of the height when sub-panes are present.
    const panes = api.panes();
    if (panes.length > 1) {
      panes[0]?.setStretchFactor(panes.length === 2 ? 3 : 4);
      for (let i = 1; i < panes.length; i++) panes[i]?.setStretchFactor(1);
    }
    api.timeScale().fitContent();

    return () => {
      try { api.remove(); } catch { /* already disposed */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, intervalMinutes, mode, indKey]);

  return React.createElement('div', {
    ref: containerRef,
    'data-testid': testID,
    style: { width: '100%', height },
  });
}
