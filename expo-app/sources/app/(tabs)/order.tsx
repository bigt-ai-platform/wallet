import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl, Modal, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { orderOnLayer1 } from '@/services/transaction';
import { listOrders, recordOrder, refreshAllStatuses } from '@/services/tracking';
import { CloseIcon } from '@/components/Icons';
import SegmentedTabs from '@/components/SegmentedTabs';
import { statusBadgeColor } from '@/utils/status';
import { MONO_FONT } from '@/constants/fonts';
import type { MarketPrice, OrderInfo, TrackedRecord } from '@/types/api';

export default function OrderScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();
  const [prices, setPrices] = React.useState<MarketPrice[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const [orderModal, setOrderModal] = React.useState(false);
  const [orderSide, setOrderSide] = React.useState<'buy' | 'sell'>('buy');
  const [selectedToken, setSelectedToken] = React.useState<MarketPrice | null>(null);
  const [tokenSearch, setTokenSearch] = React.useState('');
  const [tokenResults, setTokenResults] = React.useState<MarketPrice[]>([]);
  const [searchingTokens, setSearchingTokens] = React.useState(false);
  const [orderPrice, setOrderPrice] = React.useState('');
  const [orderAmount, setOrderAmount] = React.useState('');
  const [orderTotal, setOrderTotal] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'prices' | 'orders'>('prices');
  const [historyFromDate, setHistoryFromDate] = React.useState('');
  const [historyToDate, setHistoryToDate] = React.useState('');
  const l1Url = React.useMemo(() => httpService.getL1Url(), []);
  const { view } = useLocalSearchParams<{ view?: string }>();
  const router = useRouter();

  const switchTab = (tab: 'prices' | 'orders') => {
    setActiveTab(tab);
    // Keep the sidebar highlight in sync by writing the tab into the URL
    // params (sidebar items key off the `view` param). The Prices tab maps to
    // the exchange view — there is no dedicated sidebar item for "prices".
    router.setParams({ view: tab === 'orders' ? 'orders' : 'exchange' });
  };

  React.useEffect(() => {
    if (view === 'orders') setActiveTab('orders');
    else if (view) setActiveTab('prices');
  }, [view]);
  const [liveOrders, setLiveOrders] = React.useState<OrderInfo[]>([]);
  const [trackedOrders, setTrackedOrders] = React.useState<TrackedRecord[]>([]);
  const [loadingOrders, setLoadingOrders] = React.useState(false);
  const [refreshingOrders, setRefreshingOrders] = React.useState(false);

  React.useEffect(() => { loadPrices(); }, []);

  const loadPrices = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await httpService.getMarketPrices();
      if (res.success && res.data) setPrices(res.data);
    } catch (e) { console.error('Error loading prices:', e); }
    finally { setLoading(false); setRefreshing(false); }
  };

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

  React.useEffect(() => {
    if (activeTab === 'orders') loadMyOrders();
  }, [activeTab]);

  const openOrder = (side: 'buy' | 'sell', token: MarketPrice) => {
    if (!isUnlocked) { Alert.alert(t('wallet.locked'), t('order.unlockFirst')); return; }
    setOrderSide(side);
    setSelectedToken(token);
    setTokenSearch(token.tokenname || token.tokenid || '');
    setTokenResults([token]);
    setOrderPrice(token.price || '0');
    setOrderAmount('');
    setOrderTotal('');
    setOrderModal(true);
  };

  // Search tokens by name or id from the L1 exchange token list.
  const searchTokens = async (keyword: string) => {
    setTokenSearch(keyword);
    if (!keyword.trim()) { setTokenResults([]); return; }
    setSearchingTokens(true);
    try {
      const res = await httpService.searchExchangeTokens(keyword.trim());
      if (res.success && res.data) {
        const items: MarketPrice[] = res.data.map((tk) => ({
          tokenid: tk.tokenid,
          tokenname: tk.tokenname || tk.tokenid?.slice(0, 8),
          price: '0',
          change: '0',
          executedquantity: '0',
          decimals: tk.decimals ?? 8,
        }));
        setTokenResults(items);
      }
    } catch (e) { console.error('Error searching tokens:', e); }
    finally { setSearchingTokens(false); }
  };

  const selectSearchedToken = (tk: MarketPrice) => {
    setSelectedToken(tk);
    setTokenSearch(tk.tokenname || tk.tokenid || '');
    setTokenResults([]);
    setOrderPrice(tk.price && tk.price !== '0' ? tk.price : orderPrice);
  };

  const calcTotal = (price: string, amount: string) => {
    const p = parseFloat(price) || 0;
    const a = parseFloat(amount) || 0;
    setOrderTotal((p * a).toFixed(6));
  };

  const submitOrder = async () => {
    if (!selectedToken || !publicInfo?.address) return;
    const price = parseFloat(orderPrice);
    const amount = parseFloat(orderAmount);
    if (!price || price <= 0) { Alert.alert('', t('order.invalidPrice')); return; }
    if (!amount || amount <= 0) { Alert.alert('', t('order.invalidAmount')); return; }

    const wallet = getUnlockedWallet();
    if (!wallet) { Alert.alert('', t('order.unlockFirst')); return; }
    if (!l1Url) { Alert.alert('', 'No L1 chain configured'); return; }

    setSubmitting(true);
    try {
      const decimals = selectedToken.decimals ?? 8;
      const txHash = await orderOnLayer1({
        side: orderSide,
        privateKeyHex: wallet.wallet.privateKey,
        l1Url,
        tokenId: selectedToken.tokenid,
        price: BigInt(Math.floor(price * Math.pow(10, decimals))),
        amount: BigInt(Math.floor(amount * Math.pow(10, decimals))),
        baseToken: 'bc',
        decimals,
      });
      recordOrder({
        side: orderSide,
        tokenId: selectedToken.tokenid,
        tokenName: selectedToken.tokenname,
        baseToken: 'bc',
        price: orderPrice,
        amount: orderAmount,
        decimals,
        fromAddress: publicInfo.address,
        txHash,
      });
      setTrackedOrders(listOrders());
      Alert.alert(t('order.orderPlaced'), t('order.orderPlacedDesc', { side: orderSide === 'buy' ? t('order.buy') : t('order.sell'), amount, token: selectedToken.tokenname, price }));
      setOrderModal(false);
    } catch (e: any) {
      Alert.alert('', e.message || t('order.submitFailed'));
    } finally { setSubmitting(false); }
  };

  const fmtChange = (c: string) => { const n = parseFloat(c); return isNaN(n) ? '0%' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; };
  const changeColor = (c: string) => { const n = parseFloat(c); return isNaN(n) || n === 0 ? s.neutral.color : n > 0 ? s.pos.color : s.neg.color; };

  return (
    <View style={s.container} testID="order-screen">
      <SegmentedTabs
        tabs={[
          { key: 'prices', label: t('order.title') },
          { key: 'orders', label: t('order.myOrders') },
        ]}
        active={activeTab}
        onChange={(k) => switchTab(k as 'prices' | 'orders')}
      />

      {activeTab === 'prices' ? (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadPrices(true)} />}>
          {view === 'market' && (
            <View style={s.marketSummary}>
              <Text style={s.summaryTitle}>{t('order.marketData')}</Text>
              <View style={s.summaryRow}>
                <View style={s.summaryItem}>
                  <Text style={s.summaryValue}>{prices.length}</Text>
                  <Text style={s.summaryLabel}>{t('order.totalTokens')}</Text>
                </View>
                <View style={s.summaryItem}>
                  <Text style={s.summaryValue}>
                    {prices.filter((p) => parseFloat(p.change) > 0).length}
                  </Text>
                  <Text style={s.summaryLabel}>{t('order.gainers')}</Text>
                </View>
                <View style={s.summaryItem}>
                  <Text style={s.summaryValue}>
                    {prices.filter((p) => parseFloat(p.change) < 0).length}
                  </Text>
                  <Text style={s.summaryLabel}>{t('order.losers')}</Text>
                </View>
              </View>
            </View>
          )}
          {loading ? (
            <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 32 }} />
          ) : prices.length === 0 ? (
            <View style={s.emptyCard}><Text style={s.emptyTitle}>{t('order.noData')}</Text></View>
          ) : (
            prices.map((item, i) => {
              const change = parseFloat(item.change);
              const isUp = change >= 0;
              const barWidth = Math.min(Math.abs(change), 12) * 5;
              return (
                <View key={i} style={s.priceCard}>
                  <TouchableOpacity style={s.priceLeft} onPress={() => openOrder('buy', item)}>
                    <Text style={s.tokenName}>{item.tokenname}</Text>
                    <Text style={s.tokenId} numberOfLines={1} ellipsizeMode="middle">{item.tokenid}</Text>
                  </TouchableOpacity>
                  <View style={s.priceCenter}>
                    <Text style={s.price}>{item.price}</Text>
                    <Text style={[s.change, { color: changeColor(item.change) }]}>{fmtChange(item.change)}</Text>
                  </View>
                  {view === 'chart' ? (
                    <View style={s.chartCol}>
                      <View style={[s.changeBar, { width: barWidth, backgroundColor: isUp ? s.pos.color : s.neg.color }]} />
                    </View>
                  ) : (
                    <View style={s.actionCol}>
                      <TouchableOpacity style={s.buyBtn} onPress={() => openOrder('buy', item)}>
                        <Text style={s.buyBtnText}>{t('order.buy')}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={s.sellBtn} onPress={() => openOrder('sell', item)}>
                        <Text style={s.sellBtnText}>{t('order.sell')}</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })
          )}
        </ScrollView>
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.content} testID="my-orders-tab">
          <View style={s.sectionRow}>
            <Text style={s.sectionTitle}>{t('order.yourOrders')}</Text>
            <TouchableOpacity onPress={() => loadMyOrders(true)} disabled={refreshingOrders}>
              <Text style={s.refreshBtn}>{refreshingOrders ? '...' : 'Refresh'}</Text>
            </TouchableOpacity>
          </View>

          {/* Date range filter (from / to) applied to tracked order history. */}
          <View style={s.filterCard}>
            <Text style={s.filterLabel}>{t('order.dateRange')}</Text>
            <View style={s.dateRow}>
              <TextInput style={s.dateInput} value={historyFromDate} onChangeText={setHistoryFromDate}
                placeholder="from e.g. 2024-01-01" placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" testID="order-from-date" />
              <TextInput style={s.dateInput} value={historyToDate} onChangeText={setHistoryToDate}
                placeholder="to e.g. 2026-01-01" placeholderTextColor={s.placeholder.color}
                autoCapitalize="none" testID="order-to-date" />
            </View>
          </View>

          {loadingOrders ? (
            <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 24 }} />
          ) : (
            <>
              {(() => {
                const fromMs = historyFromDate ? Date.parse(historyFromDate) : NaN;
                const toMs = historyToDate ? Date.parse(historyToDate) : NaN;
                const inRange = (r: { createdAt: number }) =>
                  (Number.isNaN(fromMs) || r.createdAt >= fromMs) &&
                  (Number.isNaN(toMs) || r.createdAt <= toMs + 24 * 3600 * 1000);
                const tracked = trackedOrders.filter(inRange);
                const live = liveOrders.filter((o) => {
                  const t0 = o.validFromTime ? o.validFromTime * 1000 : NaN;
                  const t1 = o.validToTime ? o.validToTime * 1000 : NaN;
                  return (Number.isNaN(fromMs) || Number.isNaN(t0) || t0 >= fromMs) &&
                    (Number.isNaN(toMs) || Number.isNaN(t1) || t1 <= toMs + 24 * 3600 * 1000);
                });
                return (
                  <>
                    {tracked.length > 0 && (
                      <>
                        <Text style={s.groupLabel}>Tracked (in-app)</Text>
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
                    <Text style={s.groupLabel}>Live on chain</Text>
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
                        </View>
                      ))
                    )}
                  </>
                );
              })()}
            </>
          )}
        </ScrollView>
      )}

      <Modal visible={orderModal} transparent animationType="slide" onRequestClose={() => setOrderModal(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.modalOverlay}>
          <View style={s.modal}>
            <ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <View style={s.modalHeader}>
                <Text style={s.modalTitle}>{orderSide === 'buy' ? t('order.buyToken', { token: selectedToken?.tokenname }) : t('order.sellToken', { token: selectedToken?.tokenname })}</Text>
                <TouchableOpacity onPress={() => setOrderModal(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
                  <CloseIcon size={20} color={theme.colors.text.primary} />
                </TouchableOpacity>
              </View>

              <View style={s.sideToggle}>
                <TouchableOpacity style={[s.sideBtn, orderSide === 'buy' && s.sideBuyActive]} onPress={() => setOrderSide('buy')}>
                  <Text style={[s.sideBtnText, orderSide === 'buy' && s.sideBtnTextActive]}>{t('order.buy')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.sideBtn, orderSide === 'sell' && s.sideSellActive]} onPress={() => setOrderSide('sell')}>
                  <Text style={[s.sideBtnText, orderSide === 'sell' && s.sideBtnTextActive]}>{t('order.sell')}</Text>
                </TouchableOpacity>
              </View>

              <View style={s.fieldGroup}>
                <Text style={s.fieldLabel}>{t('order.selectToken')}</Text>
                <TextInput style={s.fieldInput} value={tokenSearch} onChangeText={searchTokens}
                  placeholder={t('order.searchToken')} placeholderTextColor={theme.colors.text.secondary}
                  autoCapitalize="none" autoCorrect={false} testID="order-token-search" />
                {searchingTokens ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginTop: 8 }} />
                ) : tokenResults.length > 0 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }} testID="order-token-results">
                    {tokenResults.map((tk, i) => (
                      <TouchableOpacity key={i} style={[s.chip, selectedToken?.tokenid === tk.tokenid && s.chipActive]} onPress={() => selectSearchedToken(tk)} testID={`order-token-${i}`}>
                        <Text style={[s.chipText, selectedToken?.tokenid === tk.tokenid && s.chipTextActive]}>{tk.tokenname}</Text>
                        <Text style={[s.chipSub, selectedToken?.tokenid === tk.tokenid && s.chipSubActive]}>{tk.tokenid.slice(0, 10)}...</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                ) : (
                  selectedToken && (
                    <Text style={s.selectedTokenText} testID="order-selected-token">{selectedToken.tokenname} · {selectedToken.tokenid}</Text>
                  )
                )}
              </View>

              <View style={s.fieldGroup}>
                <Text style={s.fieldLabel}>{t('order.price', { token: selectedToken?.tokenname })}</Text>
                <TextInput style={s.fieldInput} value={orderPrice} onChangeText={(v) => { setOrderPrice(v); calcTotal(v, orderAmount); }}
                  keyboardType="decimal-pad" placeholder="0.00" />
              </View>

              <View style={s.fieldGroup}>
                <Text style={s.fieldLabel}>{t('order.amount')}</Text>
                <TextInput style={s.fieldInput} value={orderAmount} onChangeText={(v) => { setOrderAmount(v); calcTotal(orderPrice, v); }}
                  keyboardType="decimal-pad" placeholder="0.00" />
              </View>

              <View style={s.totalRow}>
                <Text style={s.totalLabel}>{t('order.total')}</Text>
                <Text style={s.totalValue}>{orderTotal || '0'} BIG</Text>
              </View>

              <TouchableOpacity style={[s.submitBtn, { backgroundColor: orderSide === 'buy' ? theme.colors.accent.emerald : theme.colors.accent.red }]}
                onPress={submitOrder} disabled={submitting}>
                <Text style={s.submitBtnText}>{submitting ? t('order.placing') : t('order.placeOrder', { side: orderSide === 'buy' ? t('order.buy') : t('order.sell') })}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loader: { color: theme.colors.primary },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 12 },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 32, alignItems: 'center', marginTop: 20, borderWidth: 1, borderColor: theme.colors.border },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: theme.colors.text.secondary },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center' },
  priceCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  priceLeft: { flex: 1 },
  priceCenter: { alignItems: 'flex-end', marginRight: 10 },
  tokenName: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  tokenId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: MONO_FONT },
  price: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  change: { fontSize: 12, fontWeight: '600', marginTop: 1 },
  pos: { color: theme.colors.positive },
  neg: { color: theme.colors.negative },
  neutral: { color: theme.colors.text.secondary },
  actionCol: { gap: 4 },
  chartCol: { alignItems: 'flex-end', justifyContent: 'center', width: 70, marginRight: 10 },
  changeBar: { height: 6, borderRadius: 3, maxWidth: 60 },
  marketSummary: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: theme.colors.border },
  summaryTitle: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 12 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  summaryItem: { alignItems: 'center', flex: 1 },
  summaryValue: { fontSize: 20, fontWeight: '800', color: theme.colors.text.primary },
  summaryLabel: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  buyBtn: { backgroundColor: theme.colors.accent.emerald, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 5, alignItems: 'center' },
  buyBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  sellBtn: { backgroundColor: theme.colors.accent.red, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 5, alignItems: 'center' },
  sellBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  orderCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 8, padding: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  orderSide: { fontSize: 13, fontWeight: '700', width: 40 },
  orderInfo: { fontSize: 13, color: theme.colors.text.primary },
  orderInfoCol: { flex: 1 },
  orderSub: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 2 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  refreshBtn: { fontSize: 14, color: theme.colors.text.link, fontWeight: '600' },
  groupLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignItems: 'center', marginLeft: 8 },
  statusBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { backgroundColor: theme.colors.groupped.surface, borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 20, paddingBottom: 40, maxHeight: '85%' },
  modalContent: { paddingBottom: 8 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: theme.colors.text.primary },
  sideToggle: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border, marginBottom: 16 },
  sideBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  sideBuyActive: { backgroundColor: theme.colors.accent.emerald },
  sideSellActive: { backgroundColor: theme.colors.accent.red },
  sideBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.text.secondary },
  sideBtnTextActive: { color: '#FFFFFF' },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 6 },
  fieldInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, fontSize: 15, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, marginBottom: 16 },
  totalLabel: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  totalValue: { fontSize: 18, fontWeight: '700', color: theme.colors.text.primary },
  submitBtn: { borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
  submitBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  chip: { backgroundColor: theme.colors.groupped.background, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  chipTextActive: { color: '#FFFFFF' },
  chipSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 1 },
  chipSubActive: { color: '#FFFFFF', opacity: 0.85 },
  selectedTokenText: { fontSize: 13, color: theme.colors.text.primary, marginTop: 8 },
  filterCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 12, marginBottom: 12 },
  filterLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateInput: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
}));
