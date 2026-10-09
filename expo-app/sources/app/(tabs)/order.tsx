import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { cancelOrderOnLayer1 } from '@/services/transaction';
import { listOrders, refreshAllStatuses } from '@/services/tracking';
import ChainBadge from '@/components/ChainBadge';
import { statusBadgeColor } from '@/utils/status';
import type { OrderInfo, TrackedRecord, TrackedStatus } from '@/types/api';

// Multi-select status filter over the user's own orders.
const STATUS_OPTIONS: TrackedStatus[] = ['pending', 'confirmed', 'cancelled', 'failed'];

export default function OrderScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();
  // The active L1 chain is the app-wide single source of truth; re-render on
  // change so orders always come from the chain selected in Send/Settings.
  const [l1Url, setL1Url] = React.useState(() => httpService.getL1Url());
  const [activeChainName, setActiveChainName] = React.useState(() => httpService.getActiveL1Chain()?.name ?? '');
  React.useEffect(() => httpService.subscribeL1Change(() => {
    setL1Url(httpService.getL1Url());
    setActiveChainName(httpService.getActiveL1Chain()?.name ?? '');
  }), []);

  const [liveOrders, setLiveOrders] = React.useState<OrderInfo[]>([]);
  const [trackedOrders, setTrackedOrders] = React.useState<TrackedRecord[]>([]);
  const [loadingOrders, setLoadingOrders] = React.useState(false);
  const [refreshingOrders, setRefreshingOrders] = React.useState(false);
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);
  const [historyFromDate, setHistoryFromDate] = React.useState('');
  const [historyToDate, setHistoryToDate] = React.useState('');
  // Multi-select status filter: an empty selection shows every status.
  const [statusFilter, setStatusFilter] = React.useState<TrackedStatus[]>([]);

  const toggleStatus = (st: TrackedStatus) => {
    setStatusFilter((prev) => (prev.includes(st) ? prev.filter((x) => x !== st) : [...prev, st]));
  };
  const statusAllowed = (st: TrackedStatus) => statusFilter.length === 0 || statusFilter.includes(st);

  const loadMyOrders = async (isRefresh = false) => {
    if (!publicInfo?.address) return;
    if (isRefresh) setRefreshingOrders(true); else setLoadingOrders(true);
    try {
      if (isRefresh) {
        await refreshAllStatuses(publicInfo.address, l1Url);
      }
      setTrackedOrders(listOrders());
      const res = await httpService.getOrdersByAddress(publicInfo.address);
      if (res.success && res.data) setLiveOrders(res.data);
    } catch (e) { console.error('Error loading orders:', e); }
    finally { setLoadingOrders(false); setRefreshingOrders(false); }
  };

  React.useEffect(() => { loadMyOrders(); }, [publicInfo?.address]);

  const cancelLiveOrder = async (o: OrderInfo) => {
    if (!publicInfo?.address) return;
    if (!isUnlocked) { Alert.alert('', t('order.unlockFirst')); return; }
    const wallet = getUnlockedWallet();
    if (!wallet) { Alert.alert('', t('order.unlockFirst')); return; }
    if (!l1Url) { Alert.alert('', t('order.noL1')); return; }
    const orderId = o.blockHashHex || '';
    if (!orderId) { Alert.alert('', t('order.cancelFailed')); return; }
    Alert.alert(t('order.cancel'), t('order.cancelConfirm'), [
      { text: t('order.cancelNo'), style: 'cancel' },
      {
        text: t('order.cancelYes'),
        style: 'destructive',
        onPress: async () => {
          setCancellingId(orderId);
          try {
            await cancelOrderOnLayer1({
              privateKeyHex: wallet.wallet.privateKey,
              keyType: wallet.wallet.keyType,
              l1Url: httpService.l1Bases(l1Url)[0] ?? l1Url,
              initialBlockHashHex: orderId,
              address: publicInfo.address,
            });
            Alert.alert('', t('order.cancelDone'));
          } catch (e) {
            console.error('Error cancelling order:', e);
            Alert.alert('', t('order.cancelFailed'));
          } finally {
            setCancellingId(null);
            await loadMyOrders();
          }
        },
      },
    ]);
  };

  const fromMs = historyFromDate ? Date.parse(historyFromDate) : NaN;
  const toMs = historyToDate ? Date.parse(historyToDate) : NaN;
  const inRange = (r: { createdAt: number }) =>
    (Number.isNaN(fromMs) || r.createdAt >= fromMs) &&
    (Number.isNaN(toMs) || r.createdAt <= toMs + 24 * 3600 * 1000);
  const inRangeLive = (o: OrderInfo) => {
    const t0 = o.validFromTime ? o.validFromTime * 1000 : NaN;
    const t1 = o.validToTime ? o.validToTime * 1000 : NaN;
    return (Number.isNaN(fromMs) || Number.isNaN(t0) || t0 >= fromMs) &&
      (Number.isNaN(toMs) || Number.isNaN(t1) || t1 <= toMs + 24 * 3600 * 1000);
  };
  const tracked = trackedOrders.filter(inRange).filter((o) => statusAllowed(o.status));
  const live = liveOrders.filter(inRangeLive).filter(
    (o) => statusAllowed(o.cancelPending ? 'cancelled' : 'pending'),
  );

  return (
    <View style={s.container} testID="order-screen">
      <ScrollView style={s.scroll} contentContainerStyle={s.content} testID="my-orders-tab"
        refreshControl={<RefreshControl refreshing={refreshingOrders} onRefresh={() => loadMyOrders(true)} />}>
        <View style={s.sectionRow}>
          <Text style={s.sectionTitle}>{t('order.yourOrders')}</Text>
          <TouchableOpacity onPress={() => loadMyOrders(true)} disabled={refreshingOrders}>
            <Text style={s.refreshBtn}>{refreshingOrders ? '...' : t('order.refresh')}</Text>
          </TouchableOpacity>
        </View>

        {/* Status (multi-select) + date range filters over the user's orders. */}
        <View style={s.filterCard}>
          <Text style={s.filterLabel}>{t('order.filterStatus')}</Text>
          <View style={s.chipRow}>
            {STATUS_OPTIONS.map((st) => {
              const active = statusFilter.includes(st);
              return (
                <TouchableOpacity key={st} style={[s.filterChip, active && s.filterChipActive]}
                  onPress={() => toggleStatus(st)} testID={`order-status-filter-${st}`}>
                  <Text style={[s.filterChipText, active && s.filterChipTextActive]}>{t(`order.status.${st}`)}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <Text style={[s.filterLabel, s.filterLabelGap]}>{t('order.dateRange')}</Text>
          <View style={s.dateRow}>
            <TextInput style={s.dateInput} value={historyFromDate} onChangeText={setHistoryFromDate}
              placeholder={t('balance.fromPh')} placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" testID="order-from-date" />
            <TextInput style={s.dateInput} value={historyToDate} onChangeText={setHistoryToDate}
              placeholder={t('balance.toPh')} placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" testID="order-to-date" />
          </View>
        </View>

        {loadingOrders ? (
          <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 24 }} />
        ) : (
          <>
            {tracked.length > 0 && (
              <>
                <Text style={s.groupLabel}>{t('order.trackedGroup')}</Text>
                {tracked.map((o) => {
                  const badgeColor = statusBadgeColor(o.status, theme);
                  return (
                    <View key={o.id} style={s.orderCard}>
                      <Text style={[s.orderSide, { color: o.side === 'buy' ? s.pos.color : s.neg.color }]}>
                        {o.side === 'buy' ? t('order.buy') : t('order.sell')}
                      </Text>
                      <View style={s.orderInfoCol}>
                        <Text style={s.orderInfo}>{o.amount} {o.tokenName} @ {o.price}</Text>
                        <Text style={s.orderSub}>{o.statusDetail || o.status}{o.createdAt ? ` · ${new Date(o.createdAt).toISOString().slice(0, 10)}` : ''}</Text>
                      </View>
                      <View style={[s.statusBadge, { backgroundColor: badgeColor }]}>
                        <Text style={s.statusBadgeText} testID="order-status">{o.status}</Text>
                      </View>
                    </View>
                  );
                })}
              </>
            )}
            <View style={s.liveChainRow}>
              <Text style={s.groupLabel}>{t('order.liveGroup')}</Text>
              <ChainBadge layer={1} name={activeChainName} />
            </View>
            {live.length === 0 ? (
              <View style={s.emptyCard}><Text style={s.emptySub}>{t('order.noOpenOrders')}</Text></View>
            ) : (
              live.map((o, i) => (
                <View key={i} style={s.orderCard} testID="live-order">
                  <Text style={[s.orderSide, { color: (o.side || '').toUpperCase() === 'BUY' ? s.pos.color : s.neg.color }]}>{o.side}</Text>
                  <View style={s.orderInfoCol}>
                    <Text style={s.orderInfo}>{o.offerValue} {o.offerTokenid?.slice(0, 8)} @ {o.price} ({o.targetTokenid?.slice(0, 8)})</Text>
                    <Text style={s.orderSub}>{o.cancelPending ? 'CANCELLED' : 'OPEN'}</Text>
                  </View>
                  <View style={[s.statusBadge, { backgroundColor: statusBadgeColor(o.cancelPending ? 'cancelled' : 'pending', theme) }]}>
                    <Text style={s.statusBadgeText} testID="live-order-status">{o.cancelPending ? 'cancelled' : 'pending'}</Text>
                  </View>
                  {!o.cancelPending && o.blockHashHex ? (
                    <TouchableOpacity
                      style={[s.cancelBtn, cancellingId === o.blockHashHex && { opacity: 0.5 }]}
                      onPress={() => cancelLiveOrder(o)}
                      disabled={cancellingId === o.blockHashHex}
                      accessibilityRole="button"
                      testID={`live-order-cancel-${i}`}
                    >
                      <Text style={s.cancelBtnText}>
                        {cancellingId === o.blockHashHex ? '...' : t('order.cancel')}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  loader: { color: theme.colors.primary },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 12 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  refreshBtn: { fontSize: 14, color: theme.colors.text.link, fontWeight: '600' },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 32, alignItems: 'center', marginTop: 20, borderWidth: 1, borderColor: theme.colors.border },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center' },
  orderCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 8, padding: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  orderSide: { fontSize: 13, fontWeight: '700', width: 40 },
  pos: { color: theme.colors.positive },
  neg: { color: theme.colors.negative },
  orderInfo: { fontSize: 13, color: theme.colors.text.primary },
  orderInfoCol: { flex: 1 },
  orderSub: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 2 },
  groupLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  liveChainRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 4 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignItems: 'center', marginLeft: 8 },
  statusBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  cancelBtn: { borderWidth: 1, borderColor: theme.colors.accent.red, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, marginLeft: 8 },
  cancelBtnText: { color: theme.colors.accent.red, fontSize: 12, fontWeight: '600' },
  filterCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 12, marginBottom: 12 },
  filterLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  filterLabelGap: { marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  filterChip: { backgroundColor: theme.colors.groupped.background, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  filterChipActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  filterChipText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary },
  filterChipTextActive: { color: theme.colors.primary },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateInput: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
}));
