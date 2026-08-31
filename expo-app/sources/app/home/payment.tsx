import * as React from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Platform, Modal,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useWallet } from "@/state/wallet";
import { httpService } from "@/services/http";
import { payOnLayer1, payOnLayer0, pegInToL1 } from "@/services/transaction";
import { listPayments, recordPayment, refreshAllStatuses } from "@/services/tracking";
import { WalletIcon } from "@/components/Icons";
import ChainBadge from "@/components/ChainBadge";
import SegmentedTabs from "@/components/SegmentedTabs";
import { statusBadgeColor } from "@/utils/status";
import { MONO_FONT } from "@/constants/fonts";
import type { WalletAccountItem, L1ChainConfig, TrackedRecord } from "@/types/api";

interface LayerOption {
  value: number;
  label: string;
}

interface LayerToken extends WalletAccountItem {
  layer: number;
}

function LayerSelect({ label, value, options, onChange, testID }: {
  label: string;
  value: number;
  options: LayerOption[];
  onChange: (value: number) => void;
  testID?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <TouchableOpacity style={s.dropdown} onPress={() => setOpen(true)} testID={testID}>
        <View style={s.dropdownValue}>
          <ChainBadge layer={value} />
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
                key={o.value}
                style={[s.modalOption, o.value === value && s.modalOptionActive]}
                onPress={() => { onChange(o.value); setOpen(false); }}
              >
                <ChainBadge layer={o.value} />
                <Text style={[s.modalOptionText, o.value === value && s.modalOptionTextActive]}>{o.label}</Text>
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
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <TouchableOpacity style={s.dropdown} onPress={() => setOpen(true)} testID={testID}>
        <View style={s.dropdownValue}>
          {value && <ChainBadge layer={value.layer} />}
          <Text style={s.dropdownText}>{value ? `${value.tokenname} (${value.balance})` : 'Select token'}</Text>
        </View>
        <Text style={s.dropdownChevron}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>Select Token</Text>
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
  const [activeTab, setActiveTab] = React.useState<'send' | 'history' | 'payments' | 'bridge'>('send');
  const [txHistory, setTxHistory] = React.useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [historyLayer, setHistoryLayer] = React.useState(-1); // -1 = all, 0 = L0, 1..N = L1 chains
  const [historyToFilter, setHistoryToFilter] = React.useState("");
  const [payments, setPayments] = React.useState<TrackedRecord[]>([]);
  const [refreshingPayments, setRefreshingPayments] = React.useState(false);
  const [unlockPwd, setUnlockPwd] = React.useState("");
  const [unlocking, setUnlocking] = React.useState(false);

  // Bridge (L0 -> L1 peg-in) form
  const [bridgeToken, setBridgeToken] = React.useState("bc");
  const [bridgeDest, setBridgeDest] = React.useState("");
  const [bridgeSub, setBridgeSub] = React.useState(false);

  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  // Payment routing layers: 0 = Layer 0 (L0/settlement), 1..N = the configured
  // L1 chains. Both the source and destination default to L0.
  const [fromLayer, setFromLayer] = React.useState(0);
  const [toLayer, setToLayer] = React.useState(0);
  React.useEffect(() => httpService.subscribeL1Change(() => {
    setL1Chains(httpService.getL1Chains());
  }), []);

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
      // Always offer BIG (the base token) even when the wallet holds no
      // balance yet, so a fresh wallet still defaults to a sendable token.
      if (!all.some((t) => t.tokenid === 'bc')) {
        all.unshift({
          tokenid: 'bc',
          tokenname: 'BIG',
          balance: '0',
          confirmedBalance: '0',
          unconfirmedBalance: '0',
          decimals: 8,
          layer: 0,
        });
      }
      setTokens(all);
      if (all.length > 0 && !selectedToken) {
        // Default to BIG (tokenid = bc) when present, otherwise the first token.
        const big = all.find((t) => t.tokenid === 'bc');
        setSelectedToken(big || all[0]);
      }
    } catch (e) { console.error("Error loading tokens:", e); }
    finally { setLoadingTokens(false); }
  };

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

  const loadPayments = async (isRefresh = false) => {
    if (isRefresh) setRefreshingPayments(true);
    try {
      if (isRefresh) {
        const updated = await refreshAllStatuses(publicInfo?.address);
        setPayments(updated.filter((r) => r.kind === 'payment'));
      } else {
        setPayments(listPayments());
      }
    } catch (e) { /* ignore */ }
    finally { setRefreshingPayments(false); }
  };

  React.useEffect(() => {
    if (activeTab === 'payments') loadPayments();
  }, [activeTab]);

  const handleSend = async () => {
    const wallet = getUnlockedWallet();
    const password = getPassword();
    if (!wallet || !isUnlocked) { Alert.alert("Error", "Please unlock your wallet first"); return; }
    if (!selectedToken) { Alert.alert("Error", "Please select a token"); return; }
    if (!toAddress) { Alert.alert("Error", "Please enter recipient address"); return; }
    if (!amount || parseFloat(amount) <= 0) { Alert.alert("Error", "Please enter valid amount"); return; }

    const amountNum = parseFloat(amount);
    const balance = parseFloat(selectedToken.balance);
    if (amountNum > balance) { Alert.alert("Error", "Insufficient balance"); return; }

    const decimals = selectedToken.decimals || 8;
    const satoshis = Math.floor(amountNum * Math.pow(10, decimals));

    // Confirm the send. react-native-web's Alert.alert ignores the buttons
    // array, so on web use window.confirm (which Playwright/browsers can drive);
    // on native keep the Alert with Cancel/Send buttons.
    const confirmed = await new Promise<boolean>((resolve) => {
      if (Platform.OS === "web") {
        resolve(
          typeof window !== "undefined" && window.confirm(
            `Send ${amount} ${selectedToken.tokenname} to:\n${toAddress}`,
          ),
        );
      } else {
        Alert.alert("Confirm Transaction", `Send ${amount} ${selectedToken.tokenname} to:\n${toAddress}`, [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "Send", onPress: () => resolve(true) },
        ]);
      }
    });
    if (!confirmed) return;

    setLoading(true);
    try {
      let result: { success: boolean; error?: string; data?: string };
      if (toLayer === 0) {
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
        const chain = l1Chains[toLayer - 1];
        if (!chain) throw new Error("No L1 chain selected");
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
      if (!result.success) throw new Error(result.error || "Transaction failed");
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
        layer: toLayer,
      });
      setPayments(listPayments());
      Alert.alert("Success", `Tx sent!\nTracking: ${txHash.slice(0, 12)}...`);
      setToAddress(""); setAmount(""); setMemo(""); loadTokens(); loadHistory();
    } catch (error) {
      Alert.alert("Error", error instanceof Error ? error.message : "Failed");
    } finally { setLoading(false); }
  };

  const handleBridge = async () => {
    const wallet = getUnlockedWallet();
    if (!wallet || !isUnlocked) { Alert.alert("Error", "Please unlock your wallet first"); return; }
    if (!bridgeToken.trim()) { Alert.alert("Error", "Please enter a token ID"); return; }
    if (!bridgeDest.trim()) { Alert.alert("Error", "Please enter an L1 destination address"); return; }
    const chain = httpService.getActiveL1Chain();
    const chainId = chain?.chainId || "ordermatch";
    setBridgeSub(true);
    try {
      const txHash = await pegInToL1({
        privateKeyHex: wallet.wallet.privateKey,
        l1Address: bridgeDest.trim(),
        tokenId: bridgeToken.trim(),
        chainId,
      });
      Alert.alert("Bridge Submitted", `Locked a ${bridgeToken.trim()} UTXO to the vault for L1 chain "${chainId}".\nTx: ${txHash.slice(0, 12)}...`);
      setBridgeDest("");
    } catch (e: any) { Alert.alert("Error", e.message); }
    finally { setBridgeSub(false); }
  };

  const layerOptions: LayerOption[] = [
    { value: 0, label: 'Settlement' },
    ...l1Chains.map((chain, i) => ({ value: i + 1, label: chain.name })),
  ];

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
              <Text style={s.walletLabel}>Wallet: {publicInfo?.address?.slice(0, 10)}...</Text>
              <TextInput
                style={s.unlockInput}
                value={unlockPwd}
                onChangeText={setUnlockPwd}
                placeholder="Enter wallet password"
                placeholderTextColor={s.placeholder.color}
                secureTextEntry
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={[s.primaryBtn, unlocking && s.btnDisabled]}
                onPress={async () => {
                  if (!unlockPwd) return;
                  setUnlocking(true);
                  try {
                    await unlockWallet(unlockPwd);
                  } catch (e: any) {
                    Alert.alert("Error", e.message || "Wrong password");
                  } finally { setUnlocking(false); }
                }}
                disabled={unlocking}
              >
                <Text style={s.primaryBtnText}>{unlocking ? "Unlocking..." : t('transaction.unlock')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            // No wallet at all — direct create/import
            <>
              <Text style={s.lockedTitle}>No Wallet Found</Text>
              <Text style={s.lockedSub}>Create or import a wallet to start sending payments</Text>
              <TouchableOpacity style={s.primaryBtn} onPress={() => router.push("/home/keys")}>
                <Text style={s.primaryBtnText}>Create Wallet</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.secondaryBtn} onPress={() => router.push("/home/keys")}>
                <Text style={s.secondaryBtnText}>Import Existing Wallet</Text>
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
          { key: 'send', label: 'Send' },
          { key: 'history', label: 'History' },
          { key: 'payments', label: 'Payments' },
          { key: 'bridge', label: 'Bridge' },
        ]}
        active={activeTab}
        onChange={(k) => setActiveTab(k as typeof activeTab)}
      />

      {activeTab === 'send' ? (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.pageTitle}>{t('transaction.title')}</Text>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.selectToken')}</Text>
            {loadingTokens ? (
              <ActivityIndicator size="small" color={s.loader.color} />
            ) : (
              <TokenSelect value={selectedToken} options={tokens} onChange={setSelectedToken} testID="token-select" />
            )}
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.recipient')}</Text>
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
          <View style={s.card}>
            <Text style={s.cardLabel}>From Layer</Text>
            <LayerSelect label="From Layer" value={fromLayer} options={layerOptions} onChange={setFromLayer} testID="from-layer-select" />
            <Text style={s.hint}>Layer holding the funds being sent.</Text>
          </View>
          <View style={s.card}>
            <Text style={s.cardLabel}>To Layer</Text>
            <LayerSelect label="To Layer" value={toLayer} options={layerOptions} onChange={setToLayer} testID="to-layer-select" />
            <Text style={s.hint}>Layer the payment is submitted to. Payments on Settlement settle on Layer 0; payments on an L1 chain submit to that order chain.</Text>
          </View>
          <TouchableOpacity style={[s.primaryBtn, (loading || !selectedToken) && s.btnDisabled]} onPress={handleSend} disabled={loading || !selectedToken}>
            <Text style={s.primaryBtnText}>{loading ? t('transaction.sending') : t('transaction.send')}</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : activeTab === 'payments' ? (
        <ScrollView contentContainerStyle={s.content} testID="payments-tab">
          <View style={s.sectionHeader}>
            <Text style={s.pageTitle}>Payment Tracking</Text>
            <TouchableOpacity onPress={() => loadPayments(true)} disabled={refreshingPayments}>
              <Text style={s.refreshBtn}>{refreshingPayments ? '...' : 'Refresh'}</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.desc}>Track the on-chain status of every payment sent from this wallet.</Text>
          {payments.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No Payments Yet</Text>
              <Text style={s.emptySub}>Payments sent from the Send tab will appear here with their live status.</Text>
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
                      <Text style={s.txId}>to {p.toAddress?.slice(0, 12)}...</Text>
                    </View>
                    <Text style={s.txId} testID="payment-txhash">{p.txHash}</Text>
                    {p.statusDetail && <Text style={s.payDetail}>{p.statusDetail}</Text>}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      ) : activeTab === 'bridge' ? (
        <ScrollView contentContainerStyle={s.content} testID="bridge-tab">
          <Text style={s.pageTitle}>Bridge to L1</Text>
          <Text style={s.desc}>Lock a Layer 0 token UTXO to the bridge vault; the L1 order chain mints wrapped tokens 1:1 to the destination address. One whole UTXO is locked per bridge.</Text>

          <View style={s.card}>
            <Text style={s.cardLabel}>Token ID</Text>
            <TextInput style={s.input} value={bridgeToken} onChangeText={setBridgeToken}
              placeholder="bc for BIG" placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} testID="bridge-token-input" />
          </View>

          <View style={s.card}>
            <Text style={s.cardLabel}>L1 Destination Address</Text>
            <TextInput style={s.input} value={bridgeDest} onChangeText={setBridgeDest}
              placeholder="L1 address on order chain" placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} testID="bridge-dest-input" />
          </View>

          <TouchableOpacity style={s.l1Btn} onPress={handleBridge} disabled={bridgeSub} testID="bridge-submit-button">
            <Text style={s.l1BtnText}>{bridgeSub ? 'Bridging...' : 'Bridge to L1'}</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={s.content} testID="history-tab">
          <Text style={s.pageTitle}>Transaction History</Text>

          {/* Filters */}
          <View style={s.card}>
            <Text style={s.cardLabel}>Filter by Layer</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} testID="history-layer-filters">
              <TouchableOpacity style={[s.tokenChip, historyLayer === -1 && s.tokenChipActive]} onPress={() => setHistoryLayer(-1)} testID="history-layer-all">
                <Text style={[s.tokenChipName, historyLayer === -1 && s.tokenChipNameActive]}>All</Text>
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
            <Text style={s.cardLabel}>Filter by To Address</Text>
            <TextInput style={s.input} value={historyToFilter} onChangeText={setHistoryToFilter}
              placeholder="Recipient address" placeholderTextColor={s.placeholder.color}
              autoCapitalize="none" autoCorrect={false} testID="history-to-filter" />
          </View>

          {loadingHistory ? (
            <ActivityIndicator size="small" color={s.loader.color} style={{ padding: 24 }} />
          ) : txHistory.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No Transactions Yet</Text>
              <Text style={s.emptySub}>Your transaction history will appear here after you send or receive tokens.</Text>
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
                        <Text style={s.txId}>to {tx.address ? tx.address.slice(0, 16) : '...'}</Text>
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
  l1Btn: { backgroundColor: theme.colors.accent.purple, borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 4 },
  l1BtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
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
