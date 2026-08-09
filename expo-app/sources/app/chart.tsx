import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Polyline, Rect, Line as SvgLine, Text as SvgText } from 'react-native-svg';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import type { MarketPrice } from '@/types/api';

interface ChartPoint {
  price: number;
  executedQuantity: number;
  time: number; // epoch ms
}

interface ChartData {
  tokenid: string;
  tokenname: string;
  datas: ChartPoint[];
}

// Interval options (minutes). Mirrors the chartdata HTML selectors.
const INTERVALS: { label: string; minutes: number }[] = [
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
  { label: '1m', minutes: 43200 },
];

const CHART_W = 360;
const CHART_H = 220;
const PAD = 8;

function buildPoints(chart: ChartData | null): { line: string; bars: React.ReactNode[]; maxY: number; minY: number } {
  if (!chart || chart.datas.length === 0) {
    return { line: '', bars: [], maxY: 0, minY: 0 };
  }
  const datas = [...chart.datas].sort((a, b) => a.time - b.time);
  const prices = datas.map((d) => d.price);
  const vols = datas.map((d) => d.executedQuantity);
  let maxY = Math.max(...prices, 0);
  let minY = Math.min(...prices, 0);
  if (maxY === minY) { maxY = minY + 1; }
  const maxVol = Math.max(...vols, 1);
  const span = maxY - minY;
  const step = (CHART_W - PAD * 2) / Math.max(datas.length - 1, 1);
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => PAD + (1 - (v - minY) / span) * (CHART_H - PAD * 2);

  const linePts = datas.map((d, i) => `${x(i).toFixed(1)},${y(d.price).toFixed(1)}`).join(' ');
  const bars = datas.map((d, i) => {
    const h = Math.max((d.executedQuantity / maxVol) * (CHART_H - PAD * 2), 1);
    return (
      <Rect
        key={i}
        x={x(i) - step / 4}
        y={CHART_H - PAD - h}
        width={Math.max(step / 2, 1)}
        height={h}
        fill={d.price >= (i > 0 ? datas[i - 1].price : d.price) ? '#10B981' : '#EF4444'}
        opacity={0.7}
      />
    );
  });
  return { line: linePts, bars, maxY, minY };
}

