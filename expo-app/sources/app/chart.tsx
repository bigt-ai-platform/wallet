import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Modal, useWindowDimensions,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { PriceChart, VolumeChart, INTERVALS, formatAxisDate, type ChartData } from '@/components/MarketChart';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { ChevronDownIcon, CopyIcon } from '@/components/Icons';
import { shortTokenId } from '@/lib/tokenformat';
import type { MarketPrice } from '@/types/api';

const CHART_H = 220;

export default function ChartScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { isUnlocked, publicInfo } = useWallet();
  const { width } = useWindowDimensions();
  const chartW = Math.max(Math.min(width - 32, 760), 280);

  const [tokenSearch, setTokenSearch] = React.useState('');
  const [tokenResults, setTokenResults] = React.useState<MarketPrice[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [selectedToken, setSelectedToken] = React.useState<{ tokenid: string; tokenname: string } | null>(null);
  const [interval, setInterval] = React.useState(1440);
  const [intervalOpen, setIntervalOpen] = React.useState(false);
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

  // Preselect the yuan token when it exists, so the chart is not empty on
  // first open. A token the user picks later simply replaces it.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await httpService.searchExchangeTokens('yuan');
        if (cancelled || !res.success || !res.data || res.data.length === 0) return;
        const yuan = res.data.find((tk: any) => (tk.tokenname || '').trim().toLowerCase() === 'yuan')
          || res.data[0];
        selectToken({ tokenid: yuan.tokenid, tokenname: yuan.tokenname || yuan.tokenid?.slice(0, 8) || 'yuan' });
      } catch { /* no default token available */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const VOL_H = 140;
  const baseToken = 'bc';
  const sortedTimes = chart?.datas?.length ? [...chart.datas].sort((a, b) => a.time - b.time) : [];
  const firstTime = sortedTimes[0]?.time ?? 0;
  const lastTime = sortedTimes[sortedTimes.length - 1]?.time ?? 0;
  const withTime = lastTime - firstTime <= 2 * 24 * 60 * 60 * 1000;
  const currentInterval = INTERVALS.find((iv) => iv.minutes === interval) ?? INTERVALS[0];

  return (
    <View style={s.container} testID="chart-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('chart.title')}</Text>
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
            selectedToken && (
              <View style={s.selectedRow}>
                <Text style={s.selectedText} testID="chart-selected-token" numberOfLines={1}>
                  {selectedToken.tokenname} · {shortTokenId(selectedToken.tokenid)}
                </Text>
                <TouchableOpacity
                  style={s.copyBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('receive.copy')}
                  testID="chart-token-copy"
                  onPress={() => { Clipboard.setStringAsync(selectedToken.tokenid).catch(() => {}); }}
                >
                  <CopyIcon size={14} color={theme.colors.text.link} />
                </TouchableOpacity>
              </View>
            )
          )}
        </View>

        {/* Interval selector: a select list, like the language switcher */}
        <View style={s.card}>
          <Text style={s.cardLabel}>{t('chart.interval')}</Text>
          <TouchableOpacity
            style={s.selectTrigger}
            onPress={() => setIntervalOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('chart.interval')}
            testID="chart-interval-select"
          >
            <Text style={s.selectValue}>{currentInterval.label}</Text>
            <ChevronDownIcon size={16} color={theme.colors.text.secondary} />
          </TouchableOpacity>
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
              <PriceChart
                chart={chart}
                width={chartW}
                height={CHART_H}
                lineColor={theme.colors.accent.blue}
                dividerColor={theme.colors.divider}
                textColor={theme.colors.text.secondary}
                posColor={theme.colors.positive}
                negColor={theme.colors.negative}
                testID="chart-price"
              />
              <View style={s.dateRow}>
                <Text style={s.dateLabel}>{firstTime ? formatAxisDate(firstTime, withTime) : ''}</Text>
                <Text style={s.dateLabel}>{lastTime ? formatAxisDate(lastTime, withTime) : ''}</Text>
              </View>
              <Text style={s.axisLabel}>{t('chart.price')}</Text>
            </>
          )}
        </View>

        <View style={s.card}>
          <Text style={s.chartTitle}>{t('chart.volume')}</Text>
          {chart && chart.datas.length > 0 ? (
            <>
              <VolumeChart
                chart={chart}
                width={chartW}
                height={VOL_H}
                textColor={theme.colors.text.secondary}
                posColor={theme.colors.positive}
                negColor={theme.colors.negative}
                testID="chart-volume"
              />
              <View style={s.dateRow}>
                <Text style={s.dateLabel}>{firstTime ? formatAxisDate(firstTime, withTime) : ''}</Text>
                <Text style={s.dateLabel}>{lastTime ? formatAxisDate(lastTime, withTime) : ''}</Text>
              </View>
            </>
          ) : (
            <View style={s.emptyCard}><Text style={s.emptyText}>{t('chart.noData')}</Text></View>
          )}
        </View>
      </ScrollView>

      <Modal visible={intervalOpen} transparent animationType="fade" onRequestClose={() => setIntervalOpen(false)}>
        <TouchableOpacity style={s.overlay} activeOpacity={1} onPress={() => setIntervalOpen(false)}>
          <View style={s.dialog} testID="chart-interval-options">
            <Text style={s.dialogTitle}>{t('chart.interval')}</Text>
            <ScrollView>
              {INTERVALS.map((iv) => (
                <TouchableOpacity
                  key={iv.minutes}
                  onPress={() => { setInterval(iv.minutes); setIntervalOpen(false); }}
                  style={[s.option, interval === iv.minutes && s.optionActive]}
                  accessibilityRole="button"
                  testID={`chart-interval-${iv.minutes}`}
                >
                  <Text style={[s.optionText, interval === iv.minutes && s.optionTextActive]}>{iv.label}</Text>
                  {interval === iv.minutes && <Text style={s.checkmark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  content: { padding: 16, paddingBottom: 40 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12 },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 15 },
  placeholder: { color: theme.colors.text.secondary },
  loader: { color: theme.colors.primary },
  chip: { backgroundColor: theme.colors.groupped.background, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  chipTextActive: { color: '#FFFFFF' },
  chipSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 1 },
  selectedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  selectedText: { flexShrink: 1, fontSize: 13, color: theme.colors.text.primary },
  copyBtn: { padding: 4 },
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  chartTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  axisLabel: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 4, textAlign: 'center' },
  dateRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  dateLabel: { fontSize: 10, color: theme.colors.text.secondary },
  selectTrigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, paddingHorizontal: 12, paddingVertical: 10 },
  selectValue: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  dialog: { backgroundColor: theme.colors.groupped.surface, borderRadius: 16, width: 260, maxWidth: '90%', maxHeight: '70%', paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  dialogTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, paddingHorizontal: 14, paddingVertical: 8 },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 12 },
  optionActive: { backgroundColor: theme.colors.groupped.background },
  optionText: { fontSize: 15, color: theme.colors.text.primary },
  optionTextActive: { fontWeight: '700', color: theme.colors.primary },
  checkmark: { fontSize: 14, color: theme.colors.primary, fontWeight: '700' },
  emptyCard: { alignItems: 'center', padding: 24 },
  emptyText: { fontSize: 13, color: theme.colors.text.secondary },
}));
