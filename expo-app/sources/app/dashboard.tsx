import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { listOrders, refreshAllStatuses } from '@/services/tracking';
import { statusBadgeColor } from '@/utils/status';
import { shortTokenId } from '@/lib/tokenformat';
import { MONO_FONT } from '@/constants/fonts';
import WalletUnlock from '@/components/WalletUnlock';
import type { OrderInfo, TrackedRecord, WalletAccountItem } from '@/types/api';

interface Ticker {
  tokenid?: string;
  price?: string;
  executedQuantity?: string;
  inserttime?: number;
}

/** Compact number for the value column: up to 6 decimals, thousands grouped. */
function fmtNumber(v: number): string {
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/**
 * Trade dashboard: the order-chain (L1) portfolio — total value in BC using
 * the last match price per token, holdings, open orders and the locally
 * tracked order activity. Mirrors the Binance "my dashboard" overview.
 */
export default function DashboardScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();
  const l1Url = React.useMemo(() => httpService.getL1Url(), []);

  const [trading, setTrading] = React.useState<WalletAccountItem[]>([]);
  const [layer0, setLayer0] = React.useState<WalletAccountItem[]>([]);
  const [prices, setPrices] = React.useState<Record<string, number>>({ bc: 1 });
  const [tokenNames, setTokenNames] = React.useState<Record<string, string>>({});
  const [openOrders, setOpenOrders] = React.useState<OrderInfo[]>([]);
  const [activity, setActivity] = React.useState<TrackedRecord[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [updatedAt, setUpdatedAt] = React.useState(0);

  const load = React.useCallback(async () => {
    if (!publicInfo?.address || !isUnlocked) return;
    const unlocked = getUnlockedWallet();
    if (!unlocked) return;
    setLoading(true);
    try {
      const pk = unlocked.wallet.privateKey;
      const kt = unlocked.wallet.keyType;
      const l1Base = httpService.l1Bases(l1Url)[0] ?? l1Url;
      const [l1Res, l0Res, tickerRes, ordersRes] = await Promise.all([
        httpService.getBalancesOn(l1Base, pk, kt).catch(() => null),
        httpService.getBalances(pk, kt).catch(() => null),
        httpService.getOrdersTicker([], 'bc').catch(() => null),
        httpService.getOrdersByAddress(publicInfo.address).catch(() => null),
      ]);
      setTrading(l1Res?.success && l1Res.data ? l1Res.data : []);
      setLayer0(l0Res?.success && l0Res.data ? l0Res.data : []);
      const tickers: Ticker[] = (tickerRes?.data?.tickers as Ticker[]) || [];
      const names: Record<string, string> = {};
      const map: Record<string, number> = { bc: 1 };
      for (const [id, meta] of Object.entries(
        (tickerRes?.data?.tokennames as Record<string, { tokenname?: string }>) || {},
      )) {
        if (meta?.tokenname) names[id] = meta.tokenname;
      }
      for (const tk of tickers) {
        if (!tk.tokenid) continue;
        const p = Number(tk.price);
        if (p > 0) map[tk.tokenid] = p;
      }
      setPrices(map);
      setTokenNames(names);
      setOpenOrders(ordersRes?.success && ordersRes.data ? ordersRes.data : []);
      await refreshAllStatuses(publicInfo.address, l1Url).catch(() => {});
      setActivity(listOrders().slice(0, 5));
      setUpdatedAt(Date.now());
    } finally {
      setLoading(false);
    }
  }, [publicInfo?.address, isUnlocked, getUnlockedWallet, l1Url]);

  React.useEffect(() => { load(); }, [load]);

  const priceOf = React.useCallback(
    (tokenid: string): number | undefined => (tokenid === 'bc' ? 1 : prices[tokenid]),
    [prices],
  );
  const valueOf = (b: WalletAccountItem): number => {
    const amount = Number(b.balance) || 0;
    return amount * (priceOf(b.tokenid) ?? 0);
  };
  const nameOf = (tokenid: string): string =>
    tokenNames[tokenid] || trading.find((b) => b.tokenid === tokenid)?.tokenname
    || (tokenid === 'bc' ? 'BIG' : shortTokenId(tokenid));

  const holdings = trading
    .filter((b) => Number(b.balance) > 0)
    .sort((a, b) => valueOf(b) - valueOf(a));
  const totalValue = holdings.reduce((sum, b) => sum + valueOf(b), 0);
  const bcTrading = holdings.find((b) => b.tokenid === 'bc');
  const bcLayer0 = layer0.find((b) => b.tokenid === 'bc');
  const updated = updatedAt
    ? new Date(updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '—';

  return (
    <View style={s.container} testID="dashboard-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('dashboard.title')}</Text>
        {loading && <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginLeft: 'auto' }} />}
      </View>

      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={theme.colors.primary} />}
      >
        {!isUnlocked ? (
          <WalletUnlock fullScreen={false} testID="dashboard-unlock" />
        ) : (
          <>
            {/* Total value */}
            <View style={s.card}>
              <Text style={s.cardLabel}>{t('dashboard.totalValue')}</Text>
              <Text style={s.totalValue} testID="dashboard-total">{fmtNumber(totalValue)} <Text style={s.totalUnit}>bc</Text></Text>
              <View style={s.subRow}>
                <Text style={s.subLabel}>{t('dashboard.tradingAccount')}</Text>
                <Text style={s.subValue} testID="dashboard-trading-bc">{fmtNumber(Number(bcTrading?.balance ?? 0))} bc</Text>
              </View>
              <View style={s.subRow}>
                <Text style={s.subLabel}>{t('dashboard.layer0')}</Text>
                <Text style={s.subValue}>{fmtNumber(Number(bcLayer0?.balance ?? 0))} bc</Text>
              </View>
              {updatedAt > 0 && (
                <Text style={s.updated}>{t('dashboard.updated')} {updated}</Text>
              )}
            </View>

            {/* Holdings */}
            <View style={s.card}>
              <Text style={s.cardLabel}>{t('dashboard.holdings')}</Text>
              {holdings.length === 0 ? (
                <Text style={s.emptyText}>{t('dashboard.noHoldings')}</Text>
              ) : (
                <>
                  <View style={s.tableHead}>
                    <Text style={[s.colToken, s.th]}>{t('receive.tokenId')}</Text>
                    <Text style={[s.colNum, s.th]}>{t('dashboard.balance')}</Text>
                    <Text style={[s.colNum, s.th]}>{t('dashboard.price')}</Text>
                    <Text style={[s.colNum, s.th]}>{t('dashboard.value')}</Text>
                  </View>
                  {holdings.map((b) => (
                    <View key={b.tokenid} style={s.row} testID={`dashboard-holding-${b.tokenid === 'bc' ? 'bc' : shortTokenId(b.tokenid)}`}>
                      <View style={s.colToken}>
                        <Text style={s.rowTitle} numberOfLines={1}>{b.tokenname || nameOf(b.tokenid)}</Text>
                        {b.tokenid !== 'bc' && <Text style={s.rowSub}>{shortTokenId(b.tokenid)}</Text>}
                      </View>
                      <Text style={[s.colNum, s.mono]}>{fmtNumber(Number(b.balance))}</Text>
                      <Text style={[s.colNum, s.mono]}>{priceOf(b.tokenid) ? fmtNumber(priceOf(b.tokenid)!) : '—'}</Text>
                      <Text style={[s.colNum, s.mono, s.valueText]}>{b.tokenid === 'bc' ? '—' : fmtNumber(valueOf(b))}</Text>
                    </View>
                  ))}
                </>
              )}
            </View>

            {/* Open orders */}
            <View style={s.card}>
              <Text style={s.cardLabel}>{t('dashboard.openOrders')} ({openOrders.length})</Text>
              {openOrders.length === 0 ? (
                <Text style={s.emptyText}>{t('dashboard.noOrders')}</Text>
              ) : (
                openOrders.slice(0, 8).map((o, i) => {
                  const sell = (o.side || '').toUpperCase() === 'SELL';
                  const tokenid = sell ? o.offerTokenid : o.targetTokenid;
                  const amount = sell ? o.offerValue : o.targetValue;
                  return (
                    <View key={i} style={s.row}>
                      <View style={s.colToken}>
                        <View style={[s.sideBadge, { backgroundColor: sell ? theme.colors.accent.red : theme.colors.accent.emerald }]}>
                          <Text style={s.sideBadgeText}>{sell ? t('order.sell') : t('order.buy')}</Text>
                        </View>
                        <Text style={s.rowTitle} numberOfLines={1}>{nameOf(tokenid)}</Text>
                      </View>
                      <Text style={[s.colNum, s.mono]}>{fmtNumber(amount)}</Text>
                      <Text style={[s.colNum, s.mono]}>{o.price ? fmtNumber(o.price) : '—'}</Text>
                    </View>
                  );
                })
              )}
            </View>

            {/* Recent activity (locally tracked orders) */}
            <View style={s.card}>
              <Text style={s.cardLabel}>{t('dashboard.recentActivity')}</Text>
              {activity.length === 0 ? (
                <Text style={s.emptyText}>{t('dashboard.noActivity')}</Text>
              ) : (
                activity.map((r) => (
                  <View key={r.id} style={s.row}>
                    <View style={s.colToken}>
                      <Text style={s.rowTitle} numberOfLines={1}>{r.tokenName || nameOf(r.tokenId)}</Text>
                      <Text style={s.rowSub}>
                        {(r.side ? `${r.side.toUpperCase()} · ` : '') + (r.amount || '') + (r.price ? ` @ ${r.price}` : '')}
                      </Text>
                    </View>
                    <View style={[s.statusBadge, { backgroundColor: statusBadgeColor(r.status, theme) }]}>
                      <Text style={s.statusText}>{r.status}</Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
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
  totalValue: { fontSize: 30, fontWeight: '800', color: theme.colors.text.primary },
  totalUnit: { fontSize: 16, fontWeight: '600', color: theme.colors.text.secondary },
  subRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  subLabel: { fontSize: 13, color: theme.colors.text.secondary },
  subValue: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, fontFamily: MONO_FONT },
  updated: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 10, textAlign: 'right' },
  emptyCard: { alignItems: 'center', padding: 24, backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border },
  emptyText: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 19 },
  tableHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  th: { fontSize: 10, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  colToken: { flex: 1.8, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  colNum: { flex: 1, textAlign: 'right', fontSize: 12, color: theme.colors.text.primary },
  mono: { fontFamily: MONO_FONT },
  valueText: { fontWeight: '700' },
  rowTitle: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, flexShrink: 1 },
  rowSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 1 },
  sideBadge: { borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  sideBadgeText: { fontSize: 10, fontWeight: '800', color: '#FFFFFF' },
  statusBadge: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF', textTransform: 'uppercase' },
}));