export default function ChartScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { isUnlocked, publicInfo } = useWallet();
  const { width } = useWindowDimensions();
  const chartW = Math.max(Math.min(width - 32, CHART_W), 280);

  const [tokenSearch, setTokenSearch] = React.useState('');
  const [tokenResults, setTokenResults] = React.useState<MarketPrice[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [selectedToken, setSelectedToken] = React.useState<{ tokenid: string; tokenname: string } | null>(null);
  const [interval, setInterval] = React.useState(1440);
  const [chart, setChart] = React.useState<ChartData | null>(null);
  const [loading, setLoading] = React.useState(false);

  const searchTokens = async (keyword: string) => {
    setTokenSearch(keyword);
    if (!keyword.trim()) { setTokenResults([]); return; }
    setSearching(true);
    try {
      const res = await httpService.searchExchangeTokens(keyword.trim());
      if (res.success && res.data) {
        setTokenResults(res.data.map((tk) => ({
          tokenid: tk.tokenid,
          tokenname: tk.tokenname || tk.tokenid?.slice(0, 8),
          price: '0', change: '0', executedquantity: '0',
        })));
      }
    } catch (e) { console.error('Error searching tokens:', e); }
    finally { setSearching(false); }
  };

  const selectToken = (tk: { tokenid: string; tokenname: string }) => {
    setSelectedToken(tk);
    setTokenSearch(tk.tokenname || tk.tokenid);
    setTokenResults([]);
  };

  const loadChart = async (tokenid: string, intervalMinutes: number) => {
    setLoading(true);
    try {
      const res = await httpService.getOrdersTickerSeries(tokenid, intervalMinutes, 'bc');
      if (res.success && res.data) {
        const resp = res.data as { tickers?: any[]; tokennames?: Record<string, { tokenname?: string }> };
        const tickers = resp.tickers || [];
        const tokennames = resp.tokennames || {};
        const datas = tickers
          .filter((tk: any) => tk.tokenid === tokenid)
          .map((tk: any) => ({
            price: Number(tk.price) || 0,
            executedQuantity: Number(tk.executedQuantity) || 0,
            time: Number(tk.inserttime) * 1000,
          }));
        setChart({
          tokenid,
          tokenname: tokennames[tokenid]?.tokenname || selectedToken?.tokenname || tokenid.slice(0, 8),
          datas,
        });
      }
    } catch (e) { console.error('Error loading chart:', e); }
    finally { setLoading(false); }
  };

  React.useEffect(() => {
    if (selectedToken) loadChart(selectedToken.tokenid, interval);
  }, [selectedToken, interval]);

  const { line, bars, maxY, minY } = buildPoints(chart);
  const baseToken = 'bc';

  return (
    <View style={s.container} testID="chart-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>Chart</Text>
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {/* Token selector */}
        <View style={s.card}>
          <Text style={s.cardLabel}>{t('chart.selectToken')}</Text>
          <TextInput style={s.input} value={tokenSearch} onChangeText={searchTokens}
            placeholder={t('chart.searchToken')} placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" autoCorrect={false} testID="chart-token-search" />
          {searching ? (
            <ActivityIndicator size="small" color={s.loader.color} style={{ marginTop: 8 }} />
          ) : tokenResults.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }} testID="chart-token-results">
              {tokenResults.map((tk, i) => (
                <TouchableOpacity key={i} style={[s.chip, selectedToken?.tokenid === tk.tokenid && s.chipActive]} onPress={() => selectToken(tk)} testID={`chart-token-${i}`}>
                  <Text style={s.chipText}>{tk.tokenname}</Text>
                  <Text style={s.chipSub}>{tk.tokenid.slice(0, 10)}...</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            selectedToken && <Text style={s.selectedText} testID="chart-selected-token">{selectedToken.tokenname} · {selectedToken.tokenid}</Text>
          )}
        </View>

        {/* Interval selector */}
        <View style={s.card}>
          <Text style={s.cardLabel}>{t('chart.interval')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }} testID="chart-intervals">
            {INTERVALS.map((iv, i) => (
              <TouchableOpacity key={i} style={[s.chip, interval === iv.minutes && s.chipActive]} onPress={() => setInterval(iv.minutes)} testID={`chart-interval-${iv.minutes}`}>
                <Text style={[s.chipText, interval === iv.minutes && s.chipTextActive]}>{iv.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Chart */}
        <View style={s.card}>
          <View style={s.chartHeader}>
            <Text style={s.chartTitle}>{chart?.tokenname || selectedToken?.tokenname || '—'} / {baseToken}</Text>
            {loading && <ActivityIndicator size="small" color={s.loader.color} />}
          </View>
          {!selectedToken ? (
            <View style={s.emptyCard}><Text style={s.emptyText}>{t('chart.selectFirst')}</Text></View>
          ) : chart && chart.datas.length === 0 ? (
            <View style={s.emptyCard}><Text style={s.emptyText}>{t('chart.noData')}</Text></View>
          ) : (
            <>
              <Svg width={chartW} height={CHART_H} testID="chart-price">
                {bars}
                {chart && chart.datas.length > 0 && (
                  <>
                    <SvgLine x1={PAD} y1={PAD} x2={PAD} y2={CHART_H - PAD} stroke="#666" strokeWidth={1} />
                    <SvgLine x1={PAD} y1={CHART_H - PAD} x2={chartW - PAD} y2={CHART_H - PAD} stroke="#666" strokeWidth={1} />
                    <SvgText x={PAD + 2} y={PAD + 10} fill="#999" fontSize={9}>{maxY.toFixed(4)}</SvgText>
                    <SvgText x={PAD + 2} y={CHART_H - PAD - 4} fill="#999" fontSize={9}>{minY.toFixed(4)}</SvgText>
                    <Polyline points={line} fill="none" stroke="#3B82F6" strokeWidth={2} />
                  </>
                )}
              </Svg>
              <Text style={s.axisLabel}>{t('chart.price')}</Text>
            </>
          )}
        </View>

        <View style={s.card}>
          <Text style={s.chartTitle}>{t('chart.volume')}</Text>
          {chart && chart.datas.length > 0 ? (
            <Svg width={chartW} height={140} testID="chart-volume">
              {bars}
            </Svg>
          ) : (
            <View style={s.emptyCard}><Text style={s.emptyText}>{t('chart.noData')}</Text></View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.primary, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  content: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12 },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 15 },
  placeholder: { color: theme.colors.text.secondary },
  loader: { color: theme.colors.primary },
  chip: { backgroundColor: theme.colors.groupped.background, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.colors.primary },
  chipTextActive: { color: '#FFFFFF' },
  chipSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 1 },
  selectedText: { fontSize: 13, color: theme.colors.text.primary, marginTop: 8 },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  chartTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  axisLabel: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 4, textAlign: 'center' },
  emptyCard: { alignItems: 'center', padding: 24 },
  emptyText: { fontSize: 13, color: theme.colors.text.secondary },
}));
