import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { MONO_FONT } from '@/constants/fonts';
import { pqDidFromKey, pqKeyFromPrivateHex } from '@/lib/p2pIdentity';
import {
  createOrder, listOpenOrders, matchOrder, mySwaps, p2pConfigured,
  sendPayment, transition,
  type P2pIdentity, type P2pOrder, type P2pSwap, type P2pSwapAction,
} from '@/services/p2p';

type Tab = 'open' | 'mine';

/**
 * P2P trading screen: a public sell-order book (buy) and the wallet's own
 * swaps (sell/list, lock, pay, expire/refund/cancel). All mutations are signed
 * with the wallet's PQ key; reads of own swaps are party-scoped by the engine.
 */
export default function P2pScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();

  const [tab, setTab] = React.useState<Tab>('open');
  const [loading, setLoading] = React.useState(true);
  const [orders, setOrders] = React.useState<P2pOrder[]>([]);
  const [swaps, setSwaps] = React.useState<P2pSwap[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<P2pOrder | null>(null);
  const [buyRecv, setBuyRecv] = React.useState('');
  const [buyPaypal, setBuyPaypal] = React.useState('');
  const [buyEmail, setBuyEmail] = React.useState('');
  const [txHashes, setTxHashes] = React.useState<Record<string, string>>({});

  const [giveToken, setGiveToken] = React.useState('');
  const [giveAmount, setGiveAmount] = React.useState('');
  const [giveChain, setGiveChain] = React.useState('L0');
  const [wantCurrency, setWantCurrency] = React.useState('USD');
  const [wantAmount, setWantAmount] = React.useState('');
  const [validHours, setValidHours] = React.useState('24');

  const keyHex = isUnlocked ? getUnlockedWallet()?.wallet.privateKey : undefined;
  const keyType = getUnlockedWallet()?.wallet.keyType;
  const identity = React.useMemo<P2pIdentity | null>(() => {
    if (!keyHex || keyType === 'EC') return null;
    try {
      const key = pqKeyFromPrivateHex(keyHex);
      return { key, did: pqDidFromKey(key) };
    } catch {
      return null;
    }
  }, [keyHex, keyType]);

  const loadOrders = React.useCallback(async () => {
    setOrders(await listOpenOrders());
  }, []);

  const loadSwaps = React.useCallback(async () => {
    if (!identity) { setSwaps([]); return; }
    setSwaps(await mySwaps(identity));
  }, [identity]);

  const refresh = React.useCallback(async () => {
    if (!p2pConfigured()) { setLoading(false); return; }
    setLoading(true);
    try {
      if (tab === 'open') await loadOrders();
      else await loadSwaps();
    } catch (e) {
      Alert.alert('', e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab, loadOrders, loadSwaps]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const requireIdentity = (): P2pIdentity | null => {
    if (!isUnlocked || !publicInfo?.address) { Alert.alert(t('wallet.locked'), t('p2p.unlockFirst')); return null; }
    if (!identity) { Alert.alert('', t('p2p.unlockFirst')); return null; }
    return identity;
  };

  const submitOrder = async () => {
    const id = requireIdentity();
    if (!id) return;
    const hours = parseFloat(validHours);
    if (!giveToken.trim() || !giveAmount.trim() || !wantAmount.trim() || !hours || hours <= 0) {
      Alert.alert('', t('p2p.createFailed'));
      return;
    }
    setBusy(true);
    try {
      await createOrder(id, {
        giveToken: giveToken.trim(),
        giveAmount: giveAmount.trim(),
        giveChain: giveChain.trim() || 'L0',
        wantCurrency: wantCurrency.trim() || 'USD',
        wantAmount: wantAmount.trim(),
        wantRail: 'paypal',
        validUntil: Math.floor(Date.now() / 1000) + Math.floor(hours * 3600),
      });
      setGiveToken(''); setGiveAmount(''); setWantAmount('');
      Alert.alert(t('p2p.created'), '');
      setTab('mine');
      await loadSwaps();
    } catch (e) {
      Alert.alert('', e instanceof Error ? e.message : t('p2p.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submitBuy = async (order: P2pOrder) => {
    const id = requireIdentity();
    if (!id) return;
    if (!buyRecv.trim() || !buyPaypal.trim()) { Alert.alert('', t('p2p.buyFailed')); return; }
    setBusy(true);
    try {
      const res = await matchOrder(id, order.orderId, {
        receiveAddress: buyRecv.trim(),
        paypalAccount: buyPaypal.trim(),
        buyerEmail: buyEmail.trim() || undefined,
      });
      setSelected(null); setBuyRecv(''); setBuyPaypal(''); setBuyEmail('');
      Alert.alert(t('p2p.buyTitle'), `${res.swapId}\n${res.escrowAddress ?? ''}`);
      setTab('mine');
      await loadSwaps();
    } catch (e) {
      Alert.alert('', e instanceof Error ? e.message : t('p2p.buyFailed'));
    } finally {
      setBusy(false);
    }
  };

  const runTransition = async (swap: P2pSwap, action: P2pSwapAction, extra: Record<string, unknown> = {}) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await transition(id, swap.swapId, action, extra);
      await loadSwaps();
    } catch (e) {
      Alert.alert('', e instanceof Error ? e.message : t('p2p.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const pay = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await sendPayment(id, swap.swapId, swap.swapId);
      await loadSwaps();
    } catch (e) {
      Alert.alert('', e instanceof Error ? e.message : t('p2p.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!p2pConfigured()) {
    return (
      <View style={s.centered}>
        <Text style={s.emptyText} testID="p2p-not-configured">{t('p2p.notConfigured')}</Text>
      </View>
    );
  }

  const myDid = identity?.did;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={s.tabs}>
        <TabButton label={t('p2p.tabOpen')} active={tab === 'open'} onPress={() => setTab('open')} testID="p2p-tab-open" />
        <TabButton label={t('p2p.tabMine')} active={tab === 'mine'} onPress={() => setTab('mine')} testID="p2p-tab-mine" />
        <TouchableOpacity onPress={refresh} style={s.refreshBtn} testID="p2p-refresh" accessibilityRole="button">
          <Text style={[s.refreshText, { color: theme.colors.primary }]}>{t('p2p.refresh')}</Text>
        </TouchableOpacity>
      </View>

      {tab === 'open' ? (
        <>
          <View style={s.card}>
            <Text style={s.cardTitle}>{t('p2p.createTitle')}</Text>
            <Field label={t('p2p.giveToken')} value={giveToken} onChange={setGiveToken} placeholder="USDT" testID="p2p-give-token" />
            <Field label={t('p2p.giveAmount')} value={giveAmount} onChange={setGiveAmount} placeholder="0.00" keyboardType="decimal-pad" mono testID="p2p-give-amount" />
            <Field label={t('p2p.wantAmount')} value={wantAmount} onChange={setWantAmount} placeholder="0.00" keyboardType="decimal-pad" mono testID="p2p-want-amount" />
            <Field label={t('p2p.wantCurrency')} value={wantCurrency} onChange={setWantCurrency} placeholder="USD" testID="p2p-want-currency" />
            <Field label={t('p2p.giveChain')} value={giveChain} onChange={setGiveChain} placeholder="L0" testID="p2p-give-chain" />
            <TouchableOpacity style={[s.btn, { backgroundColor: theme.colors.primary }]} onPress={submitOrder} disabled={busy} testID="p2p-create">
              <Text style={s.btnText}>{t('p2p.create')}</Text>
            </TouchableOpacity>
          </View>

          {loading ? <ActivityIndicator color={theme.colors.primary} style={s.loader} />
            : orders.length === 0 ? <Text style={s.emptyText}>{t('p2p.emptyOpen')}</Text>
            : orders.map((o, i) => (
              <View key={o.orderId} style={s.card} testID={`p2p-order-${i}`}>
                <View style={s.rowBetween}>
                  <Text style={s.cardTitle}>{o.giveAmount} {o.giveToken}</Text>
                  <Text style={s.mono}>{o.wantAmount} {o.wantCurrency}</Text>
                </View>
                <Text style={s.sub}>{t('p2p.giveChain')}: {o.giveChain} · {o.wantRail}</Text>
                <Text style={s.subMono}>{o.sellerDid}</Text>
                {selected?.orderId === o.orderId ? (
                  <View style={s.buyPanel}>
                    <Field label={t('p2p.receiveAddress')} value={buyRecv} onChange={setBuyRecv} testID="p2p-buy-recv" />
                    <Field label={t('p2p.paypalAccount')} value={buyPaypal} onChange={setBuyPaypal} testID="p2p-buy-paypal" />
                    <Field label={t('p2p.paypalEmail')} value={buyEmail} onChange={setBuyEmail} keyboardType="email-address" testID="p2p-buy-email" />
                    <TouchableOpacity style={[s.btn, { backgroundColor: theme.colors.accent.emerald }]} onPress={() => submitBuy(o)} disabled={busy} testID="p2p-buy-confirm">
                      <Text style={s.btnText}>{t('p2p.buy')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity style={[s.btn, { backgroundColor: theme.colors.accent.emerald }]} onPress={() => { setSelected(o); setBuyRecv(''); setBuyPaypal(''); setBuyEmail(''); }} testID={`p2p-buy-${i}`}>
                    <Text style={s.btnText}>{t('p2p.buy')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
        </>
      ) : !identity ? (
        <Text style={s.emptyText} testID="p2p-need-unlock">{t('p2p.unlockFirst')}</Text>
      ) : loading ? (
        <ActivityIndicator color={theme.colors.primary} style={s.loader} />
      ) : swaps.length === 0 ? (
        <Text style={s.emptyText}>{t('p2p.emptyMine')}</Text>
      ) : (
        swaps.map((sw, i) => (
          <SwapCard
            key={sw.swapId}
            swap={sw}
            myDid={myDid}
            busy={busy}
            txHash={txHashes[sw.swapId] ?? ''}
            onTxHash={(v) => setTxHashes((m) => ({ ...m, [sw.swapId]: v }))}
            onLock={() => runTransition(sw, 'escrow_lock', { txHash: (txHashes[sw.swapId] ?? '').trim() })}
            onPay={() => pay(sw)}
            onExpire={() => runTransition(sw, 'expire')}
            onRefund={() => runTransition(sw, 'refund')}
            onCancel={() => runTransition(sw, 'cancel')}
            index={i}
          />
        ))
      )}
    </ScrollView>
  );
}

function TabButton({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID: string }) {
  const { theme } = useUnistyles();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[s.tab, active && { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary }]}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[s.tabText, { color: active ? theme.colors.primary : theme.colors.text.secondary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({ label, value, onChange, placeholder, keyboardType, mono, testID }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
  keyboardType?: 'default' | 'decimal-pad' | 'email-address'; mono?: boolean; testID?: string;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={[s.input, mono && { fontFamily: MONO_FONT }]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.text.secondary}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
        autoCorrect={false}
        testID={testID}
      />
    </View>
  );
}

function SwapCard({ swap, myDid, busy, txHash, onTxHash, onLock, onPay, onExpire, onRefund, onCancel, index }: {
  swap: P2pSwap; myDid?: string; busy: boolean; txHash: string; onTxHash: (v: string) => void;
  onLock: () => void; onPay: () => void; onExpire: () => void; onRefund: () => void; onCancel: () => void; index: number;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isSeller = !!myDid && swap.sellerDid === myDid;
  const isBuyer = !!myDid && swap.buyerDid === myDid;
  const st = swap.status;

  return (
    <View style={s.card} testID={`p2p-swap-${index}`}>
      <View style={s.rowBetween}>
        <Text style={s.cardTitle}>{swap.giveAmount} {swap.giveToken} → {swap.wantAmount} {swap.wantCurrency}</Text>
        <Text style={[s.badge, { color: theme.colors.primary }]} testID={`p2p-swap-${index}-status`}>{st}</Text>
      </View>
      <Text style={s.subMono}>{swap.swapId}</Text>
      {swap.escrowAddress ? <Text style={s.sub}>{t('p2p.escrowAddress')}: {swap.escrowAddress.slice(0, 20)}…</Text> : null}
      {swap.payoutStatus ? <Text style={s.sub}>payout: {swap.payoutStatus}</Text> : null}
      {swap.paymentReversed ? <Text style={s.sub}>{swap.dispute ? `dispute ${swap.dispute}` : 'reversed'}</Text> : null}

      {isSeller && (st === 'MATCHED' || st === 'ESCROW_LOCKED' || st === 'PAYMENT_PENDING') ? (
        <View style={s.actions}>
          {st === 'MATCHED' ? (
            <>
              <Field label="txHash" value={txHash} onChange={onTxHash} testID={`p2p-swap-${index}-txhash`} />
              <Action label={t('p2p.aLock')} color={theme.colors.primary} onPress={onLock} disabled={busy} testID={`p2p-swap-${index}-lock`} />
            </>
          ) : null}
          {(st === 'ESCROW_LOCKED' || st === 'PAYMENT_PENDING') ? (
            <Action label={t('p2p.aExpire')} color={theme.colors.accent.red} onPress={onExpire} disabled={busy} testID={`p2p-swap-${index}-expire`} />
          ) : null}
          <Action label={t('p2p.aCancel')} color={theme.colors.text.secondary} onPress={onCancel} disabled={busy} testID={`p2p-swap-${index}-cancel`} />
        </View>
      ) : null}

      {isSeller && st === 'EXPIRED' ? (
        <View style={s.actions}>
          <Action label={t('p2p.aRefund')} color={theme.colors.accent.red} onPress={onRefund} disabled={busy} testID={`p2p-swap-${index}-refund`} />
        </View>
      ) : null}

      {isBuyer && st === 'ESCROW_LOCKED' ? (
        <View style={s.actions}>
          <Action label={t('p2p.aPay')} color={theme.colors.accent.emerald} onPress={onPay} disabled={busy} testID={`p2p-swap-${index}-pay`} />
          <Action label={t('p2p.aCancel')} color={theme.colors.text.secondary} onPress={onCancel} disabled={busy} testID={`p2p-swap-${index}-cancel`} />
        </View>
      ) : null}
    </View>
  );
}

function Action({ label, color, onPress, disabled, testID }: {
  label: string; color: string; onPress: () => void; disabled?: boolean; testID?: string;
}) {
  return (
    <TouchableOpacity style={[s.action, { borderColor: color }]} onPress={onPress} disabled={disabled} testID={testID}>
      <Text style={[s.actionText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.colors.groupped.background, padding: 24 },
  emptyText: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', marginTop: 24 },
  loader: { marginTop: 24 },
  tabs: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
  tabText: { fontSize: 14, fontWeight: '600' },
  refreshBtn: { marginLeft: 'auto', paddingHorizontal: 8, paddingVertical: 8 },
  refreshText: { fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mono: { fontSize: 14, fontFamily: MONO_FONT, color: theme.colors.text.primary },
  sub: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 6 },
  subMono: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 4, fontFamily: MONO_FONT },
  badge: { fontSize: 12, fontWeight: '700' },
  buyPanel: { marginTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12 },
  field: { marginTop: 10 },
  fieldLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 4 },
  input: { borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, borderRadius: 8, padding: 10, fontSize: 14 },
  btn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  btnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  action: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  actionText: { fontSize: 13, fontWeight: '600' },
}));
