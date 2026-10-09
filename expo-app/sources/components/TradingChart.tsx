import * as React from 'react';
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { recentCandles } from '@/lib/candles';
import type { ChartData } from '@/components/MarketChart';

export interface TradingChartColors {
  up: string;
  down: string;
  line: string;
  text: string;
  grid: string;
  background: string;
}

export interface TradingChartProps {
  chart: ChartData | null;
  mode: 'line' | 'candles';
  intervalMinutes: number;
  height: number;
  colors: TradingChartColors;
  testID?: string;
  /** Invoked when the TradingView library cannot be used, so the caller can
   *  fall back to the built-in SVG chart. */
  onError?: () => void;
}

/**
 * TradingView `lightweight-charts` pane (the same charting library family
 * Binance uses). Canvas-based, so it gives crosshair, tooltips and smooth
 * zoom/pan. Both the web build and the Capacitor Android shell run the same
 * web bundle, so a single implementation serves both platforms; if the library
 * fails to initialise the caller swaps in the SVG chart.
 */
export default function TradingChart({
  chart, mode, intervalMinutes, height, colors, testID, onError,
}: TradingChartProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<IChartApi | null>(null);
  const priceRef = React.useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null);
  const volRef = React.useRef<ISeriesApi<'Histogram'> | null>(null);

  // Create the chart once the DOM node exists.
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof document === 'undefined') { onError?.(); return undefined; }
    let api: IChartApi;
    try {
      api = createChart(el, {
        autoSize: true,
        layout: {
          background: { color: 'transparent' },
          textColor: colors.text,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: colors.grid, visible: false },
          horzLines: { color: colors.grid },
        },
        rightPriceScale: { borderColor: colors.grid },
        timeScale: { borderColor: colors.grid, timeVisible: true, secondsVisible: false },
        crosshair: { mode: 0 },
      });
    } catch (e) {
      console.error('lightweight-charts init failed:', e);
      onError?.();
      return undefined;
    }
    chartRef.current = api;
    volRef.current = api.addSeries(HistogramSeries, { priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false });
    api.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    return () => { api.remove(); chartRef.current = null; priceRef.current = null; volRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)build the price series when the chart type changes.
  React.useEffect(() => {
    const api = chartRef.current;
    if (!api) return;
    if (priceRef.current) { api.removeSeries(priceRef.current); priceRef.current = null; }
    priceRef.current = mode === 'candles'
      ? api.addSeries(CandlestickSeries, {
        upColor: colors.up, downColor: colors.down,
        borderUpColor: colors.up, borderDownColor: colors.down,
        wickUpColor: colors.up, wickDownColor: colors.down,
      })
      : api.addSeries(LineSeries, { color: colors.line, lineWidth: 2 });
    api.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.22 } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Push data whenever the series, data or interval changes.
  React.useEffect(() => {
    const price = priceRef.current;
    const vol = volRef.current;
    if (!price || !vol) return;
    const candles = recentCandles(chart?.datas, intervalMinutes);
    price.setData(
      candles.map((c) => mode === 'candles'
        ? { time: (c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close }
        : { time: (c.time / 1000) as UTCTimestamp, value: c.close }) as never,
    );
    const maxVol = Math.max(...candles.map((c) => c.volume), 1);
    vol.setData(candles.map((c) => ({
      time: (c.time / 1000) as UTCTimestamp,
      value: c.volume,
      color: (c.close >= c.open ? colors.up : colors.down) + '80',
    })));
    vol.priceScale().applyOptions({ autoScale: true });
    void maxVol;
    if (candles.length > 0) price.priceScale().applyOptions({ autoScale: true });
  }, [chart, intervalMinutes, mode, colors.up, colors.down, colors.line]);

  return React.createElement('div', {
    ref: containerRef,
    'data-testid': testID,
    style: { width: '100%', height },
  });
}
