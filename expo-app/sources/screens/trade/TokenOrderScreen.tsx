import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { orderOnLayer1 } from '@/services/transaction';
import { listOrders, recordOrder } from '@/services/tracking';
import type { MarketPrice } from '@/types/api';
import { MONO_FONT } from '@/constants/fonts';

interface Props {
  side: 'buy' | 'sell';
}

/**
 * Dedicated "Buy Token" / "Sell Token" page. Lets the user search a token and
 * place a buy or sell order on the active L1 order-match chain.
 */
export default function TokenOrderScreen({ side }: Props) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();

  const [prices, setPrices] = React.useState<MarketPrice[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [tokenSearch, setTokenSearch] = React.useState('');
  const [filtered, setFiltered] = React.useState<MarketPrice[]>([]);
  const [selectedToken, setSelectedToken] = React.useState<MarketPrice | null>(null);
  const [orderPrice, setOrderPrice] = React.useState('');
  const [orderAmount, setOrderAmount] = React.useState('');
  const [orderTotal, setOrderTotal] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await httpService.getMarketPrices();
        if (!cancelled && res.success && res.data) {
          setPrices(res.data);
          if (res.data.length > 0) {
            const first = res.data[0];
            setSelectedToken(first);
            setOrderPrice(first.price && first.price !== '0' ? first.price : '');
          }
        }
      } catch (e) {
        console.error('Error loading prices:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const searchTokens = async (keyword: string) => {
    setTokenSearch(keyword);
    const kw = keyword.trim().toLowerCase();
    if (!kw) {
      setFiltered([]);
      return;
    }
    setFiltered(
      prices.filter(
        (p) =>
          (p.tokenname || '').toLowerCase().includes(kw) ||
          (p.tokenid || '').toLowerCase().includes(kw)
      )
    );
  };

  const selectToken = (tk: MarketPrice) => {
    setSelectedToken(tk);
    setTokenSearch('');
    setFiltered([]);
    setOrderPrice(tk.price && tk.price !== '0' ? tk.price : orderPrice);
    setOrderAmount('');
    setOrderTotal('');
  };

  const calcTotal = (price: string, amount: string) => {
    const p = parseFloat(price) || 0;
    const a = parseFloat(amount) || 0;
    setOrderTotal((p * a).toFixed(6));
  };

  const submitOrder = async () => {
    if (!selectedToken) { Alert.alert('', t('order.selectToken')); return; }
    if (!isUnlocked || !publicInfo?.address) { Alert.alert(t('wallet.locked'), t('order.unlockFirst')); return; }
    const price = parseFloat(orderPrice);
    const amount = parseFloat(orderAmount);
    if (!price || price <= 0) { Alert.alert('', t('order.invalidPrice')); return; }
    if (!amount || amount <= 0) { Alert.alert('', t('order.invalidAmount')); return; }

    const wallet = getUnlockedWallet();
    if (!wallet) { Alert.alert('', t('order.unlockFirst')); return; }
    const l1Url = httpService.getL1Url();
    if (!l1Url) { Alert.alert('', 'No L1 chain configured'); return; }

    setSubmitting(true);
    try {
      const decimals = selectedToken.decimals ?? 8;
      const txHash = await orderOnLayer1({
        side,
        privateKeyHex: wallet.wallet.privateKey,
        l1Url,
        tokenId: selectedToken.tokenid,
        price: BigInt(Math.floor(price * Math.pow(10, decimals))),
        amount: BigInt(Math.floor(amount * Math.pow(10, decimals))),
        baseToken: 'bc',
        decimals,
      });
      recordOrder({
        side,
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
      Alert.alert(
        t('order.orderPlaced'),
        t('order.orderPlacedDesc', {
          side: side === 'buy' ? t('order.buy') : t('order.sell'),
          amount,
          token: selectedToken.tokenname,
          price,
        })
      );
      setOrderAmount('');
      setOrderTotal('');
    } catch (e: any) {
      Alert.alert('', e.message || t('order.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const [trackedOrders, setTrackedOrders] = React.useState(listOrders());

  const accent = side === 'buy' ? theme.colors.accent.emerald : theme.colors.accent.red;

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color={theme.colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>
        {side === 'buy' ? t('order.buyToken', { token: '' }) : t('order.sellToken', { token: '' })}
      </Text>

      <View style={s.card}>
        <Text style={s.fieldLabel}>{t('order.selectToken')}</Text>
        <TextInput
          style={s.fieldInput}
          value={tokenSearch}
          onChangeText={searchTokens}
          placeholder={t('order.searchToken')}
          placeholderTextColor={theme.colors.text.secondary}
          autoCapitalize="none"
          autoCorrect={false}
          testID="token-order-search"
        />
        {tokenSearch.trim() ? (
          filtered.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }} testID="token-order-results">
              {filtered.map((tk, i) => (
                <TouchableOpacity key={i} style={[s.chip, selectedToken?.tokenid === tk.tokenid && s.chipActive]} onPress={() => selectToken(tk)} testID={`token-order-${i}`}>
                  <Text style={[s.chipText, selectedToken?.tokenid === tk.tokenid && s.chipTextActive]}>{tk.tokenname}</Text>
                  <Text style={[s.chipSub, selectedToken?.tokenid === tk.tokenid && s.chipSubActive]}>{tk.tokenid.slice(0, 10)}...</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : (
            <Text style={s.noMatch}>{t('tokens.noMatches')}</Text>
          )
        ) : (
          selectedToken && (
            <Text style={s.selectedTokenText} testID="token-selected">
              {selectedToken.tokenname} · {selectedToken.tokenid}
            </Text>
          )
        )}
      </View>

      <View style={s.card}>
        <Text style={s.fieldLabel}>{t('order.price', { token: selectedToken?.tokenname })}</Text>
        <TextInput
          style={[s.fieldInput, { fontFamily: MONO_FONT }]}
          value={orderPrice}
          onChangeText={(v) => { setOrderPrice(v); calcTotal(v, orderAmount); }}
          keyboardType="decimal-pad"
          placeholder="0.00"
          testID="token-order-price"
        />

        <Text style={[s.fieldLabel, s.fieldGap]}>{t('order.amount')}</Text>
        <TextInput
          style={[s.fieldInput, { fontFamily: MONO_FONT }]}
          value={orderAmount}
          onChangeText={(v) => { setOrderAmount(v); calcTotal(orderPrice, v); }}
          keyboardType="decimal-pad"
          placeholder="0.00"
          testID="token-order-amount"
        />

        <View style={s.totalRow}>
          <Text style={s.totalLabel}>{t('order.total')}</Text>
          <Text style={s.totalValue}>{orderTotal || '0'} BIG</Text>
        </View>

        <TouchableOpacity
          style={[s.submitBtn, { backgroundColor: accent }]}
          onPress={submitOrder}
          disabled={submitting}
          testID="token-order-submit"
        >
          <Text style={s.submitBtnText}>
            {submitting
              ? t('order.placing')
              : t('order.placeOrder', { side: side === 'buy' ? t('order.buy') : t('order.sell') })}
          </Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.groupped.background },
  title: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 16 },
  card: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 16,
    marginBottom: 12,
  },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 6 },
  fieldGap: { marginTop: 14 },
  fieldInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.groupped.background,
    color: theme.colors.text.primary,
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
  },
  chip: {
    backgroundColor: theme.colors.groupped.background,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
  chipSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 2 },
  chipTextActive: { color: theme.colors.primary },
  chipSubActive: { color: theme.colors.primary },
  selectedTokenText: { fontSize: 13, color: theme.colors.text.secondary, marginTop: 8 },
  noMatch: { fontSize: 13, color: theme.colors.text.secondary, marginTop: 8 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 16 },
  totalLabel: { fontSize: 14, color: theme.colors.text.secondary },
  totalValue: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary, fontFamily: Platform.select({ web: 'monospace', default: MONO_FONT }) },
  submitBtn: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  submitBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
}));
