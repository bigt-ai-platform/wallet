import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Image, Linking,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { MONO_FONT } from '@/constants/fonts';
import { P2P_ENGINE_PUBKEYS } from '@/constants/app';
import WalletUnlock from '@/components/WalletUnlock';
import { useTransactionConfirm } from '@/components/TransactionConfirm';
import { CloseIcon, HelpIcon, SearchIcon } from '@/components/Icons';
import PhoneVerifyCard from './PhoneVerifyCard';
import { p2pPdfUrl, tzRegion } from '@/lib/docs';
import { pqDidFromKey, pqKeyFromPrivateHex, shortDid } from '@/lib/p2pIdentity';
import { exceedsBalance, findBalance, perUnitPrice, totalAmount } from '@/lib/p2pBalance';
import { checkP2pFill, filterP2pOrders } from '@/lib/p2pOrderBook';
import { buildEscrowSighash, escrowVault, signEscrow, vaultEnginePubkey, vaultMatchesAddress, type EscrowHistoryOutput } from '@/lib/p2pEscrow';
import { httpService } from '@/services/http';
import type { TokenItem, WalletAccountItem } from '@/types/api';
import {
  cancelOrder, confirmPayment, cosignEscrow, createOrder, escrowContext, fetchInstructions, getCapabilities,
  getMyProfiles, getSwap, listOpenOrders, matchOrder, mySwaps, openDispute, p2pConfigured, presignEscrow,
  saveProfile, submitProof, transition,
  type P2pAutoReleasePolicy, type P2pCapabilities, type P2pCnyRail, type P2pIdentity, type P2pOrder,
  type P2pPaymentInstructions, type P2pPaymentProfile, type P2pSwap, type P2pSwapAction,
} from '@/services/p2p';

type Tab = 'open' | 'mine';

/** Fiat rails (docs/p2p.md §7): buyer pays seller directly; seller confirms receipt. */
const CNY_RAILS: readonly string[] = ['wechat', 'alipay', 'bank'];
/** Built-in rail list — used until the engine's /capabilities report arrives. */
const DEFAULT_RAILS: readonly string[] = [...CNY_RAILS];
function isCnyRail(rail?: string): boolean {
  return !!rail && CNY_RAILS.includes(rail);
}

/**
 * P2P trading screen: a public sell-order book (buy) and the wallet's own
 * swaps (sell/list, lock, pay, expire/refund/cancel). All mutations are signed
 * with the wallet's PQ key; reads of own swaps are party-scoped by the engine.
 */
/** Reputation tier → language-neutral stars (docs/p2p.md §25). */
function tierStars(tier: 'new' | 'established' | 'trusted'): number {
  return tier === 'trusted' ? 3 : tier === 'established' ? 2 : 1;
}

