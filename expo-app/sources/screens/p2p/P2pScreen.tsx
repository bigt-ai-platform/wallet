import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Image, Linking,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { MONO_FONT } from '@/constants/fonts';
import WalletUnlock from '@/components/WalletUnlock';
import { p2pPdfUrl, tzRegion } from '@/lib/docs';
import { pqDidFromKey, pqKeyFromPrivateHex } from '@/lib/p2pIdentity';
import { httpService } from '@/services/http';
import type { TokenItem } from '@/types/api';
import {
  confirmPayment, createOrder, fetchInstructions, getMyProfiles, listOpenOrders, matchOrder,
  mySwaps, openDispute, p2pConfigured, saveProfile, sendPayment, submitProof, transition,
  type P2pCnyRail, type P2pIdentity, type P2pOrder, type P2pPaymentInstructions,
  type P2pPaymentProfile, type P2pSwap, type P2pSwapAction,
} from '@/services/p2p';

type Tab = 'open' | 'mine';

/** CNY rails (docs/p2pcny.md): settle peer-to-peer with manual confirmation. */
const CNY_RAILS: readonly string[] = ['wechat', 'alipay', 'bank'];
function isCnyRail(rail?: string): boolean {
  return !!rail && CNY_RAILS.includes(rail);
}

/**
 * P2P trading screen: a public sell-order book (buy) and the wallet's own
 * swaps (sell/list, lock, pay, expire/refund/cancel). All mutations are signed
 * with the wallet's PQ key; reads of own swaps are party-scoped by the engine.
 */
