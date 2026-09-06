import * as React from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Platform, Modal,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { router, useLocalSearchParams } from "expo-router";
import { useTranslation } from "react-i18next";
import * as WebBrowser from "expo-web-browser";
import { useWallet } from "@/state/wallet";
import { httpService } from "@/services/http";
import { payOnLayer1, payOnLayer0 } from "@/services/transaction";
import { listPayments, recordPayment, refreshAllStatuses } from "@/services/tracking";
import { WalletIcon, QrScanIcon } from "@/components/Icons";
import ChainBadge from "@/components/ChainBadge";
import SegmentedTabs from "@/components/SegmentedTabs";
import QrScannerModal from "@/components/QrScannerModal";
import { statusBadgeColor } from "@/utils/status";
import { showAlert } from "@/utils/alert";
import { parseQrContent } from "@/lib/qr";
import { MONO_FONT } from "@/constants/fonts";
import type { WalletAccountItem, L1ChainConfig, TrackedRecord } from "@/types/api";

/** A pay destination: Settlement (id '0') or an L1 order chain (on-chain id). */
interface LayerOption {
  id: string;
  label: string;
  layer: number;
}

interface LayerToken extends WalletAccountItem {
  layer: number;
}

function LayerSelect({ label, value, options, onChange, testID }: {
  label: string;
  value: string;
  options: LayerOption[];
  onChange: (value: string) => void;
  testID?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.id === value);
  return (
    <>
      <TouchableOpacity style={s.dropdown} onPress={() => setOpen(true)} testID={testID}>
        <View style={s.dropdownValue}>
          {current && <ChainBadge layer={current.layer} />}
          <Text style={s.dropdownText}>{current?.label ?? options[0]?.label ?? ''}</Text>
        </View>
        <Text style={s.dropdownChevron}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>{label}</Text>
            {options.map((o) => (
              <TouchableOpacity
                key={o.id}
                style={[s.modalOption, o.id === value && s.modalOptionActive]}
                onPress={() => { onChange(o.id); setOpen(false); }}
              >
                <ChainBadge layer={o.layer} />
                <Text style={[s.modalOptionText, o.id === value && s.modalOptionTextActive]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

function TokenSelect({ value, options, onChange, testID }: {
  value: LayerToken | null;
  options: LayerToken[];
  onChange: (token: LayerToken) => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <TouchableOpacity style={s.dropdown} onPress={() => setOpen(true)} testID={testID}>
        <View style={s.dropdownValue}>
          {value && <ChainBadge layer={value.layer} />}
          <Text style={s.dropdownText}>{value ? `${value.tokenname} (${value.balance})` : t('transaction.selectPlaceholder')}</Text>
        </View>
        <Text style={s.dropdownChevron}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>{t('transaction.selectToken')}</Text>
            {options.map((t) => (
              <TouchableOpacity
                key={`${t.layer}-${t.tokenid}`}
                style={[s.modalOption, value?.tokenid === t.tokenid && value?.layer === t.layer && s.modalOptionActive]}
                onPress={() => { onChange(t); setOpen(false); }}
              >
                <ChainBadge layer={t.layer} />
                <View style={s.modalOptionTextWrap}>
                  <Text style={[s.modalOptionText, value?.tokenid === t.tokenid && value?.layer === t.layer && s.modalOptionTextActive]}>{t.tokenname}</Text>
                  <Text style={s.modalOptionSub}>{t.balance}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

export default function TransactionScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { publicInfo, isUnlocked, unlockWallet, getUnlockedWallet, getPassword } = useWallet();
  const [selectedToken, setSelectedToken] = React.useState<LayerToken | null>(null);
  const [tokens, setTokens] = React.useState<LayerToken[]>([]);
  const [toAddress, setToAddress] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadingTokens, setLoadingTokens] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'send' | 'history' | 'payments'>('send');
  const [txHistory, setTxHistory] = React.useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [historyLayer, setHistoryLayer] = React.useState(-1); // -1 = all, 0 = L0, 1..N = L1 chains
  const [historyToFilter, setHistoryToFilter] = React.useState("");
  const [payments, setPayments] = React.useState<TrackedRecord[]>([]);
  const [refreshingPayments, setRefreshingPayments] = React.useState(false);
  const [unlockPwd, setUnlockPwd] = React.useState("");
  const [unlocking, setUnlocking] = React.useState(false);
  const [qrOpen, setQrOpen] = React.useState(false);
  // When a scanned payment request names a token, remember it so the token
  // selection effect below can prefer it over the default BIG selection.
  const requestedTokenIdRef = React.useRef<string | null>(null);

  // A shared "payment request" link (`…/home/payment?address=…&amount=…`)
  // re-opens this screen prefilled. Guard so it only applies once per address.
  const urlParams = useLocalSearchParams<{
    address?: string | string[];
    amount?: string | string[];
    tokenid?: string | string[];
    memo?: string | string[];
    chain?: string | string[];
  }>();
  const appliedRequestAddressRef = React.useRef<string | null>(null);

  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  // Payment routing: the recipient is paid on an explicit chain. Settlement is
  // the special destination id '0'; every L1 order chain is its on-chain id.
  // Sendable tokens are those the wallet holds on that chain.
  const [destChainId, setDestChainId] = React.useState<string>('0');
  React.useEffect(() => httpService.subscribeL1Change(() => {
    setL1Chains(httpService.getL1Chains());
  }), []);

  // If the configured L1 chain set changes (add/remove), reload balances so the
  // per-chain token buckets match the current chain list.
  const l1ChainKey = l1Chains.map((c) => c.chainId).join(',');
  React.useEffect(() => {
    if (publicInfo && isUnlocked) loadTokens();
  }, [l1ChainKey]);

  React.useEffect(() => {
    if (publicInfo && isUnlocked) { loadTokens(); loadHistory(); }
  }, [publicInfo, isUnlocked]);

  const loadTokens = async () => {
    if (!publicInfo?.address) return;
    const wallet = getUnlockedWallet();
    if (!wallet) return;
    setLoadingTokens(true);
    try {
      const privateKeyHex = wallet.wallet.privateKey;
      const all: LayerToken[] = [];
      // Layer 0 tokens.
      const l0 = await httpService.getBalances(privateKeyHex);
      (l0.success && l0.data ? l0.data : []).forEach((t) => all.push({ ...t, layer: 0 }));
      // Tokens on each configured L1 chain.
      for (let i = 0; i < l1Chains.length; i++) {
        try {
          const l1 = await httpService.getBalancesOn(l1Chains[i].url, privateKeyHex);
          (l1.success && l1.data ? l1.data : []).forEach((t) => all.push({ ...t, layer: i + 1 }));
        } catch (e) { /* L1 unreachable — skip */ }
      }
      setTokens(all);
    } catch (e) { console.error("Error loading tokens:", e); }
    finally { setLoadingTokens(false); }
  };

  // Chains the recipient can be paid on.
  const layerOptions = React.useMemo<LayerOption[]>(() => [
    { id: '0', label: t('transaction.settlement'), layer: 0 },
    ...l1Chains.map((chain, i) => ({ id: chain.chainId, label: chain.name, layer: i + 1 })),
  ], [l1Chains, t]);

  // Numeric layer (0 = L0, i+1 = i-th configured L1 chain) of the destination.
  const destLayer = React.useMemo(() => {
    if (destChainId === '0') return 0;
    const idx = l1Chains.findIndex((c) => c.chainId === destChainId);
    return idx >= 0 ? idx + 1 : 0;
  }, [destChainId, l1Chains]);

  // Sendable tokens on the destination chain. Always offer BIG (the base
  // token) on an otherwise-empty chain so a fresh wallet still has a
  // sendable token to pick.
  const tokenOptions = React.useMemo<LayerToken[]>(() => {
    const onLayer = tokens.filter((t) => t.layer === destLayer);
    if (onLayer.length > 0) return onLayer;
    return [{
      tokenid: 'bc',
      tokenname: 'BIG',
      balance: '0',
      confirmedBalance: '0',
      unconfirmedBalance: '0',
      decimals: 8,
      layer: destLayer,
    }];
  }, [tokens, destLayer]);

  // Keep the selected token valid for the destination chain: prefer the token
  // requested by a scanned QR when present, otherwise BIG when present,
  // otherwise the first token held on that chain. Whenever the token list
  // reloads, REFRESH the selection with the freshly-loaded entry (same
  // token+layer but current balance) — otherwise a token selected while its
  // bucket was still empty keeps the stale 0 balance forever.
  React.useEffect(() => {
    const requested = requestedTokenIdRef.current
      ? tokenOptions.find((o) => o.tokenid.toLowerCase() === requestedTokenIdRef.current)
      : undefined;
    const preferred = requested ?? tokenOptions.find((t) => t.tokenid === 'bc') ?? tokenOptions[0];
    setSelectedToken((prev) => {
      if (prev && prev.layer === destLayer && !requested) {
        const fresh = tokenOptions.find((o) => o.tokenid === prev.tokenid && o.layer === prev.layer);
        if (fresh) return fresh;
      }
      return preferred ?? null;
    });
    if (requested) requestedTokenIdRef.current = null;
  }, [destLayer, tokens]);

  const loadHistory = async () => {
    if (!publicInfo?.address) return;
    const wallet = getUnlockedWallet();
    if (!wallet) return;
    setLoadingHistory(true);
    try {
      const [outRes, statusRes] = await Promise.all([
        httpService.getOutputs(wallet.wallet.privateKey),
        httpService.getTransactionsStatusByAddress(publicInfo.address),
      ]);
      const outputs: any[] = outRes.success && outRes.data ? outRes.data : [];
      const statuses: any[] = statusRes.success && statusRes.data ? statusRes.data : [];
      const statusByHash = new Map<string, any>();
      for (const st of statuses) {
        if (st.txHash) statusByHash.set(st.txHash.toLowerCase(), st);
      }
      // Build history items from UTXOs joined with their on-chain lifecycle status.
      const items = outputs.map((u: any) => {
        const st = statusByHash.get(String(u.hashHex || u.txhash || u.txHash || '').toLowerCase());
        return {
          txhash: u.hashHex || u.txhash || u.txHash || '',
          tokenid: u.tokenid || u.tokenId || '',
          value: u.value?.value != null ? String(u.value.value) : (u.value || u.balance || ''),
          address: u.address || '',
          layer: 0, // UTXO history currently comes from L0
          status: st?.status || 'UNKNOWN',
          statusDetail: st?.status || 'UNKNOWN',
          createdTime: st?.createdTime || 0,
        };
      });
      setTxHistory(items.slice(0, 100));
    } catch (e) { /* ignore */ }
    finally { setLoadingHistory(false); }
  };

  const loadPayments = async (fromServer = false, silent = false) => {
    if (fromServer && !silent) setRefreshingPayments(true);
    try {
      if (fromServer) {
        const updated = await refreshAllStatuses(publicInfo?.address);
        setPayments(updated.filter((r) => r.kind === 'payment'));
      } else {
        setPayments(listPayments());
      }
    } catch (e) { /* ignore */ }
    finally { if (!silent) setRefreshingPayments(false); }
  };

  // While the Payments tab is open, poll the chain so a freshly sent payment
  // does not sit at "pending / MEMPOOL" until the user taps Refresh manually.
  React.useEffect(() => {
    if (activeTab !== 'payments') return;
    loadPayments(true, true);
    const timer = setInterval(() => {
      if (listPayments().some((p) => p.status === 'pending')) {
        loadPayments(true, true);
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [activeTab]);

  const handleSend = async () => {
    const wallet = getUnlockedWallet();
    const password = getPassword();
    if (!wallet || !isUnlocked) { showAlert(t('transaction.error'), t('transaction.errUnlock')); return; }
    if (!selectedToken) { showAlert(t('transaction.error'), t('transaction.errSelectToken')); return; }
    if (!toAddress) { showAlert(t('transaction.error'), t('transaction.errRecipient')); return; }
    if (!amount || parseFloat(amount) <= 0) { showAlert(t('transaction.error'), t('transaction.errAmount')); return; }

    const amountNum = parseFloat(amount);
    const balance = parseFloat(selectedToken.balance);
    if (amountNum > balance) { showAlert(t('transaction.error'), t('transaction.insufficient')); return; }

    const decimals = selectedToken.decimals || 8;
    const satoshis = Math.floor(amountNum * Math.pow(10, decimals));

    // Confirm the send. react-native-web's Alert.alert ignores the buttons
    // array, so on web use window.confirm (which Playwright/browsers can drive);
    // on native keep the Alert with Cancel/Send buttons.
    const confirmBody = t('transaction.confirmBody', { amount, token: selectedToken.tokenname, to: toAddress });
    const confirmed = await new Promise<boolean>((resolve) => {
      if (Platform.OS === "web") {
        resolve(
          typeof window !== "undefined" && window.confirm(confirmBody),
        );
      } else {
        Alert.alert(t('transaction.confirmTitle'), confirmBody, [
          { text: t('transaction.cancel'), style: "cancel", onPress: () => resolve(false) },
          { text: t('transaction.send_'), onPress: () => resolve(true) },
        ]);
      }
    });
    if (!confirmed) return;

    setLoading(true);
    try {
      let result: { success: boolean; error?: string; data?: string };
      if (selectedToken.layer === 0) {
        // Layer 0: use the SDK wallet (correct getOutputs format, fee
        // included) so the wallet's funded UTXOs can be spent.
        const txHash = await payOnLayer0({
          privateKeyHex: wallet.wallet.privateKey,
          toAddress,
          amount: BigInt(satoshis),
          tokenId: selectedToken.tokenid,
          memo: memo || undefined,
        });
        result = { success: true, data: txHash };
      } else {
        // L1 chain: use the SDK wallet pointed at the selected L1 server.
        const chain = l1Chains[selectedToken.layer - 1];
        if (!chain) throw new Error(t('transaction.errNoL1'));
        const txHash = await payOnLayer1({
          privateKeyHex: wallet.wallet.privateKey,
          l1Url: chain.url,
          toAddress,
          amount: BigInt(satoshis),
          tokenId: selectedToken.tokenid,
          memo: memo || undefined,
        });
        result = { success: true, data: txHash };
      }
      if (!result.success) throw new Error(result.error || t('transaction.errFailed'));
      const txHash = result.data || "";
      recordPayment({
        txHash,
        tokenId: selectedToken.tokenid,
        tokenName: selectedToken.tokenname,
        amount,
        decimals: selectedToken.decimals || 8,
        fromAddress: publicInfo!.address,
        toAddress,
        memo: memo || undefined,
        layer: selectedToken.layer,
      });
      setPayments(listPayments());
      showAlert(t('transaction.success'), t('transaction.successBody', { hash: txHash.slice(0, 12) }));
      setToAddress(""); setAmount(""); setMemo(""); loadTokens(); loadHistory();
    } catch (error) {
      showAlert(t('transaction.error'), error instanceof Error ? error.message : t('transaction.errFailed'));
    } finally { setLoading(false); }
  };

  const handleUnlock = async () => {
    if (!unlockPwd || unlocking) return;
    setUnlocking(true);
    try {
      await unlockWallet(unlockPwd);
    } catch (e: any) {
      showAlert(t('transaction.error'), e.message || t('keys.wrongPassword'));
    } finally { setUnlocking(false); }
  };

  // Scanned a web url link — ask before leaving the app.
  const openScannedUrl = (url: string) => {
    const body = t('qr.openLinkBody', { url });
    const doOpen = () => {
      if (Platform.OS === "web") {
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        WebBrowser.openBrowserAsync(url).catch(() => showAlert(t('transaction.error'), t('qr.openFailed')));
      }
    };
    if (Platform.OS === "web") {
      if (typeof window !== "undefined" && window.confirm(body)) doOpen();
    } else {
      Alert.alert(t('qr.openLinkTitle'), body, [
        { text: t('transaction.cancel'), style: "cancel" },
        { text: t('qr.open'), onPress: doOpen },
      ]);
    }
  };

  // Map a scanned token/chain request onto the Send form: prefill recipient /
  // amount / memo and switch the destination chain & token to the requested
  // ones when the wallet holds the token there.
  const applyPaymentRequest = (address: string, amount?: string, memo?: string, tokenid?: string, chainId?: string) => {
    setToAddress(address);
    if (amount) setAmount(amount);
    if (memo) setMemo(memo);

    // Resolve an explicit destination chain id: '0' (settlement) or one of
    // the configured L1 chains (also accept a 1..N layer number).
    let targetChainId: string | undefined;
    if (chainId) {
      if (chainId === '0') {
        targetChainId = '0';
      } else if (l1Chains.some((c) => c.chainId === chainId)) {
        targetChainId = chainId;
      } else {
        const n = Number(chainId);
        if (Number.isInteger(n) && n >= 1 && n <= l1Chains.length) {
          targetChainId = l1Chains[n - 1].chainId;
        }
      }
    }

    // Prefer a token held on the requested chain; otherwise pick the first
    // layer the wallet holds it on.
    let wanted: string | undefined;
    let layer: number | undefined;
    if (tokenid) {
      const lower = tokenid.toLowerCase();
      const targetLayer = targetChainId === undefined ? undefined : targetChainId === '0' ? 0 : l1Chains.findIndex((c) => c.chainId === targetChainId) + 1;
      const onTarget = targetLayer !== undefined && targetLayer >= 0
        ? tokens.find((tt) => tt.layer === targetLayer && tt.tokenid.toLowerCase() === lower)
        : undefined;
      const hit = onTarget ?? tokens.find((tt) => tt.tokenid.toLowerCase() === lower);
      if (hit) {
        wanted = hit.tokenid;
        layer = hit.layer;
      }
    }

    if (wanted && layer !== undefined) {
      const cid = layer === 0 ? '0' : (l1Chains[layer - 1]?.chainId ?? '0');
      setDestChainId(cid);
      requestedTokenIdRef.current = wanted.toLowerCase();
    } else if (targetChainId !== undefined) {
      setDestChainId(targetChainId);
    }
  };

  const handleQrContent = (content: string) => {
    const parsed = parseQrContent(content);
    if (parsed.kind === 'url') {
      setQrOpen(false);
      openScannedUrl(parsed.url);
      return;
    }
    if (parsed.kind === 'unknown') {
      setQrOpen(false);
      showAlert(t('transaction.error'), t('qr.unrecognized'));
      return;
    }
    setQrOpen(false);
    applyPaymentRequest(
      parsed.request.address,
      parsed.request.amount,
      parsed.request.memo,
      parsed.request.tokenid,
      parsed.request.chainId,
    );
  };

  // Manual selections always win over a token a QR scan requested.
  const selectDestChain = (id: string) => {
    requestedTokenIdRef.current = null;
    setDestChainId(id);
  };
  const selectTokenNow = (token: LayerToken) => {
    requestedTokenIdRef.current = null;
    setSelectedToken(token);
  };

  // Apply a shared payment-request link when this screen is opened (or
  // re-opened) with query params.
  const firstParam = (v?: string | string[]): string | undefined =>
    typeof v === 'string' ? v : undefined;
  React.useEffect(() => {
    const linkAddress = firstParam(urlParams.address)?.trim() ?? '';
    if (!linkAddress || linkAddress === appliedRequestAddressRef.current) return;
    appliedRequestAddressRef.current = linkAddress;
    applyPaymentRequest(
      linkAddress,
      firstParam(urlParams.amount),
      firstParam(urlParams.memo),
      firstParam(urlParams.tokenid),
      firstParam(urlParams.chain),
    );
    // Only react to distinct request addresses, not unrelated param changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlParams.address]);

  if (!isUnlocked) {
    const hasWallet = publicInfo?.hasEncryptedWallet;
    return (
      <View style={s.container} testID="transaction-screen">
        <View style={s.centered}>
          <WalletIcon size={48} color={theme.colors.text.secondary} />

          {hasWallet ? (
            // Wallet exists but locked — inline unlock
            <>
              <Text style={s.lockedTitle}>{t('transaction.locked')}</Text>
              <Text style={s.lockedSub}>{t('transaction.lockedSub')}</Text>
              <Text style={s.walletLabel}>{t('transaction.walletLabel', { address: `${(publicInfo?.address ?? '').slice(0, 10)}...` })}</Text>
              <TextInput
                style={s.unlockInput}
                value={unlockPwd}
                onChangeText={setUnlockPwd}
                placeholder={t('wallet.passwordPlaceholder')}
                placeholderTextColor={s.placeholder.color}
                secureTextEntry
                autoCapitalize="none"
                returnKeyType="go"
                onSubmitEditing={handleUnlock}
                testID="wallet-password-input"
              />
              <TouchableOpacity
                style={[s.primaryBtn, unlocking && s.btnDisabled]}
                onPress={handleUnlock}
                disabled={unlocking}
              >
                <Text style={s.primaryBtnText}>{unlocking ? t('keys.unlocking') : t('transaction.unlock')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            // No wallet at all — direct create/import
            <>
              <Text style={s.lockedTitle}>{t('wallet.noWalletFound')}</Text>
              <Text style={s.lockedSub}>{t('wallet.noWalletFoundSub')}</Text>
              <TouchableOpacity style={s.primaryBtn} onPress={() => router.push("/home/keys")}>
                <Text style={s.primaryBtnText}>{t('wallet.createWallet')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.secondaryBtn} onPress={() => router.push("/home/keys")}>
                <Text style={s.secondaryBtnText}>{t('wallet.importExistingWallet')}</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={s.container} testID="transaction-screen">
      <SegmentedTabs
        tabs={[
          { key: 'send', label: t('transaction.tabSend') },
          { key: 'history', label: t('transaction.tabHistory') },
          { key: 'payments', label: t('transaction.tabPayments') },
        ]}
        active={activeTab}
        onChange={(k) => setActiveTab(k as typeof activeTab)}
      />

      {activeTab === 'send' ? (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.pageTitle}>{t('transaction.title')}</Text>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.destChain')}</Text>
            <LayerSelect label={t('transaction.destChain')} value={destChainId} options={layerOptions}
              onChange={selectDestChain} testID="dest-chain-select" />
            <Text style={s.hint}>{t('transaction.destChainHint')}</Text>
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.selectToken')}</Text>
            {loadingTokens ? (
              <ActivityIndicator size="small" color={s.loader.color} />
            ) : (
              <TokenSelect value={selectedToken} options={tokenOptions} onChange={selectTokenNow} testID="token-select" />
            )}
          </View>
          <View style={s.card}>
            <View style={s.cardHeaderRow}>
              <Text style={s.cardLabel}>{t('transaction.recipient')}</Text>
              <TouchableOpacity
                style={s.scanBtn}
                onPress={() => setQrOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={t('qr.scan')}
                testID="qr-scan-button"
              >
                <QrScanIcon size={15} color={s.scanBtnText.color} />
                <Text style={s.scanBtnText}>{t('qr.scan')}</Text>
              </TouchableOpacity>
            </View>
            <TextInput style={s.input} value={toAddress} onChangeText={setToAddress}
              placeholder={t('transaction.recipient')} placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} testID="recipient-address-input" />
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.amount')}</Text>
            <TextInput style={s.inputBig} value={amount} onChangeText={setAmount}
              placeholder="0.00" placeholderTextColor={s.placeholder.color}
              keyboardType="decimal-pad" testID="amount-input" />
            {selectedToken && <Text style={s.hint}>{t('transaction.available')}: {selectedToken.balance} {selectedToken.tokenname}</Text>}
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.memo')}</Text>
            <TextInput style={[s.input, s.textArea]} value={memo} onChangeText={setMemo}
              placeholder={t('transaction.memo')} placeholderTextColor={s.placeholder.color}
              multiline numberOfLines={3} testID="memo-input" />
          </View>
          <TouchableOpacity style={[s.primaryBtn, (loading || !selectedToken) && s.btnDisabled]} onPress={handleSend} disabled={loading || !selectedToken}>
            <Text style={s.primaryBtnText}>{loading ? t('transaction.sending') : t('transaction.send')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.requestBtn}
            onPress={() => router.push('/receive')}
            accessibilityRole="button"
            testID="request-payment-button"
          >
            <QrScanIcon size={16} color={s.requestBtnText.color} />
            <Text style={s.requestBtnText}>{t('receive.requestBtn')}</Text>
          </TouchableOpacity>
          {qrOpen && <QrScannerModal visible onClose={() => setQrOpen(false)} onScanned={handleQrContent} />}
        </ScrollView>
      ) : activeTab === 'payments' ? (
        <ScrollView contentContainerStyle={s.content} testID="payments-tab">
          <View style={s.sectionHeader}>
            <Text style={s.pageTitle}>{t('transaction.paymentTracking')}</Text>
            <TouchableOpacity onPress={() => loadPayments(true)} disabled={refreshingPayments}>
              <Text style={s.refreshBtn}>{refreshingPayments ? '...' : t('order.refresh')}</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.desc}>{t('transaction.paymentDesc')}</Text>
          {payments.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>{t('transaction.paymentEmptyTitle')}</Text>
              <Text style={s.emptySub}>{t('transaction.paymentEmptySub')}</Text>
            </View>
          ) : (
            payments.map((p) => {
              const badgeColor = statusBadgeColor(p.status, theme);
              return (
                <View key={p.id} style={s.txCard} testID={`payment-${p.id}`}>
                  <View style={s.txInfo}>
                    <View style={s.payHeader}>
                      <Text style={s.txType}>{p.amount} {p.tokenName}</Text>
                      <View style={[s.statusBadge, { backgroundColor: badgeColor }]}>
                        <Text style={s.statusBadgeText} testID="payment-status">{p.status}</Text>
                      </View>
                    </View>
                    <View style={s.payMetaRow}>
                      <ChainBadge layer={p.layer ?? 0} size="sm" />
                      <Text style={s.txId}>{t('transaction.historyTo', { address: p.toAddress ? p.toAddress.slice(0, 12) : '' })}...</Text>
                    </View>
                    <Text style={s.txId} testID="payment-txhash">{p.txHash}</Text>
                    {p.statusDetail && <Text style={s.payDetail}>{p.statusDetail}</Text>}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={s.content} testID="history-tab">
          <Text style={s.pageTitle}>{t('transaction.historyTitle')}</Text>

          {/* Filters */}
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.filterLayer')}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} testID="history-layer-filters">
              <TouchableOpacity style={[s.tokenChip, historyLayer === -1 && s.tokenChipActive]} onPress={() => setHistoryLayer(-1)} testID="history-layer-all">
                <Text style={[s.tokenChipName, historyLayer === -1 && s.tokenChipNameActive]}>{t('transaction.filterAll')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.tokenChip, historyLayer === 0 && s.tokenChipActive]} onPress={() => setHistoryLayer(0)} testID="history-layer-0">
                <ChainBadge layer={0} />
              </TouchableOpacity>
              {l1Chains.map((chain, i) => (
                <TouchableOpacity key={i} style={[s.tokenChip, historyLayer === i + 1 && s.tokenChipActive]} onPress={() => setHistoryLayer(i + 1)} testID={`history-layer-${i + 1}`}>
                  <ChainBadge layer={i + 1} name={chain.name} />
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.filterToAddress')}</Text>
            <TextInput style={s.input} value={historyToFilter} onChangeText={setHistoryToFilter}
              placeholder={t('transaction.recipientPlaceholder')} placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} testID="history-to-filter" />
          </View>

          {loadingHistory ? (
            <ActivityIndicator size="small" color={s.loader.color} style={{ padding: 24 }} />
          ) : txHistory.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>{t('transaction.historyEmptyTitle')}</Text>
              <Text style={s.emptySub}>{t('transaction.historyEmptySub')}</Text>
            </View>
          ) : (
            txHistory
              .filter((tx) => historyLayer === -1 || tx.layer === historyLayer)
              .filter((tx) => !historyToFilter.trim() || (tx.address || '').toLowerCase().includes(historyToFilter.trim().toLowerCase()))
              .map((tx, i) => {
                const badgeColor = statusBadgeColor(tx.status, theme);
                return (
                  <View key={i} style={s.txCard} testID={`history-item-${i}`}>
                    <View style={s.txDot} />
                    <View style={s.txInfo}>
                      <View style={s.payHeader}>
                        <Text style={s.txType}>{tx.tokenid === 'bc' ? 'BIG' : (tx.tokenid || 'UTXO')}</Text>
                        <View style={[s.statusBadge, { backgroundColor: badgeColor }]}>
                          <Text style={s.statusBadgeText}>{tx.status}</Text>
                        </View>
                      </View>
                      <View style={s.payMetaRow}>
                        <ChainBadge layer={tx.layer ?? 0} />
                        <Text style={s.txId}>{t('transaction.historyTo', { address: tx.address ? tx.address.slice(0, 16) : '...' })}</Text>
                      </View>
                      <Text style={s.txId}>{tx.txhash?.slice(0, 20) || '...'}</Text>
                    </View>
                    <Text style={s.txValue}>{tx.value || ''}</Text>
                  </View>
                );
              })
          )}
        </ScrollView>
      )}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  lockedTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 8, marginTop: 12 },
  lockedSub: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  hintText: { fontSize: 12, color: theme.colors.text.secondary, textAlign: 'center', marginTop: 16, paddingHorizontal: 20 },
  walletLabel: { fontSize: 13, color: theme.colors.text.secondary, marginBottom: 12, fontFamily: MONO_FONT },
  unlockInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 15, width: '100%', maxWidth: 280, marginBottom: 12 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 16 },
  card: { backgroundColor: theme.colors.card?.background || theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.card?.border || theme.colors.border, padding: 16, marginBottom: 12 },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  scanBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6, backgroundColor: theme.colors.primarySoft },
  scanBtnText: { fontSize: 12, fontWeight: '600', color: theme.colors.primary },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 15 },
  inputBig: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 24, fontWeight: '700' },
  textArea: { minHeight: 72, textAlignVertical: 'top' },
  placeholder: { color: theme.colors.text.secondary },
  hint: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 6 },
  loader: { color: theme.colors.primary },
  emptySmall: { fontSize: 13, color: theme.colors.text.secondary, paddingVertical: 8 },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 32, alignItems: 'center', marginTop: 20 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 6 },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center', lineHeight: 18 },
  tokenChip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: theme.colors.groupped.background, borderWidth: 1, borderColor: theme.colors.border, minWidth: 80, alignItems: 'center' },
  tokenChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tokenChipName: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  tokenChipNameActive: { color: '#FFFFFF' },
  tokenChipBal: { fontSize: 11, color: theme.colors.text.secondary },
  tokenChipBalActive: { color: '#FFFFFF', opacity: 0.85 },
  primaryBtn: { backgroundColor: theme.colors.primary, borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 8 },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  requestBtn: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: theme.colors.primary, paddingVertical: 14, marginTop: 10 },
  requestBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.primary },
  secondaryBtn: { borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, paddingVertical: 14, paddingHorizontal: 32, alignItems: 'center', marginTop: 10 },
  secondaryBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.text.secondary },
  btnDisabled: { opacity: 0.5 },
  txCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 8, flexDirection: 'row', alignItems: 'center' },
  txDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent.blue, marginRight: 12 },
  txInfo: { flex: 1 },
  txType: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  txId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: MONO_FONT },
  txValue: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  refreshBtn: { fontSize: 14, color: theme.colors.text.link, fontWeight: '600' },
  payHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignItems: 'center' },
  statusBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  payDetail: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 2 },
  payMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  desc: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 18, marginBottom: 16 },
  modeRow: { flexDirection: 'row', marginBottom: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  modeTab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  modeTabActive: { backgroundColor: theme.colors.accent.purple },
  modeTabText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary },
  modeTabTextActive: { color: '#FFFFFF' },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 6 },
  sectionLabel: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 4 },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, paddingHorizontal: 12, paddingVertical: 10 },
  dropdownValue: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dropdownText: { fontSize: 14, color: theme.colors.text.primary },
  dropdownChevron: { fontSize: 14, color: theme.colors.text.secondary },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modalSheet: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 14, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  modalOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 8 },
  modalOptionActive: { backgroundColor: theme.colors.primarySoft },
  modalOptionText: { fontSize: 14, color: theme.colors.text.primary },
  modalOptionTextActive: { color: theme.colors.primary, fontWeight: '600' },
  modalOptionTextWrap: { flex: 1 },
  modalOptionSub: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 1 },
}));