export default function P2pScreen() {
  const { t, i18n } = useTranslation();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, getUnlockedWallet } = useWallet();
  const confirmImportant = useTransactionConfirm();

  const [tab, setTab] = React.useState<Tab>('open');
  const [loading, setLoading] = React.useState(true);
  const [orders, setOrders] = React.useState<P2pOrder[]>([]);
  const [swaps, setSwaps] = React.useState<P2pSwap[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [selected, setSelected] = React.useState<P2pOrder | null>(null);
  // The swap whose device-side verification ("Verify with my phone") is open.
  const [verifySwap, setVerifySwap] = React.useState<P2pSwap | null>(null);
  const [buyRecv, setBuyRecv] = React.useState('');
  // Taker's fill amount (crypto) — ≤ the order's remaining; empty = take all.
  // The fiat total is kept in sync via the order's unit price (Binance lets you
  // type either).
  const [buyFill, setBuyFill] = React.useState('');
  const [buyFillFiat, setBuyFillFiat] = React.useState('');
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

  // USDT is the market base (Binance-P2P style): sellers list USDT, buyers
  // pay fiat and receive USDT. Default fiat is CNY on the WeChat rail.
  const [giveToken, setGiveToken] = React.useState('USDT');
  // The id of the token picked from the search list, when known — the balance
  // check matches on it; a free-typed name falls back to a name match.
  const [giveTokenId, setGiveTokenId] = React.useState<string | null>(null);
  const [tokenResults, setTokenResults] = React.useState<TokenItem[]>([]);
  const [tokenSearching, setTokenSearching] = React.useState(false);
  // Advisory: the seller's balances on L0 and the active L1 chain, to warn when
  // a listing exceeds what the wallet holds (the chain only enforces this at
  // escrow_lock). Empty until it loads; never blocks on an unknown balance.
  const [l0Balances, setL0Balances] = React.useState<WalletAccountItem[]>([]);
  const [l1Balances, setL1Balances] = React.useState<WalletAccountItem[]>([]);
  const [giveAmount, setGiveAmount] = React.useState('');
  const [giveChain, setGiveChain] = React.useState('L0');
  // Order side: `sell` (default) or `buy` (a bid the taker fills). A buy bid
  // carries where the poster wants the tokens delivered.
  const [orderSide, setOrderSide] = React.useState<'sell' | 'buy'>('sell');
  const [buyReceive, setBuyReceive] = React.useState('');
  const [wantCurrency, setWantCurrency] = React.useState('CNY');
  const [wantAmount, setWantAmount] = React.useState('');
  // Binance-style ad fields: unit price (the Total is derived), per-order fiat
  // limit, payment window and free-text terms.
  const [wantPrice, setWantPrice] = React.useState('');
  const [minOrder, setMinOrder] = React.useState('');
  const [maxOrder, setMaxOrder] = React.useState('');
  const [timeLimit, setTimeLimit] = React.useState('15');
  const [remarks, setRemarks] = React.useState('');
  // Book side filter (Binance's Buy/Sell tabs): the Buy tab lists sell ads you
  // can take; the Sell tab lists buy ads (bids) you can fill.
  const [bookSide, setBookSide] = React.useState<'buy' | 'sell'>('buy');
  const [bookQuery, setBookQuery] = React.useState('');
  const sideOrders = filterP2pOrders(orders, bookSide, '');
  const visibleOrders = filterP2pOrders(sideOrders, bookSide, bookQuery);
  const [validHours, setValidHours] = React.useState('24');
  const [wantRail, setWantRail] = React.useState('wechat');
  // Enabled payment methods (Binance multi-rail); `wantRail` stays the primary.
  const [rails, setRails] = React.useState<string[]>(['wechat']);
  // The taker's chosen method for the selected order (defaults to the ad's first).
  const [chosenRail, setChosenRail] = React.useState('');
  // What this engine actually serves (GET /capabilities): the enabled CNY
  // rails (empty → DEFAULT_RAILS, older engine, see p2p.ts).
  const [caps, setCaps] = React.useState<P2pCapabilities | null>(null);
  const enabledRails: readonly string[] = caps ? caps.rails : DEFAULT_RAILS;

  // Advisory availability for the sell form: compare `giveAmount` against the
  // seller's balance on `giveChain` (L0 vs the active L1). Unknown balance → no
  // warning (the chain enforces it at escrow_lock, not here).
  const availOnL0 = (giveChain.trim().toUpperCase() || 'L0') === 'L0';
  const availItem = findBalance(availOnL0 ? l0Balances : l1Balances, { tokenId: giveTokenId, tokenName: giveToken });
  const availText = availItem ? `${availItem.balance} ${availItem.tokenname}` : '';
  // A seller must hold the token; a buyer pays fiat (an unfunded buyer is fine).
  const overBalance = orderSide === 'sell' && exceedsBalance(giveAmount, availItem);
  // `wantAmount` (the TOTAL fiat, what the instructions charge) is derived from
  // the Binance-style unit **price** × the crypto amount.
  const formTotal = totalAmount(wantPrice, giveAmount);

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

  // Advisory balances for the sell form (L0 + the active L1 chain, matching the
  // `giveChain` field). Best-effort: a failure leaves the lists empty and the
  // check simply never fires.
  const loadBalances = React.useCallback(async () => {
    const unlocked = getUnlockedWallet();
    if (!isUnlocked || !unlocked) { setL0Balances([]); setL1Balances([]); return; }
    const pk = unlocked.wallet.privateKey;
    const kt = unlocked.wallet.keyType;
    const l1Url = httpService.getL1Url();
    const l1Base = httpService.l1Bases(l1Url)[0] ?? l1Url;
    const [l0, l1] = await Promise.all([
      httpService.getBalances(pk, kt).catch(() => null),
      httpService.getBalancesOn(l1Base, pk, kt).catch(() => null),
    ]);
    setL0Balances(l0?.success && l0.data ? l0.data : []);
    setL1Balances(l1?.success && l1.data ? l1.data : []);
  }, [isUnlocked, getUnlockedWallet]);

  React.useEffect(() => { loadBalances(); }, [loadBalances]);

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
    // Advisory balances (may be slow — no L0/L1, or slow discovery): refresh
    // them off the critical path so the order/swap list is never blocked.
    void loadBalances();
  }, [tab, loadOrders, loadSwaps, loadBalances]);

  React.useEffect(() => { refresh(); }, [refresh]);

  // Capability report (public, unsigned) once at mount. getCapabilities()
  // resolves null rather than throwing, so an older engine without
  // /capabilities keeps the screen exactly as before.
  React.useEffect(() => {
    let alive = true;
    getCapabilities().then((c) => {
      if (alive) setCaps(c);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Collection methods are per-rail: an engine with SETTLEMENT_CNY_RAILS set
  // must not offer a method it would reject (profile chips + default pick).
  const enabledProfileMethods = React.useMemo<P2pCnyRail[]>(
    () => (CNY_RAILS as readonly P2pCnyRail[]).filter((m) => enabledRails.includes(m)),
    [enabledRails],
  );
  React.useEffect(() => {
    if (caps && caps.rails.length > 0) {
      if (!caps.rails.includes(wantRail)) setWantRail(caps.rails[0]);
      setRails((cur) => {
        const filtered = cur.filter((r) => caps.rails.includes(r));
        return filtered.length ? filtered : [caps.rails[0]];
      });
    }
    if (caps && enabledProfileMethods.length > 0 && !enabledProfileMethods.includes(profileMethod)) {
      setProfileMethod(enabledProfileMethods[0]);
    }
  }, [caps, wantRail, profileMethod, enabledProfileMethods]);

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
    // Multi-select: toggle the method; never allow an empty set.
    setRails((cur) => {
      const next = cur.includes(rail) ? (cur.length > 1 ? cur.filter((r) => r !== rail) : cur) : [...cur, rail];
      setWantRail(next[0] ?? rail);
      return next;
    });
    // sensible currency default: the CNY rails quote CNY
    if (wantCurrency.trim().toUpperCase() === 'USD') setWantCurrency('CNY');
  };

  const requireIdentity = (): P2pIdentity | null => {
    if (!isUnlocked || !publicInfo?.address) { setNotice({ ok: false, text: t('p2p.unlockFirst') }); return null; }
    if (!identity) { setNotice({ ok: false, text: t('p2p.unlockFirst') }); return null; }
    return identity;
  };

  const searchTokens = async (keyword: string) => {
    setGiveToken(keyword);
    setGiveTokenId(null);
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
    setGiveTokenId(tk.tokenid);
    setTokenResults([]);
  };

  const submitOrder = async () => {
    const id = requireIdentity();
    if (!id) return;
    const hours = parseFloat(validHours);
    if (!giveToken.trim() || !giveAmount.trim() || !wantPrice.trim() || !formTotal || !hours || hours <= 0) {
      setNotice({ ok: false, text: t('p2p.createFailed') });
      return;
    }
    // A buy bid must say where the tokens go; default to this wallet.
    const isBuy = orderSide === 'buy';
    const recv = buyReceive.trim() || publicInfo?.address || '';
    if (isBuy && !recv) {
      setNotice({ ok: false, text: t('p2p.buyFailed') });
      return;
    }
    // Advisory: don't list more than the wallet holds on `giveChain` (the chain
    // would only reject it later, at escrow_lock). Non-blocking when unknown.
    if (overBalance) {
      setNotice({ ok: false, text: t('p2p.overBalance', { amount: availText }) });
      return;
    }
    // Important transaction (signs with the wallet key): device unlock first.
    const approved = await confirmImportant({
      subtitle: t('p2p.createTitle'),
      reason: `${giveAmount} ${giveToken} → ${wantAmount} ${wantCurrency}`,
    });
    if (!approved) { setNotice({ ok: false, text: t('confirm.cancelled') }); return; }
    setBusy(true);
    try {
      await createOrder(id, {
        type: isBuy ? 'limit_buy' : 'limit_sell',
        giveToken: giveToken.trim(),
        giveAmount: giveAmount.trim(),
        giveChain: giveChain.trim() || 'L0',
        wantCurrency: wantCurrency.trim() || 'CNY',
        wantAmount: formTotal ?? '',
        wantRail: rails[0] ?? 'wechat',
        wantRails: rails,
        validUntil: Math.floor(Date.now() / 1000) + Math.floor(hours * 3600),
        ...(isBuy ? { receiveAddress: recv } : {}),
        ...(minOrder.trim() ? { minOrder: minOrder.trim() } : {}),
        ...(maxOrder.trim() ? { maxOrder: maxOrder.trim() } : {}),
        ...(Number(timeLimit) > 0 ? { timeLimit: Math.floor(Number(timeLimit)) } : {}),
        ...(remarks.trim() ? { remarks: remarks.trim() } : {}),
        // pin the order to the escrow key we will settle against (§26)
        ...((caps?.escrowPubkey || P2P_ENGINE_PUBKEYS[0])
          ? { enginePubkey: caps?.escrowPubkey || P2P_ENGINE_PUBKEYS[0] }
          : {}),
      });
      setGiveToken('USDT'); setGiveAmount(''); setWantAmount(''); setWantPrice('');
      setMinOrder(''); setMaxOrder(''); setRemarks('');
      setGiveTokenId(null);
      setNotice({ ok: true, text: t('p2p.created') });
      setTab('mine');
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.createFailed') });
    } finally {
      setBusy(false);
    }
  };

  const fillError = (check: ReturnType<typeof checkP2pFill>, order: P2pOrder) =>
    check.ok ? '' : t(`p2pFill.${check.reason}`, { limit: check.limit, token: order.giveToken, currency: order.wantCurrency });

  const submitBuy = async (order: P2pOrder) => {
    const fill = checkP2pFill(order, buyFill);
    if (!fill.ok) { setNotice({ ok: false, text: fillError(fill, order) }); return; }
    const id = requireIdentity();
    if (!id) return;
    const cny = isCnyRail(order.wantRail);
    // A `limit_buy` bid is filled by a seller: no receive address is asked (the
    // poster's is used). A `limit_sell` is taken by a buyer, who gives theirs.
    const isBid = order.type === 'limit_buy';
    if (!cny || (!isBid && !buyRecv.trim())) { setNotice({ ok: false, text: t('p2p.buyFailed') }); return; }
    // Important transaction (signs with the wallet key): device unlock first.
    const summary = t('p2pFill.preview', { amount: fill.fill, token: order.giveToken, fiat: fill.fiat, currency: order.wantCurrency });
    const approved = await confirmImportant({
      subtitle: `${isBid ? t('order.sell') : t('p2p.buy')}: ${summary}`,
      reason: summary,
    });
    if (!approved) { setNotice({ ok: false, text: t('confirm.cancelled') }); return; }
    setBusy(true);
    try {
      const res = await matchOrder(id, order.orderId, {
        receiveAddress: isBid ? '' : buyRecv.trim(),
        fillAmount: fill.fill,
        ...(chosenRail ? { rail: chosenRail } : {}),
      });
      setSelected(null); setBuyRecv(''); setBuyFill(''); setBuyFillFiat(''); setChosenRail('');
      setNotice({ ok: true, text: `${t('p2p.buyTitle')}: ${res.swapId}` });
      setTab('mine');
      await loadSwaps();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.buyFailed') });
    } finally {
      setBusy(false);
    }
  };

  const submitCancel = async (order: P2pOrder) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await cancelOrder(id, order.orderId);
      setSelected(null);
      setNotice({ ok: true, text: t('p2p.cancelled') });
      await loadOrders();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.cancelOrderFailed') });
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

  // ── Escrow settlement closure (docs/p2p.md) ───────────────────────────────
  // The wallet rebuilds the exact spend skeleton the engine will rebuild
  // (same vault, same confirmed lock output, same fee rule) and signs its
  // sighash: the seller pre-signs both paths at lock (arming the auto-settle
  // hook), then either party co-signs a live release/refund.

  const escrowSighashFor = async (swap: P2pSwap, toBase58: string) => {
    // Prefer the pinned key (docs/p2p.md §26) so settlement does not depend on
    // the engine's /capabilities report; reject a pin not in the trusted engine
    // set (docs/p2p.md §27.4 #1). Falls back to the configured engine's key.
    const pubkey = vaultEnginePubkey(swap.enginePubkey, caps?.escrowPubkey, P2P_ENGINE_PUBKEYS);
    if (!pubkey) throw new Error('escrow key rejected (not a trusted enginePubkey) or missing');
    if (!swap.escrowAddress || !swap.escrowTxHash) throw new Error('swap has no locked escrow');
    const vault = escrowVault(swap.sellerDid, swap.buyerDid, pubkey);
    if (!vault) throw new Error('escrow vault unavailable (non-PQ party key)');
    // Guard against a substituted engine key: the vault we derive must hash to
    // the recorded escrow address, or we refuse to sign (docs/p2p.md §26.7).
    if (!vaultMatchesAddress(vault, swap.escrowAddress)) {
      throw new Error('escrow address does not match the vault key (enginePubkey mismatch)');
    }
    const res = await httpService.getOutputsHistory({ toAddress: swap.escrowAddress });
    if (!res.success || !res.data) throw new Error(res.error || 'could not read the escrow output');
    const skel = buildEscrowSighash({
      vault,
      outputs: res.data as unknown as EscrowHistoryOutput[],
      escrowAddress: swap.escrowAddress,
      escrowTxHash: swap.escrowTxHash,
      toBase58,
    });
    if (!skel) throw new Error('escrow output not found (lock unconfirmed or already spent)');
    return skel;
  };

  /** Seller: sign the release + refund skeletons over the fresh lock outpoint. */
  const presignSwap = async (id: P2pIdentity, swap: P2pSwap): Promise<void> => {
    const refundAddress = publicInfo?.address;
    if (!refundAddress) throw new Error(t('p2p.unlockFirst'));
    const ctx = await escrowContext(id, swap.swapId);
    const release = await escrowSighashFor(swap, ctx.receiveAddress);
    const refund = await escrowSighashFor(swap, refundAddress);
    await presignEscrow(id, swap.swapId, {
      releaseSig: signEscrow(id.key, release.sighash),
      refundSig: signEscrow(id.key, refund.sighash),
      refundAddress,
    });
  };

  const reload = async () => {
    try { await loadSwaps(); } catch { /* keep the last list on a refresh failure */ }
  };

  /** escrow_lock, then arm the hook when this engine has a chain client. */
  const lockAndPresign = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await transition(id, swap.swapId, 'escrow_lock', { txHash: (txHashes[swap.swapId] ?? '').trim() });
      if (caps?.chain?.l0) {
        const fresh = await getSwap(id, swap.swapId);
        await presignSwap(id, fresh);
        setNotice({ ok: true, text: t('p2p.presignOk') });
      }
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const presignNow = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      await presignSwap(id, swap);
      setNotice({ ok: true, text: t('p2p.presignOk') });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      await reload();
      setBusy(false);
    }
  };

  /** Path A: the wallet's live signature over the release skeleton (engine adds its key). */
  const releaseEscrow = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    setBusy(true);
    try {
      const ctx = await escrowContext(id, swap.swapId);
      if (!ctx.receiveAddress) throw new Error('swap has no receive address');
      const skel = await escrowSighashFor(swap, ctx.receiveAddress);
      const res = await cosignEscrow(id, swap.swapId, { kind: 'release', sig: signEscrow(id.key, skel.sighash) });
      setNotice({ ok: true, text: res.txHash ? `${t('p2p.releaseOk')} (${res.txHash.slice(0, 12)}…)` : t('p2p.releaseOk') });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      await reload();
      setBusy(false);
    }
  };

  /** Path A refund: the seller's signature over the refund skeleton (pays this wallet). */
  const refundEscrow = async (swap: P2pSwap) => {
    const id = requireIdentity();
    if (!id) return;
    const refundAddress = publicInfo?.address;
    if (!refundAddress) { setNotice({ ok: false, text: t('p2p.unlockFirst') }); return; }
    setBusy(true);
    try {
      const skel = await escrowSighashFor(swap, refundAddress);
      const res = await cosignEscrow(id, swap.swapId, {
        kind: 'refund', sig: signEscrow(id.key, skel.sighash), refundAddress,
      });
      setNotice({ ok: true, text: res.txHash ? `${t('p2p.refundOk')} (${res.txHash.slice(0, 12)}…)` : t('p2p.refundOk') });
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : t('p2p.actionFailed') });
    } finally {
      await reload();
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
  /** Copy a full value (a PQ did is ~2.6 KB; the cards show a short form). */
  const copyValue = async (v: string) => {
    try {
      await Clipboard.setStringAsync(v);
      setNotice({ ok: true, text: t('receive.copiedAddress') });
    } catch {
      setNotice({ ok: false, text: t('p2p.actionFailed') });
    }
  };
  // Header control: a compact "?" help symbol linking to the P2P guide PDF.
  const guideLink = (
    <TouchableOpacity
      onPress={openGuide}
      style={s.linkBtn}
      testID="p2p-guide"
      accessibilityRole="link"
      accessibilityLabel={t('p2p.guide')}
    >
      <HelpIcon size={20} color={theme.colors.primary} />
    </TouchableOpacity>
  );
  // First-run / empty state: keep the label beside the icon for discoverability.
  const guideLinkWithLabel = (
    <TouchableOpacity
      onPress={openGuide}
      style={s.guideRow}
      testID="p2p-guide"
      accessibilityRole="link"
      accessibilityLabel={t('p2p.guide')}
    >
      <HelpIcon size={20} color={theme.colors.primary} />
      <Text style={[s.refreshText, { color: theme.colors.primary }]}>{t('p2p.guide')}</Text>
    </TouchableOpacity>
  );

  if (!p2pConfigured()) {
    return (
      <View style={s.centered}>
        <Text style={s.emptyText} testID="p2p-not-configured">{t('p2p.notConfigured')}</Text>
        {guideLinkWithLabel}
      </View>
    );
  }

  const myDid = identity?.did;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
      <View style={s.tabs}>
        <TabButton label={t('order.buy')} active={tab === 'open' && bookSide === 'buy'} onPress={() => { setNotice(null); setTab('open'); setBookSide('buy'); }} testID="p2p-tab-open" />
        <TabButton label={t('order.sell')} active={tab === 'open' && bookSide === 'sell'} onPress={() => { setNotice(null); setTab('open'); setBookSide('sell'); }} testID="p2p-tab-sell" />
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
            <View style={s.chips} testID="p2p-order-side">
              {(['sell', 'buy'] as const).map((side) => (
                <TouchableOpacity
                  key={side}
                  style={[s.chip, orderSide === side && { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary }]}
                  onPress={() => {
                    setOrderSide(side);
                    if (side === 'buy' && !buyReceive.trim()) setBuyReceive(publicInfo?.address ?? '');
                  }}
                  disabled={busy}
                  testID={`p2p-side-${side}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected: orderSide === side }}
                >
                  <Text style={[s.chipText, { color: orderSide === side ? theme.colors.primary : theme.colors.text.secondary }]}>
                    {side === 'buy' ? t('order.buy') : t('order.sell')}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
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
            {orderSide === 'sell' && (availItem || overBalance) ? (
              <Text style={[s.hint, overBalance && { color: theme.colors.accent.red }]} testID="p2p-give-available">
                {overBalance
                  ? t('p2p.overBalance', { amount: availText })
                  : t('p2p.available', { amount: availText })}
              </Text>
            ) : null}
            <Field label={t('p2p.price')} value={wantPrice} onChange={setWantPrice} placeholder="0.00" keyboardType="decimal-pad" mono testID="p2p-want-amount" />
            {formTotal ? (
              <Text style={s.hint} testID="p2p-total">
                {t('p2p.total')}: {formTotal} {wantCurrency.trim() || 'CNY'}
              </Text>
            ) : null}
            <Field label={t('p2p.wantCurrency')} value={wantCurrency} onChange={setWantCurrency} placeholder="CNY" testID="p2p-want-currency" />
            <Field label={t('p2p.giveChain')} value={giveChain} onChange={setGiveChain} placeholder="L0" testID="p2p-give-chain" />
            <View style={s.field}>
              <Text style={s.fieldLabel}>{t('p2p.rail')}</Text>
              <View style={s.chips}>
                {enabledRails.map((rail) => (
                  <TouchableOpacity
                    key={rail}
                    style={[s.chip, rails.includes(rail) && { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary }]}
                    onPress={() => pickRail(rail)}
                    disabled={busy}
                    testID={`p2p-rail-${rail}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: rails.includes(rail) }}
                  >
                    <Text style={[s.chipText, { color: rails.includes(rail) ? theme.colors.primary : theme.colors.text.secondary }]}>{rail}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <Field label={t('p2p.minOrder')} value={minOrder} onChange={setMinOrder} placeholder="0" keyboardType="decimal-pad" mono testID="p2p-min-order" />
            <Field label={t('p2p.maxOrder')} value={maxOrder} onChange={setMaxOrder} placeholder={formTotal ?? '0'} keyboardType="decimal-pad" mono testID="p2p-max-order" />
            <Field label={t('p2p.timeLimit')} value={timeLimit} onChange={setTimeLimit} placeholder="15" keyboardType="decimal-pad" mono testID="p2p-time-limit" />
            <Field label={t('p2p.remarks')} value={remarks} onChange={setRemarks} placeholder="" testID="p2p-remarks" />
            {orderSide === 'buy' ? (
              <Field
                label={t('p2p.receiveAddress')}
                value={buyReceive}
                onChange={setBuyReceive}
                placeholder={publicInfo?.address ?? ''}
                testID="p2p-create-recv"
              />
            ) : null}
            <TouchableOpacity style={[s.btn, { backgroundColor: theme.colors.primary }]} onPress={submitOrder} disabled={busy || overBalance} testID="p2p-create">
              <Text style={s.btnText}>{t('p2p.create')}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.bookToolbar}>
            <Text style={s.fieldLabel}>{t('p2pBook.search')}</Text>
            <View style={s.bookSearchRow}>
              <SearchIcon size={18} color={theme.colors.text.secondary} />
              <TextInput
                style={[s.input, s.bookSearchInput]}
                value={bookQuery}
                onChangeText={(value) => { setBookQuery(value); setSelected(null); }}
                placeholder="USDT CNY WeChat"
                placeholderTextColor={theme.colors.text.secondary}
                accessibilityLabel={t('p2pBook.search')}
                autoCapitalize="none"
                autoCorrect={false}
                testID="p2p-book-search"
              />
              <TouchableOpacity
                style={s.bookClear}
                onPress={() => { setBookQuery(''); setSelected(null); }}
                disabled={!bookQuery}
                accessibilityRole="button"
                accessibilityLabel={t('p2pBook.clear')}
                accessibilityState={{ disabled: !bookQuery }}
                testID="p2p-book-clear"
              >
                <CloseIcon size={18} color={bookQuery ? theme.colors.text.primary : theme.colors.text.secondary} />
              </TouchableOpacity>
            </View>
            {!loading ? (
              <Text style={s.sub} accessibilityLiveRegion="polite" testID="p2p-book-count">
                {t('p2pBook.count', { shown: visibleOrders.length, total: sideOrders.length })}
              </Text>
            ) : null}
          </View>
          {loading ? <ActivityIndicator color={theme.colors.primary} style={s.loader} />
            : visibleOrders.length === 0 ? <Text style={s.emptyText} testID="p2p-book-empty">{bookQuery.trim() ? t('tokens.noMatches') : bookSide === 'buy' ? t('p2p.emptyOpen') : t('p2pBook.emptyBuy')}</Text>
            : visibleOrders.map((o, i) => {
              const unit = perUnitPrice(o.wantAmount, o.giveAmount);
              const fill = checkP2pFill(o, buyFill);
              const fundsBad = o.funds?.checked === true && !o.funds.sufficient;
              const fundsText = o.funds
                ? o.funds.checked
                  ? o.funds.sufficient
                    ? t('p2p.fundsVerified')
                    : t('p2p.fundsMissing')
                  : t('p2p.fundsUnverified')
                : null;
              return (
              <View key={o.orderId} style={s.card} testID={`p2p-order-${i}`}>
                <View style={s.rowBetween}>
                  <Text style={s.cardTitle} testID={`p2p-order-${i}-side`}>
                    {o.type === 'limit_buy' ? `${t('order.buy')} ` : `${t('order.sell')} `}{o.giveAmount} {o.giveToken}
                  </Text>
                  {unit ? (
                    <Text style={s.mono} testID={`p2p-order-${i}-unit`}>{unit} {o.wantCurrency}</Text>
                  ) : null}
                </View>
                <Text style={s.sub} testID={`p2p-order-${i}-limit`}>
                  {t('p2p.advertised', { amount: `${o.remainingGive ?? o.giveAmount} ${o.giveToken}` })} · {t('p2p.limit')}: {o.minOrder || '0'}–{o.maxOrder || o.wantAmount} {o.wantCurrency} · {t('p2p.rail')}: {(o.wantRails?.length ? o.wantRails : [o.wantRail]).join(', ')}
                </Text>
                {fundsText ? (
                  <Text
                    style={[s.sub, { color: fundsBad ? theme.colors.accent.red : o.funds?.checked ? theme.colors.accent.emerald : theme.colors.text.secondary }]}
                    testID={`p2p-order-${i}-funds`}
                  >
                    {fundsText}
                  </Text>
                ) : null}
                <Text style={s.sub} testID={`p2p-order-${i}-total`}>
                  {t('p2p.total')}: {o.wantAmount} {o.wantCurrency} · {t('p2p.giveChain')}: {o.giveChain}{o.timeLimit ? ` · ${o.timeLimit} min` : ''}
                </Text>
                {o.remarks ? <Text style={s.subMono} testID={`p2p-order-${i}-remarks`}>{o.remarks}</Text> : null}
                <View style={s.didRow}>
                  <Text style={[s.subMono, s.didText]} testID={`p2p-order-${i}-did`}>{shortDid(o.sellerDid)}</Text>
                  <TouchableOpacity
                    onPress={() => copyValue(o.sellerDid)}
                    style={s.copyBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t('receive.copy')}
                    testID={`p2p-order-${i}-copy-did`}
                  >
                    <Text style={s.copyText}>{t('receive.copy')}</Text>
                  </TouchableOpacity>
                </View>
                {o.sellerReputation ? (
                  <Text style={s.sub} testID={`p2p-order-${i}-rep`}>
                    {'★'.repeat(tierStars(o.sellerReputation.tier))}
                    {'☆'.repeat(3 - tierStars(o.sellerReputation.tier))}{' '}
                    {t('p2p.rep', {
                      trades30d: o.sellerReputation.trades30d,
                      trades: o.sellerReputation.trades,
                      pct: Math.round(o.sellerReputation.completionRate * 100),
                    })}
                  </Text>
                ) : null}
                {identity && o.sellerDid === identity.did && o.status === 'ACTIVE' ? (
                  <View style={s.actions}>
                    <Action label={t('p2p.cancelOrder')} color={theme.colors.accent.red} onPress={() => submitCancel(o)} disabled={busy} testID={`p2p-cancel-order-${i}`} />
                  </View>
                ) : null}
                {selected?.orderId === o.orderId ? (
                  <View style={s.buyPanel}>
                    <Field
                      label={t('p2p.giveAmount')}
                      value={buyFill}
                      onChange={(v) => {
                        setBuyFill(v);
                        const unit = Number(o.wantAmount) / Number(o.giveAmount);
                        setBuyFillFiat(unit > 0 && Number(v) > 0 ? String(Number((Number(v) * unit).toFixed(8))) : '');
                      }}
                      placeholder={o.remainingGive ?? o.giveAmount}
                      keyboardType="decimal-pad" mono testID="p2p-buy-fill"
                    />
                    <Field
                      label={t('p2p.total')}
                      value={buyFillFiat}
                      onChange={(v) => {
                        setBuyFillFiat(v);
                        const unit = Number(o.wantAmount) / Number(o.giveAmount);
                        setBuyFill(unit > 0 && Number(v) > 0 ? String(Number((Number(v) / unit).toFixed(8))) : v);
                      }}
                      placeholder={o.wantAmount}
                      keyboardType="decimal-pad" mono testID="p2p-buy-fill-fiat"
                    />
                    {o.type !== 'limit_buy' ? (
                      <Field label={t('p2p.receiveAddress')} value={buyRecv} onChange={setBuyRecv} testID="p2p-buy-recv" />
                    ) : null}
                    {(o.wantRails?.length ?? 0) > 1 ? (
                      <View style={s.field}>
                        <Text style={s.fieldLabel}>{t('p2p.rail')}</Text>
                        <View style={s.chips}>
                          {(o.wantRails ?? [o.wantRail]).map((rail) => (
                            <TouchableOpacity
                              key={rail}
                              style={[s.chip, chosenRail === rail && { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary }]}
                              onPress={() => setChosenRail(rail)}
                              testID={`p2p-buy-rail-${rail}`}
                              accessibilityRole="button"
                              accessibilityState={{ selected: chosenRail === rail }}
                            >
                              <Text style={[s.chipText, { color: chosenRail === rail ? theme.colors.primary : theme.colors.text.secondary }]}>{rail}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    ) : null}
                    <Text
                      style={[s.sub, !fill.ok && { color: theme.colors.accent.red }]}
                      accessibilityLiveRegion="polite"
                      testID="p2p-fill-feedback"
                    >
                      {fill.ok ? t('p2pFill.preview', { amount: fill.fill, token: o.giveToken, fiat: fill.fiat, currency: o.wantCurrency }) : fillError(fill, o)}
                    </Text>
                    <TouchableOpacity
                      style={[s.btn, { backgroundColor: theme.colors.accent.emerald, opacity: busy || !fill.ok || fundsBad ? 0.5 : 1 }]}
                      onPress={() => submitBuy(o)} disabled={busy || !fill.ok || fundsBad}
                      accessibilityRole="button" accessibilityState={{ disabled: busy || !fill.ok || fundsBad }}
                      testID="p2p-buy-confirm"
                    >
                      <Text style={s.btnText}>{o.type === 'limit_buy' ? t('order.sell') : t('p2p.buy')}</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  <TouchableOpacity style={[s.btn, { backgroundColor: theme.colors.accent.emerald, opacity: fundsBad ? 0.5 : 1 }]} onPress={() => {
                    setSelected(o); setBuyRecv('');
                    setChosenRail(o.wantRails?.[0] ?? o.wantRail);
                    const rem = o.remainingGive ?? o.giveAmount;
                    setBuyFill(rem);
                    const unit = Number(o.wantAmount) / Number(o.giveAmount);
                    setBuyFillFiat(unit > 0 ? String(Number((Number(rem) * unit).toFixed(8))) : '');
                  }} disabled={fundsBad} accessibilityRole="button" accessibilityState={{ disabled: fundsBad }} testID={`p2p-buy-${i}`}>
                    <Text style={s.btnText}>{o.type === 'limit_buy' ? t('order.sell') : t('p2p.buy')}</Text>
                  </TouchableOpacity>
                )}
              </View>
              );
            })}
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
              {enabledProfileMethods.map((m) => (
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

          {verifySwap && identity ? (
            <PhoneVerifyCard
              id={identity}
              swap={verifySwap}
              autoReleaseOn={caps?.autoReleaseOn ?? 'off'}
              onStatus={(text) => setNotice({ ok: true, text })}
              onClose={() => setVerifySwap(null)}
              onDone={() => { setVerifySwap(null); void reload(); }}
            />
          ) : null}

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
                onLock={() => lockAndPresign(sw)}
                onExpire={() => runTransition(sw, 'expire')}
                onRefund={() => refundEscrow(sw)}
                onRelease={() => releaseEscrow(sw)}
                onPresign={() => presignNow(sw)}
                onCancel={() => runTransition(sw, 'cancel')}
                onInstructions={() => showInstructions(sw)}
                onPaid={() => submitPaid(sw)}
                onConfirm={() => confirmReceived(sw)}
                onDispute={() => doDispute(sw)}
                onVerify={() => setVerifySwap(sw)}
                instruction={instructions[sw.swapId]}
                index={i}
                autoReleaseOn={caps?.autoReleaseOn ?? 'off'}
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

function SwapCard({ swap, myDid, busy, txHash, onTxHash, txId, onTxId, onLock, onExpire, onRefund, onRelease, onPresign, onCancel, onInstructions, onPaid, onConfirm, onDispute, onVerify, instruction, index, autoReleaseOn }: {
  swap: P2pSwap; myDid?: string; busy: boolean; txHash: string; onTxHash: (v: string) => void;
  txId: string; onTxId: (v: string) => void;
  onLock: () => void; onExpire: () => void; onRefund: () => void;
  onRelease: () => void; onPresign: () => void; onCancel: () => void;
  onInstructions: () => void; onPaid: () => void; onConfirm: () => void; onDispute: () => void;
  onVerify: () => void;
  instruction?: P2pPaymentInstructions; index: number; autoReleaseOn: P2pAutoReleasePolicy;
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
      {swap.remark && (st === 'PAYMENT_PENDING' || st === 'PAYMENT_CLAIMED') ? (
        <Text style={s.subMono}>{t('p2p.remark')}: {swap.remark}</Text>
      ) : null}
      {swap.dispute ? <Text style={s.sub}>{t('p2p.aDispute')}: {swap.dispute}{swap.disputeOutcome ? ` (${swap.disputeOutcome})` : ''}</Text> : null}
      {isSeller && swap.presigned ? (
        <Text style={s.sub} testID={`p2p-swap-${index}-presigned`}>{t('p2p.presigned')}</Text>
      ) : null}

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
          {st !== 'MATCHED' && !swap.presigned ? (
            <Action label={t('p2p.aPresign')} color={theme.colors.primary} onPress={onPresign} disabled={busy} testID={`p2p-swap-${index}-presign`} />
          ) : null}
          {st === 'ESCROW_LOCKED' || st === 'PAYMENT_PENDING' ? (
            <Action label={t('p2p.aExpire')} color={theme.colors.accent.red} onPress={onExpire} disabled={busy} testID={`p2p-swap-${index}-expire`} />
          ) : null}
          {cny && st === 'PAYMENT_CLAIMED' ? (
            <>
              <Text style={s.warn} testID={`p2p-swap-${index}-confirm-warn`}>{t('p2p.confirmWarn')}</Text>
              <Action label={t('p2p.aConfirm')} color={theme.colors.accent.emerald} onPress={onConfirm} disabled={busy} testID={`p2p-swap-${index}-confirm`} />
            </>
          ) : null}
          {st === 'MATCHED' || st === 'ESCROW_LOCKED' ? (
            <Action label={t('p2p.aCancel')} color={theme.colors.text.secondary} onPress={onCancel} disabled={busy} testID={`p2p-swap-${index}-cancel`} />
          ) : null}
        </View>
      ) : null}

      {isSeller && st === 'EXPIRED' ? (
        <View style={s.actions}>
          <Action label={t('p2p.aRefund')} color={theme.colors.accent.red} onPress={onRefund} disabled={busy} testID={`p2p-swap-${index}-refund`} />
        </View>
      ) : null}

      {isBuyer && st === 'ESCROW_LOCKED' ? (
        <View style={s.actions}>
          <Action label={t('p2p.aInstructions')} color={theme.colors.accent.emerald} onPress={onInstructions} disabled={busy} testID={`p2p-swap-${index}-instructions`} />
          <Action label={t('p2p.aCancel')} color={theme.colors.text.secondary} onPress={onCancel} disabled={busy} testID={`p2p-swap-${index}-cancel`} />
        </View>
      ) : null}

      {/* Before a claim the buyer ("I never paid") may still walk away. */}
      {isBuyer && st === 'PAYMENT_PENDING' ? (
        <View style={s.actions}>
          <Action label={t('p2p.aCancel')} color={theme.colors.text.secondary} onPress={onCancel} disabled={busy} testID={`p2p-swap-${index}-cancel`} />
        </View>
      ) : null}

      {/* Settlement closure: either party co-signs the release once fiat is verified. */}
      {isParty && st === 'PAYMENT_VERIFIED' ? (
        <View style={s.actions}>
          <Action label={t('p2p.aRelease')} color={theme.colors.accent.emerald} onPress={onRelease} disabled={busy} testID={`p2p-swap-${index}-release`} />
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

      {/* Device-side verification (docs/p2p.md §12): read this party's own rail
          app through the phone they paired, then sign and submit the verdict. */}
      {isParty && cny && (st === 'PAYMENT_PENDING' || st === 'PAYMENT_CLAIMED') ? (
        <>
          <View style={s.actions}>
            <Action label={t('p2pdev.title')} color={theme.colors.accent.purple} onPress={onVerify} disabled={busy} testID={`p2p-swap-${index}-verify`} />
          </View>
          {/* The auto-release policy decides whether a read confirms or is only
              evidence — surface the default (`off`) so the tap has no surprise. */}
          {autoReleaseOn === 'off' ? (
            <Text style={s.hint} testID={`p2p-swap-${index}-verify-evidence`}>{t('p2pdev.policyOff')}</Text>
          ) : null}
        </>
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
  bookToolbar: { marginBottom: 12 },
  bookSearchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bookSearchInput: { flex: 1, minWidth: 0 },
  bookClear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  tabs: { flexDirection: 'row', gap: 8, alignItems: 'center', marginBottom: 12 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border },
  tabText: { fontSize: 14, fontWeight: '600' },
  refreshBtn: { marginLeft: 'auto', paddingHorizontal: 8, paddingVertical: 8 },
  linkBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  guideRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  refreshText: { fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  mono: { fontSize: 14, fontFamily: MONO_FONT, color: theme.colors.text.primary },
  sub: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 6 },
  hint: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 4 },
  subMono: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 4, fontFamily: MONO_FONT },
  didRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  didText: { flexShrink: 1, marginTop: 0, fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.secondary },
  copyBtn: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.primary },
  copyText: { fontSize: 11, color: theme.colors.primary, fontWeight: '600' },
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