export default function P2pScreen() {
  const { t, i18n } = useTranslation();
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
  const [txIds, setTxIds] = React.useState<Record<string, string>>({});
  // Inline feedback: react-native-web's Alert.alert is a no-op, so every P2P
  // result (including the CNY payment instructions the buyer must read) has to
  // render in the screen itself.
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);
  // Inline feedback replaces Alert.alert (a no-op on react-native-web); the
  // banner clears itself so a stale success message cannot be mistaken for the
  // result of a later action.
  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 10000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [instructions, setInstructions] = React.useState<Record<string, P2pPaymentInstructions>>({});

  const [giveToken, setGiveToken] = React.useState('');
  const [tokenResults, setTokenResults] = React.useState<TokenItem[]>([]);
  const [tokenSearching, setTokenSearching] = React.useState(false);
  const [giveAmount, setGiveAmount] = React.useState('');
  const [giveChain, setGiveChain] = React.useState('L0');
  const [wantCurrency, setWantCurrency] = React.useState('USD');
  const [wantAmount, setWantAmount] = React.useState('');
  const [validHours, setValidHours] = React.useState('24');
  const [wantRail, setWantRail] = React.useState('paypal');

  // seller's CNY collection profile (mine tab)
  const [profiles, setProfiles] = React.useState<P2pPaymentProfile[]>([]);
  const [profileMethod, setProfileMethod] = React.useState<P2pCnyRail>('wechat');
  const [profileName, setProfileName] = React.useState('');
  const [profileAccount, setProfileAccount] = React.useState('');
  const [profileBank, setProfileBank] = React.useState('');

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
      setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, [tab, loadOrders, loadSwaps]);

  React.useEffect(() => { refresh(); }, [refresh]);

  const loadProfiles = React.useCallback(async () => {
    if (!identity) { setProfiles([]); return; }
    try {
      const list = await getMyProfiles(identity);
      setProfiles(list);
    } catch {
      setProfiles([]);
    }
  }, [identity]);

  React.useEffect(() => {
    if (tab === 'mine' && identity && p2pConfigured()) loadProfiles();
  }, [tab, identity, loadProfiles]);

  const pickRail = (rail: string) => {
    setWantRail(rail);
    // sensible currency default per rail (CNY rails quote CNY)
    if (isCnyRail(rail) && wantCurrency.trim().toUpperCase() === 'USD') setWantCurrency('CNY');
    if (!isCnyRail(rail) && wantCurrency.trim().toUpperCase() === 'CNY') setWantCurrency('USD');
  };

  const requireIdentity = (): P2pIdentity | null => {
    if (!isUnlocked || !publicInfo?.address) { setNotice({ ok: false, text: t('p2p.unlockFirst') }); return null; }
    if (!identity) { setNotice({ ok: false, text: t('p2p.unlockFirst') }); return null; }
    return identity;
  };

  const searchTokens = async (keyword: string) => {
    setGiveToken(keyword);
    if (!keyword.trim()) { setTokenResults([]); return; }
    setTokenSearching(true);
    try {
      const res = await httpService.searchExchangeTokens(keyword.trim());
      setTokenResults(res.success && res.data ? res.data : []);
    } catch (e) {
      console.error('Error searching tokens:', e);
      setTokenResults([]);
    } finally {
      setTokenSearching(false);
    }
  };

  const pickToken = (tk: TokenItem) => {
    setGiveToken(tk.tokenname || tk.tokenid.slice(0, 8));
    setTokenResults([]);
  };

  const submitOrder = async () => {
    const id = requireIdentity();
    if (!id) return;
    const hours = parseFloat(validHours);
    if (!giveToken.trim() || !giveAmount.trim() || !wantAmount.trim() || !hours || hours <= 0) {
      setNotice({ ok: false, text: t('p2p.createFailed') });
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
        wantRail,
        validUntil: Math.floor(Date.now() / 1000) + Math.floor(hours * 3600),
      });
      setGiveToken(''); setGiveAmount(''); setWantAmount('');
      setNotice({ ok: true, text: t('p2p.created') });
      setTab('mine');
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.createFailed') });
    } finally {
      setBusy(false);
    }
  };

  const submitBuy = async (order: P2pOrder) => {
    const id = requireIdentity();
    if (!id) return;
    const cny = isCnyRail(order.wantRail);
    if (!buyRecv.trim() || (!cny && !buyPaypal.trim())) { setNotice({ ok: false, text: t('p2p.buyFailed') }); return; }
    setBusy(true);
    try {
      const res = await matchOrder(id, order.orderId, {
        receiveAddress: buyRecv.trim(),
        ...(cny ? {} : { paypalAccount: buyPaypal.trim() }),
        buyerEmail: cny ? undefined : buyEmail.trim() || undefined,
      });
      setSelected(null); setBuyRecv(''); setBuyPaypal(''); setBuyEmail('');
      setNotice({ ok: true, text: `${t('p2p.buyTitle')}: ${res.swapId}` });
      setTab('mine');
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.buyFailed') });
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
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
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
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  // ── CNY rails (docs/p2pcny.md): instructions → proof → seller confirm ──

  const showInstructions = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      const ins = await fetchInstructions(id, swap.swapId);
      setInstructions((m) => ({ ...m, [swap.swapId]: ins }));
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  const submitPaid = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    const txId = (txIds[swap.swapId] ?? '').trim();
    if (!txId) { setNotice({ ok: false, text: t('p2p.errTxId') }); return; }
    setBusy(true);
    try {
      await submitProof(id, swap.swapId, { txId, ...(swap.remark ? { remark: swap.remark } : {}) });
      setTxIds((m) => ({ ...m, [swap.swapId]: '' }));
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  const confirmReceived = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await confirmPayment(id, swap.swapId);
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  const doDispute = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await openDispute(id, swap.swapId);
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  const saveProfileForm = async () => {
    const id = requireIdentity();
    if (!id) return;
    if (!profileName.trim() || !profileAccount.trim()) { setNotice({ ok: false, text: t('p2p.errProfile') }); return; }
    setBusy(true);
    try {
      await saveProfile(id, {
        method: profileMethod,
        accountName: profileName.trim(),
        account: profileAccount.trim(),
        ...(profileMethod === 'bank' && profileBank.trim() ? { bankName: profileBank.trim() } : {}),
      });
      setNotice({ ok: true, text: t('p2p.profileSaved') });
      await loadProfiles();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      setBusy(false);
    }
  };

  // Help-center PDF, published to the regional docs buckets (lib/docs.ts).
  const openGuide = () => {
    const url = p2pPdfUrl(i18n.language, tzRegion());
    Linking.openURL(url).catch(() => setNotice({ ok: false, text: t('p2p.actionFailed') }));
  };
  const guideLink = (
    <TouchableOpacity onPress={openGuide} style={s.linkBtn} testID="p2p-guide" accessibilityRole="link">
      <Text style={[s.refreshText, { color: theme.colors.primary }]}>{t('p2p.guide')}</Text>
    </TouchableOpacity>
  );

  if (!p2pConfigured()) {
    return (
      <View style={s.centered}>
        <Text style={s.emptyText} testID="p2p-not-configured">{t('p2p.notConfigured')}</Text>
        {guideLink}
      </View>
    );
  }

  const myDid = identity?.did;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={s.tabs}>
        <TabButton label={t('p2p.tabOpen')} active={tab === 'open'} onPress={() => { setNotice(null); setTab('open'); }} testID="p2p-tab-open" />
        <TabButton label={t('p2p.tabMine')} active={tab === 'mine'} onPress={() => { setNotice(null); setTab('mine'); }} testID="p2p-tab-mine" />
        <TouchableOpacity onPress={refresh} style={s.refreshBtn} testID="p2p-refresh" accessibilityRole="button">
          <Text style={[s.refreshText, { color: theme.colors.primary }]}>{t('p2p.refresh')}</Text>
        </TouchableOpacity>
        {guideLink}
      </View>

      {notice ? (
        <View
          style={[s.notice, { borderColor: notice.ok ? theme.colors.accent.emerald : theme.colors.accent.red }]}
          testID="p2p-notice"
        >
          <Text style={[s.noticeText, { color: notice.ok ? theme.colors.accent.emerald : theme.colors.accent.red }]}>
            {notice.text}
          </Text>
        </View>
      ) : null}

      {tab === 'open' ? (
        <>
          <View style={s.card}>
            <Text style={s.cardTitle}>{t('p2p.createTitle')}</Text>
            <View style={s.field}>
              <Text style={s.fieldLabel}>{t('p2p.giveToken')}</Text>
              <TextInput
                style={s.input}
                value={giveToken}
                onChangeText={searchTokens}
                placeholder="USDT"
                placeholderTextColor={theme.colors.text.secondary}
                autoCapitalize="none"
                autoCorrect={false}
                testID="p2p-give-token"
              />
              {tokenSearching ? (
                <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginTop: 8 }} />
              ) : tokenResults.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }} testID="p2p-token-results">
                  {tokenResults.map((tk, i) => (
                    <TouchableOpacity key={i} style={s.chip} onPress={() => pickToken(tk)} testID={`p2p-token-${i}`} accessibilityRole="button">
                      <Text style={s.chipText}>{tk.tokenname}</Text>
                      <Text style={s.chipSub}>{tk.tokenid.slice(0, 10)}...</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : null}
            </View>
            <Field label={t('p2p.giveAmount')} value={giveAmount} onChange={setGiveAmount} placeholder="0.00" keyboardType="decimal-pad" mono testID="p2p-give-amount" />
            <Field label={t('p2p.wantAmount')} value={wantAmount} onChange={setWantAmount} placeholder="0.00" keyboardType="decimal-pad" mono testID="p2p-want-amount" />
            <Field label={t('p2p.wantCurrency')} value={wantCurrency} onChange={setWantCurrency} placeholder="USD" testID="p2p-want-currency" />
            <Field label={t('p2p.giveChain')} value={giveChain} onChange={setGiveChain} placeholder="L0" testID="p2p-give-chain" />
            <View style={s.field}>
              <Text style={s.fieldLabel}>{t('p2p.rail')}</Text>
              <View style={s.chips}>
                {['paypal', ...CNY_RAILS].map((rail) => (
                  <TouchableOpacity
                    key={rail}
                    style={[s.chip, wantRail === rail && { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary }]}
                    onPress={() => pickRail(rail)}
                    disabled={busy}
                    testID={`p2p-rail-${rail}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: wantRail === rail }}
                  >
                    <Text style={[s.chipText, { color: wantRail === rail ? theme.colors.primary : theme.colors.text.secondary }]}>{rail}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
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
                    {!isCnyRail(o.wantRail) ? (
                      <>
                        <Field label={t('p2p.paypalAccount')} value={buyPaypal} onChange={setBuyPaypal} testID="p2p-buy-paypal" />
                        <Field label={t('p2p.paypalEmail')} value={buyEmail} onChange={setBuyEmail} keyboardType="email-address" testID="p2p-buy-email" />
                      </>
                    ) : null}
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
      ) : !isUnlocked ? (
        <WalletUnlock fullScreen={false} subtitle={t('p2p.unlockFirst')} testID="p2p-need-unlock" />
      ) : !identity ? (
        <Text style={s.emptyText} testID="p2p-need-unlock">{t('p2p.unlockFirst')}</Text>
      ) : (
        <>
          <View style={s.card} testID="p2p-profile-card">
            <Text style={s.cardTitle}>{t('p2p.profileTitle')}</Text>
            <View style={s.chips}>
              {(['wechat', 'alipay', 'bank'] as const).map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[s.chip, profileMethod === m && { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary }]}
                  onPress={() => setProfileMethod(m)}
                  disabled={busy}
                  testID={`p2p-profile-method-${m}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: profileMethod === m }}
                >
                  <Text style={[s.chipText, { color: profileMethod === m ? theme.colors.primary : theme.colors.text.secondary }]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Field label={t('p2p.profileName')} value={profileName} onChange={setProfileName} testID="p2p-profile-name" />
            <Field label={t('p2p.profileAccount')} value={profileAccount} onChange={setProfileAccount} testID="p2p-profile-account" />
            {profileMethod === 'bank' ? (
              <Field label={t('p2p.profileBank')} value={profileBank} onChange={setProfileBank} testID="p2p-profile-bank" />
            ) : null}
            <TouchableOpacity style={[s.btn, { backgroundColor: theme.colors.primary }]} onPress={saveProfileForm} disabled={busy} testID="p2p-profile-save">
              <Text style={s.btnText}>{t('p2p.profileSave')}</Text>
            </TouchableOpacity>
            {profiles.length ? <Text style={s.sub}>{profiles.map((p) => p.method).join(' · ')}</Text> : null}
          </View>

          {loading ? <ActivityIndicator color={theme.colors.primary} style={s.loader} />
            : swaps.length === 0 ? <Text style={s.emptyText}>{t('p2p.emptyMine')}</Text>
            : swaps.map((sw, i) => (
              <SwapCard
                key={sw.swapId}
                swap={sw}
                myDid={myDid}
                busy={busy}
                txHash={txHashes[sw.swapId] ?? ''}
                onTxHash={(v) => setTxHashes((m) => ({ ...m, [sw.swapId]: v }))}
                txId={txIds[sw.swapId] ?? ''}
                onTxId={(v) => setTxIds((m) => ({ ...m, [sw.swapId]: v }))}
                onLock={() => runTransition(sw, 'escrow_lock', { txHash: (txHashes[sw.swapId] ?? '').trim() })}
                onPay={() => pay(sw)}
                onExpire={() => runTransition(sw, 'expire')}
                onRefund={() => runTransition(sw, 'refund')}
                onCancel={() => runTransition(sw, 'cancel')}
                onInstructions={() => showInstructions(sw)}
                onPaid={() => submitPaid(sw)}
                onConfirm={() => confirmReceived(sw)}
                onDispute={() => doDispute(sw)}
                instruction={instructions[sw.swapId]}
                index={i}
              />
            ))}
        </>
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

function SwapCard({ swap, myDid, busy, txHash, onTxHash, txId, onTxId, onLock, onPay, onExpire, onRefund, onCancel, onInstructions, onPaid, onConfirm, onDispute, instruction, index }: {
  swap: P2pSwap; myDid?: string; busy: boolean; txHash: string; onTxHash: (v: string) => void;
  txId: string; onTxId: (v: string) => void;
  onLock: () => void; onPay: () => void; onExpire: () => void; onRefund: () => void; onCancel: () => void;
  onInstructions: () => void; onPaid: () => void; onConfirm: () => void; onDispute: () => void;
  instruction?: P2pPaymentInstructions; index: number;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const isSeller = !!myDid && swap.sellerDid === myDid;
  const isBuyer = !!myDid && swap.buyerDid === myDid;
  const isParty = isSeller || isBuyer;
  const cny = isCnyRail(swap.wantRail);
  const st = swap.status;

  return (
    <View style={s.card} testID={`p2p-swap-${index}`}>
      <View style={s.rowBetween}>
        <Text style={s.cardTitle}>{swap.giveAmount} {swap.giveToken} → {swap.wantAmount} {swap.wantCurrency}</Text>
        <Text style={[s.badge, { color: theme.colors.primary }]} testID={`p2p-swap-${index}-status`}>{st}</Text>
      </View>
      <Text style={s.subMono}>{swap.swapId}</Text>
      <Text style={s.sub}>{t('p2p.giveChain')}: {swap.giveChain ?? '-'} · {swap.wantRail ?? '-'}</Text>
      {swap.escrowAddress ? <Text style={s.sub}>{t('p2p.escrowAddress')}: {swap.escrowAddress.slice(0, 20)}…</Text> : null}
      {swap.payoutStatus ? <Text style={s.sub}>payout: {swap.payoutStatus}</Text> : null}
      {swap.paymentReversed ? <Text style={s.sub}>{swap.dispute ? `dispute ${swap.dispute}` : 'reversed'}</Text> : null}
      {swap.remark && (st === 'PAYMENT_PENDING' || st === 'PAYMENT_CLAIMED') ? (
        <Text style={s.subMono}>{t('p2p.remark')}: {swap.remark}</Text>
      ) : null}
      {swap.paymentRef && (st === 'PAYMENT_CLAIMED' || st === 'PAYMENT_VERIFIED') ? (
        <Text style={s.subMono} testID={`p2p-swap-${index}-paymentref`}>{t('p2p.txId')}: {swap.paymentRef}</Text>
      ) : null}
      {swap.dispute ? <Text style={s.sub}>{t('p2p.aDispute')}: {swap.dispute}{swap.disputeOutcome ? ` (${swap.disputeOutcome})` : ''}</Text> : null}

      {/* CNY payment instructions the buyer must transfer to (party-scoped, engine-signed). */}
      {isBuyer && instruction && (st === 'PAYMENT_PENDING' || st === 'PAYMENT_CLAIMED') ? (
        <View style={s.instructions} testID={`p2p-swap-${index}-instructions-panel`}>
          <Text style={s.instructionsTitle}>{t('p2p.instructionsTitle')}</Text>
          <Text style={s.instrLine}>{t('p2p.profileName')}: {instruction.accountName}</Text>
          <Text style={s.instrLine}>
            {instruction.bankName ? `${t('p2p.profileBank')}: ${instruction.bankName} · ` : ''}
            {t('p2p.profileAccount')}: {instruction.account}
          </Text>
          <Text style={s.instrAmount}>{instruction.amount} {instruction.currency}</Text>
          <Text style={s.instrLine}>{t('p2p.remark')}: {instruction.remark}</Text>
          <Text style={s.sub}>{t('p2p.payBy')}: {new Date(instruction.payBy * 1000).toLocaleString()}</Text>
          {instruction.qr ? <Image source={{ uri: instruction.qr }} style={s.instrQr} /> : null}
        </View>
      ) : null}

      {isSeller && (st === 'MATCHED' || st === 'ESCROW_LOCKED' || st === 'PAYMENT_PENDING' || st === 'PAYMENT_CLAIMED') ? (
        <View style={s.actions}>
          {st === 'MATCHED' ? (
            <>
              <Field label="txHash" value={txHash} onChange={onTxHash} testID={`p2p-swap-${index}-txhash`} />
              <Action label={t('p2p.aLock')} color={theme.colors.primary} onPress={onLock} disabled={busy} testID={`p2p-swap-${index}-lock`} />
            </>
          ) : null}
          {st !== 'MATCHED' ? (
            <Action label={t('p2p.aExpire')} color={theme.colors.accent.red} onPress={onExpire} disabled={busy} testID={`p2p-swap-${index}-expire`} />
          ) : null}
          {cny && st === 'PAYMENT_CLAIMED' ? (
            <>
              <Text style={s.warn} testID={`p2p-swap-${index}-confirm-warn`}>{t('p2p.confirmWarn')}</Text>
              <Action label={t('p2p.aConfirm')} color={theme.colors.accent.emerald} onPress={onConfirm} disabled={busy} testID={`p2p-swap-${index}-confirm`} />
            </>
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
          {cny ? (
            <Action label={t('p2p.aInstructions')} color={theme.colors.accent.emerald} onPress={onInstructions} disabled={busy} testID={`p2p-swap-${index}-instructions`} />
          ) : (
            <Action label={t('p2p.aPay')} color={theme.colors.accent.emerald} onPress={onPay} disabled={busy} testID={`p2p-swap-${index}-pay`} />
          )}
          <Action label={t('p2p.aCancel')} color={theme.colors.text.secondary} onPress={onCancel} disabled={busy} testID={`p2p-swap-${index}-cancel`} />
        </View>
      ) : null}

      {isBuyer && cny && st === 'PAYMENT_PENDING' ? (
        <View>
          {!instruction ? (
            <View style={s.actions}>
              <Action label={t('p2p.aInstructions')} color={theme.colors.accent.emerald} onPress={onInstructions} disabled={busy} testID={`p2p-swap-${index}-instructions`} />
            </View>
          ) : null}
          <Field label={t('p2p.txId')} value={txId} onChange={onTxId} testID={`p2p-swap-${index}-txid`} />
          <View style={s.actions}>
            <Action label={t('p2p.aPaid')} color={theme.colors.accent.emerald} onPress={onPaid} disabled={busy} testID={`p2p-swap-${index}-proof`} />
          </View>
        </View>
      ) : null}

      {isParty && (st === 'PAYMENT_PENDING' || st === 'PAYMENT_CLAIMED') ? (
        <View style={s.actions}>
          <Action label={t('p2p.aDispute')} color={theme.colors.accent.red} onPress={onDispute} disabled={busy} testID={`p2p-swap-${index}-dispute`} />
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
  linkBtn: { paddingHorizontal: 8, paddingVertical: 8 },
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
  chips: { flexDirection: 'row', gap: 8, marginTop: 4, flexWrap: 'wrap' },
  chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13, fontWeight: '600' },
  chipSub: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 2 },
  notice: { borderWidth: 1, borderRadius: 10, padding: 12, marginBottom: 12, backgroundColor: theme.colors.groupped.surface },
  noticeText: { fontSize: 13, fontWeight: '600' },
  instructions: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, marginTop: 12, backgroundColor: theme.colors.groupped.background },
  instructionsTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  instrLine: { fontSize: 13, color: theme.colors.text.primary, marginTop: 3, fontFamily: MONO_FONT },
  instrAmount: { fontSize: 17, fontWeight: '700', color: theme.colors.text.primary, marginTop: 6, fontFamily: MONO_FONT },
  instrQr: { width: 160, height: 160, marginTop: 10, alignSelf: 'center', borderRadius: 8 },
  warn: { fontSize: 12, color: theme.colors.accent.red, marginTop: 10, width: '100%' },
}));
