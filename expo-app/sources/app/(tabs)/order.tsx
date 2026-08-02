import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl, Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { listOrders, recordOrder, refreshAllStatuses } from '@/services/tracking';
import { CloseIcon } from '@/components/Icons';
import type { MarketPrice, OrderInfo, TrackedRecord } from '@/types/api';

export default function OrderScreen() {
  const { t } = useTranslation();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();
  const [prices, setPrices] = React.useState<MarketPrice[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const [orderModal, setOrderModal] = React.useState(false);
  const [orderSide, setOrderSide] = React.useState<'buy' | 'sell'>('buy');
  const [selectedToken, setSelectedToken] = React.useState<MarketPrice | null>(null);
  const [orderPrice, setOrderPrice] = React.useState('');
  const [orderAmount, setOrderAmount] = React.useState('');
  const [orderTotal, setOrderTotal] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'prices' | 'orders'>('prices');
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
        await refreshAllStatuses(publicInfo.address);
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
    setOrderPrice(token.price || '0');
    setOrderAmount('');
    setOrderTotal('');
    setOrderModal(true);
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

    setSubmitting(true);
    try {
      const payload = {
        side: orderSide,
        tokenId: selectedToken.tokenid,
        tokenName: selectedToken.tokenname,
        baseToken: 'bc',
        price: orderPrice,
        amount: orderAmount,
        decimals: 8,
        fromAddress: publicInfo.address,
        privateKeyHex: wallet.wallet.privateKey,
      };
      const res = await httpService.requestL1('submitTransaction', 'POST', payload);
      if (res.success) {
        recordOrder({
          side: orderSide,
          tokenId: selectedToken.tokenid,
          tokenName: selectedToken.tokenname,
          baseToken: 'bc',
          price: orderPrice,
          amount: orderAmount,
          decimals: 8,
          fromAddress: publicInfo.address,
        });
        setTrackedOrders(listOrders());
        Alert.alert(t('order.orderPlaced'), t('order.orderPlacedDesc', { side: orderSide === 'buy' ? t('order.buy') : t('order.sell'), amount, token: selectedToken.tokenname, price }));
        setOrderModal(false);
      } else {
        Alert.alert('', res.error || t('order.placeFailed'));
      }
    } catch (e: any) {
      Alert.alert('', e.message || t('order.submitFailed'));
    } finally { setSubmitting(false); }
  };

  const fmtChange = (c: string) => { const n = parseFloat(c); return isNaN(n) ? '0%' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; };
  const changeColor = (c: string) => { const n = parseFloat(c); return isNaN(n) || n === 0 ? s.neutral.color : n > 0 ? s.pos.color : s.neg.color; };

  if (loading) {
    return (
      <View style={s.container} testID="order-screen">
        <View style={s.centered}><ActivityIndicator size="large" color={s.loader.color} /></View>
      </View>
    );
  }

  return (
    <View style={s.container} testID="order-screen">
      <View style={s.tabRow}>
        <TouchableOpacity style={[s.tab, activeTab === 'prices' && s.tabActive]} onPress={() => setActiveTab('prices')}>
          <Text style={[s.tabText, activeTab === 'prices' && s.tabTextActive]}>{t('order.title')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'orders' && s.tabActive]} onPress={() => setActiveTab('orders')}>
          <Text style={[s.tabText, activeTab === 'orders' && s.tabTextActive]}>{t('order.myOrders')}</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'prices' ? (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadPrices(true)} />}>
          {prices.length === 0 ? (
            <View style={s.emptyCard}><Text style={s.emptyTitle}>{t('order.noData')}</Text></View>
          ) : (
            prices.map((item, i) => (
              <View key={i} style={s.priceCard}>
                <TouchableOpacity style={s.priceLeft} onPress={() => openOrder('buy', item)}>
                  <Text style={s.tokenName}>{item.tokenname}</Text>
                  <Text style={s.tokenId}>{item.tokenid.slice(0, 10)}...</Text>
                </TouchableOpacity>
                <View style={s.priceCenter}>
                  <Text style={s.price}>{item.price}</Text>
                  <Text style={[s.change, { color: changeColor(item.change) }]}>{fmtChange(item.change)}</Text>
                </View>
                <View style={s.actionCol}>
                  <TouchableOpacity style={s.buyBtn} onPress={() => openOrder('buy', item)}>
                    <Text style={s.buyBtnText}>{t('order.buy')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.sellBtn} onPress={() => openOrder('sell', item)}>
                    <Text style={s.sellBtnText}>{t('order.sell')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
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
          {loadingOrders ? (
            <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 24 }} />
          ) : (
            <>
              {trackedOrders.length > 0 && (
                <>
                  <Text style={s.groupLabel}>Tracked (in-app)</Text>
                  {trackedOrders.map((o) => {
                    const badgeColor = o.status === 'confirmed' ? s.statusConfirmed.color : o.status === 'failed' || o.status === 'cancelled' ? s.statusFailed.color : s.statusPending.color;
                    return (
                      <View key={o.id} style={s.orderCard}>
                        <Text style={[s.orderSide, { color: o.side === 'buy' ? s.pos.color : s.neg.color }]}>
                          {o.side === 'buy' ? t('order.buy') : t('order.sell')}
                        </Text>
                        <View style={s.orderInfoCol}>
                          <Text style={s.orderInfo}>{o.amount} {o.tokenName} @ {o.price}</Text>
                          <Text style={s.orderSub}>{o.statusDetail || o.status}</Text>
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
              {liveOrders.length === 0 ? (
                <View style={s.emptyCard}><Text style={s.emptySub}>{t('order.noOpenOrders')}</Text></View>
              ) : (
                liveOrders.map((o, i) => (
                  <View key={i} style={s.orderCard} testID="live-order">
                    <Text style={[s.orderSide, { color: (o.side || '').toUpperCase() === 'BUY' ? s.pos.color : s.neg.color }]}>{o.side}</Text>
                    <View style={s.orderInfoCol}>
                      <Text style={s.orderInfo}>{o.offerValue} {o.offerTokenid?.slice(0, 8)} @ {o.price} ({o.targetTokenid?.slice(0, 8)})</Text>
                      <Text style={s.orderSub}>{o.cancelPending ? 'CANCELLED' : 'OPEN'}</Text>
                    </View>
                    <View style={[s.statusBadge, { backgroundColor: o.cancelPending ? s.statusFailed.color : s.statusPending.color }]}>
                      <Text style={s.statusBadgeText} testID="live-order-status">{o.cancelPending ? 'cancelled' : 'pending'}</Text>
                    </View>
                  </View>
                ))
              )}
            </>
          )}
        </ScrollView>
      )}

      <Modal visible={orderModal} transparent animationType="slide" onRequestClose={() => setOrderModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>{orderSide === 'buy' ? t('order.buyToken', { token: selectedToken?.tokenname }) : t('order.sellToken', { token: selectedToken?.tokenname })}</Text>
              <TouchableOpacity onPress={() => setOrderModal(false)}><CloseIcon size={20} color="#000" /></TouchableOpacity>
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

            <TouchableOpacity style={[s.submitBtn, { backgroundColor: orderSide === 'buy' ? s.pos.color : s.neg.color }]}
              onPress={submitOrder} disabled={submitting}>
              <Text style={s.submitBtnText}>{submitting ? t('order.placing') : t('order.placeOrder', { side: orderSide === 'buy' ? t('order.buy') : t('order.sell') })}</Text>
            </TouchableOpacity>
          </View>
        </View>
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
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.card?.background || theme.colors.groupped.surface },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary },
  tabTextActive: { color: '#FFFFFF' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 12 },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 32, alignItems: 'center', marginTop: 20, borderWidth: 1, borderColor: theme.colors.border },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: theme.colors.text.secondary },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center' },
  priceCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 12, marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  priceLeft: { flex: 1 },
  priceCenter: { alignItems: 'flex-end', marginRight: 10 },
  tokenName: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  tokenId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: 'monospace' },
  price: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  change: { fontSize: 12, fontWeight: '600', marginTop: 1 },
  pos: { color: theme.colors.accent?.emerald || '#10B981' },
  neg: { color: theme.colors.accent?.red || '#EF4444' },
  neutral: { color: theme.colors.text.secondary },
  actionCol: { gap: 4 },
  buyBtn: { backgroundColor: theme.colors.accent?.emerald || '#10B981', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 5, alignItems: 'center' },
  buyBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  sellBtn: { backgroundColor: theme.colors.accent?.red || '#EF4444', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 5, alignItems: 'center' },
  sellBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600' },
  orderCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 8, padding: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  orderSide: { fontSize: 13, fontWeight: '700', width: 40 },
  orderInfo: { fontSize: 13, color: theme.colors.text.primary },
  orderInfoCol: { flex: 1 },
  orderSub: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 2 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  refreshBtn: { fontSize: 14, color: theme.colors.primary, fontWeight: '600' },
  groupLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignItems: 'center', marginLeft: 8 },
  statusBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  statusPending: { color: '#F59E0B' },
  statusConfirmed: { color: '#10B981' },
  statusFailed: { color: '#EF4444' },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { backgroundColor: theme.colors.groupped.surface, borderTopLeftRadius: 12, borderTopRightRadius: 12, padding: 20, paddingBottom: 40 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: theme.colors.text.primary },
  sideToggle: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border, marginBottom: 16 },
  sideBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  sideBuyActive: { backgroundColor: theme.colors.accent?.emerald || '#10B981' },
  sideSellActive: { backgroundColor: theme.colors.accent?.red || '#EF4444' },
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
}));
