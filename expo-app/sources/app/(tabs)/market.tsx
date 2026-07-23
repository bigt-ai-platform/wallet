import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl, Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { CloseIcon } from '@/components/Icons';
import type { MarketPrice } from '@/types/api';

export default function MarketScreen() {
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
  const [myOrders, setMyOrders] = React.useState<any[]>([]);

  React.useEffect(() => { loadPrices(); }, []);

  const loadPrices = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const res = await httpService.getMarketPrices();
      if (res.success && res.data) setPrices(res.data);
    } catch (e) { console.error('Error loading prices:', e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  const openOrder = (side: 'buy' | 'sell', token: MarketPrice) => {
    if (!isUnlocked) { Alert.alert(t('wallet.locked'), t('market.unlockFirst')); return; }
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
    if (!price || price <= 0) { Alert.alert('', t('market.invalidPrice')); return; }
    if (!amount || amount <= 0) { Alert.alert('', t('market.invalidAmount')); return; }

    const wallet = getUnlockedWallet();
    if (!wallet) { Alert.alert('', t('market.unlockFirst')); return; }

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
        Alert.alert(t('market.orderPlaced'), t('market.orderPlacedDesc', { side: orderSide === 'buy' ? t('market.buy') : t('market.sell'), amount, token: selectedToken.tokenname, price }));
        setOrderModal(false);
      } else {
        Alert.alert('', res.error || t('market.placeFailed'));
      }
    } catch (e: any) {
      Alert.alert('', e.message || t('market.submitFailed'));
    } finally { setSubmitting(false); }
  };

  const fmtChange = (c: string) => { const n = parseFloat(c); return isNaN(n) ? '0%' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`; };
  const changeColor = (c: string) => { const n = parseFloat(c); return isNaN(n) || n === 0 ? s.neutral.color : n > 0 ? s.pos.color : s.neg.color; };

  if (loading) {
    return (
      <View style={s.container} testID="market-screen">
        <View style={s.centered}><ActivityIndicator size="large" color={s.loader.color} /></View>
      </View>
    );
  }

  return (
    <View style={s.container} testID="market-screen">
      <View style={s.tabRow}>
        <TouchableOpacity style={[s.tab, activeTab === 'prices' && s.tabActive]} onPress={() => setActiveTab('prices')}>
          <Text style={[s.tabText, activeTab === 'prices' && s.tabTextActive]}>{t('market.title')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'orders' && s.tabActive]} onPress={() => setActiveTab('orders')}>
          <Text style={[s.tabText, activeTab === 'orders' && s.tabTextActive]}>{t('market.myOrders')}</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'prices' ? (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadPrices(true)} />}>
          {prices.length === 0 ? (
            <View style={s.emptyCard}><Text style={s.emptyTitle}>{t('market.noData')}</Text></View>
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
                    <Text style={s.buyBtnText}>{t('market.buy')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.sellBtn} onPress={() => openOrder('sell', item)}>
                    <Text style={s.sellBtnText}>{t('market.sell')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}>
          <Text style={s.sectionTitle}>{t('market.yourOrders')}</Text>
          {myOrders.length === 0 ? (
            <View style={s.emptyCard}><Text style={s.emptySub}>{t('market.noOpenOrders')}</Text></View>
          ) : (
            myOrders.map((o, i) => (
              <View key={i} style={s.orderCard}>
                <Text style={[s.orderSide, { color: o.side === 'BUY' ? s.pos.color : s.neg.color }]}>{o.side}</Text>
                <Text style={s.orderInfo}>{o.offerValue} {o.offerTokenid?.slice(0, 8)} @ {o.price}</Text>
              </View>
            ))
          )}
        </ScrollView>
      )}

      <Modal visible={orderModal} transparent animationType="slide" onRequestClose={() => setOrderModal(false)}>
        <View style={s.modalOverlay}>
          <View style={s.modal}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>{orderSide === 'buy' ? t('market.buyToken', { token: selectedToken?.tokenname }) : t('market.sellToken', { token: selectedToken?.tokenname })}</Text>
              <TouchableOpacity onPress={() => setOrderModal(false)}><CloseIcon size={20} color="#000" /></TouchableOpacity>
            </View>

            <View style={s.sideToggle}>
              <TouchableOpacity style={[s.sideBtn, orderSide === 'buy' && s.sideBuyActive]} onPress={() => setOrderSide('buy')}>
                <Text style={[s.sideBtnText, orderSide === 'buy' && s.sideBtnTextActive]}>{t('market.buy')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.sideBtn, orderSide === 'sell' && s.sideSellActive]} onPress={() => setOrderSide('sell')}>
                <Text style={[s.sideBtnText, orderSide === 'sell' && s.sideBtnTextActive]}>{t('market.sell')}</Text>
              </TouchableOpacity>
            </View>

            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>{t('market.price', { token: selectedToken?.tokenname })}</Text>
              <TextInput style={s.fieldInput} value={orderPrice} onChangeText={(v) => { setOrderPrice(v); calcTotal(v, orderAmount); }}
                keyboardType="decimal-pad" placeholder="0.00" />
            </View>

            <View style={s.fieldGroup}>
              <Text style={s.fieldLabel}>{t('market.amount')}</Text>
              <TextInput style={s.fieldInput} value={orderAmount} onChangeText={(v) => { setOrderAmount(v); calcTotal(orderPrice, v); }}
                keyboardType="decimal-pad" placeholder="0.00" />
            </View>

            <View style={s.totalRow}>
              <Text style={s.totalLabel}>{t('market.total')}</Text>
              <Text style={s.totalValue}>{orderTotal || '0'} BIG</Text>
            </View>

            <TouchableOpacity style={[s.submitBtn, { backgroundColor: orderSide === 'buy' ? s.pos.color : s.neg.color }]}
              onPress={submitOrder} disabled={submitting}>
              <Text style={s.submitBtnText}>{submitting ? t('market.placing') : t('market.placeOrder', { side: orderSide === 'buy' ? t('market.buy') : t('market.sell') })}</Text>
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
  buyBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  sellBtn: { backgroundColor: theme.colors.accent?.red || '#EF4444', borderRadius: 6, paddingHorizontal: 14, paddingVertical: 5, alignItems: 'center' },
  sellBtnText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  orderCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 8, padding: 12, marginBottom: 6, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  orderSide: { fontSize: 13, fontWeight: '700', width: 40 },
  orderInfo: { fontSize: 13, color: theme.colors.text.primary, flex: 1 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modal: { backgroundColor: theme.colors.groupped.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 },
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
  fieldInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 12, fontSize: 16, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderTopColor: theme.colors.divider, marginBottom: 16 },
  totalLabel: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  totalValue: { fontSize: 18, fontWeight: '700', color: theme.colors.text.primary },
  submitBtn: { borderRadius: 10, paddingVertical: 15, alignItems: 'center' },
  submitBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
}));
