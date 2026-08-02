import * as React from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useWallet } from "@/state/wallet";
import { httpService } from "@/services/http";
import { sendTransaction } from "@/services/transaction";
import { listPayments, recordPayment, refreshAllStatuses } from "@/services/tracking";
import { WalletIcon } from "@/components/Icons";
import type { WalletAccountItem, L1ChainConfig, TrackedRecord } from "@/types/api";

export default function TransactionScreen() {
  const { t } = useTranslation();
  const { publicInfo, isUnlocked, unlockWallet, getUnlockedWallet, getPassword } = useWallet();
  const [selectedToken, setSelectedToken] = React.useState<WalletAccountItem | null>(null);
  const [tokens, setTokens] = React.useState<WalletAccountItem[]>([]);
  const [toAddress, setToAddress] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadingTokens, setLoadingTokens] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'send' | 'history' | 'l1test' | 'payments'>('send');
  const [txHistory, setTxHistory] = React.useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [payments, setPayments] = React.useState<TrackedRecord[]>([]);
  const [refreshingPayments, setRefreshingPayments] = React.useState(false);
  const [unlockPwd, setUnlockPwd] = React.useState("");
  const [unlocking, setUnlocking] = React.useState(false);

  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  const [selectedL1Chain, setSelectedL1Chain] = React.useState(0);
  const [l1TestToken, setL1TestToken] = React.useState("");
  const [l1TestAmount, setL1TestAmount] = React.useState("");
  const [l1TestDest, setL1TestDest] = React.useState("");
  const [l1TestSub, setL1TestSub] = React.useState(false);
  const [l1TestMode, setL1TestMode] = React.useState<'pay' | 'payback'>('pay');

  React.useEffect(() => {
    if (publicInfo && isUnlocked) { loadTokens(); loadHistory(); }
  }, [publicInfo, isUnlocked]);

  const loadTokens = async () => {
    if (!publicInfo?.address) return;
    setLoadingTokens(true);
    try {
      const res = await httpService.getMyValidTokenItemList(publicInfo.address);
      if (res.success && res.data) {
        setTokens(res.data);
        if (res.data.length > 0 && !selectedToken) setSelectedToken(res.data[0]);
      }
    } catch (e) { console.error("Error loading tokens:", e); }
    finally { setLoadingTokens(false); }
  };

  const loadHistory = async () => {
    if (!publicInfo?.address) return;
    setLoadingHistory(true);
    try {
      const res = await httpService.getOutputs(publicInfo.address);
      if (res.success && res.data) setTxHistory(res.data.slice(0, 20));
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

    Alert.alert("Confirm Transaction", `Send ${amount} ${selectedToken.tokenname} to:\n${toAddress}`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Send", onPress: async () => {
          setLoading(true);
          try {
            const result = await sendTransaction({
              fromAddress: publicInfo!.address, toAddress,
              amount: satoshis.toString(), tokenId: selectedToken.tokenid,
              privateKeyHex: wallet.wallet.privateKey, memo: memo || undefined,
            });
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
            });
            setPayments(listPayments());
            Alert.alert("Success", `Tx sent!\nTracking: ${txHash.slice(0, 12)}...`);
            setToAddress(""); setAmount(""); setMemo(""); loadTokens(); loadHistory();
          } catch (error) {
            Alert.alert("Error", error instanceof Error ? error.message : "Failed");
          } finally { setLoading(false); }
        },
      },
    ]);
  };

  const handlePayL1 = async () => {
    const wallet = getUnlockedWallet();
    if (!wallet || !isUnlocked) { Alert.alert("Error", "Please unlock your wallet first"); return; }
    if (!l1TestToken.trim()) { Alert.alert("Error", "Enter a token ID"); return; }
    if (!l1TestAmount || parseFloat(l1TestAmount) <= 0) { Alert.alert("Error", "Enter valid amount"); return; }
    if (!l1TestDest.trim()) { Alert.alert("Error", "Enter L1 destination address"); return; }

    setL1TestSub(true);
    try {
      const payload = {
        tokenid: l1TestToken.trim(),
        amount: l1TestAmount,
        l1address: l1TestDest.trim(),
        fromAddress: publicInfo?.address,
      };
      const res = await httpService.request('regSubtangle', 'POST', payload);
      if (res.success) {
        Alert.alert("Success", `Bridged ${l1TestAmount} to L1 chain`);
        setL1TestAmount(""); setL1TestDest("");
      } else {
        Alert.alert("Error", res.error || "Bridge failed");
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setL1TestSub(false);
    }
  };

  const handlePayBackL1 = async () => {
    const wallet = getUnlockedWallet();
    if (!wallet || !isUnlocked) { Alert.alert("Error", "Please unlock your wallet first"); return; }
    if (!l1TestToken.trim()) { Alert.alert("Error", "Enter a token ID"); return; }
    if (!l1TestAmount || parseFloat(l1TestAmount) <= 0) { Alert.alert("Error", "Enter valid amount"); return; }
    if (!l1TestDest.trim()) { Alert.alert("Error", "Enter L0 destination address"); return; }

    const chain = l1Chains[selectedL1Chain];
    if (!chain) { Alert.alert("Error", "No L1 chain selected"); return; }

    setL1TestSub(true);
    try {
      const payload = {
        tokenid: l1TestToken.trim(),
        amount: l1TestAmount,
        toAddress: l1TestDest.trim(),
        fromAddress: publicInfo?.address,
      };
      const res = await httpService.requestL1ByIndex(selectedL1Chain, 'withdrawTransaction', 'POST', payload);
      if (res.success) {
        Alert.alert("Success", `Withdrawal of ${l1TestAmount} from L1 initiated`);
        setL1TestAmount(""); setL1TestDest("");
      } else {
        Alert.alert("Error", res.error || "Withdrawal failed");
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setL1TestSub(false);
    }
  };

  if (!isUnlocked) {
    const hasWallet = publicInfo?.hasEncryptedWallet;
    return (
      <View style={s.container} testID="transaction-screen">
        <View style={s.centered}>
          <WalletIcon size={48} color="#999" />

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
              <TouchableOpacity style={s.primaryBtn} onPress={() => router.push("/wallet/keys")}>
                <Text style={s.primaryBtnText}>Create Wallet</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.secondaryBtn} onPress={() => router.push("/wallet/keys")}>
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
      <View style={s.tabRow}>
        <TouchableOpacity style={[s.tab, activeTab === 'send' && s.tabActive]} onPress={() => setActiveTab('send')}>
          <Text style={[s.tabText, activeTab === 'send' && s.tabTextActive]}>Send</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'l1test' && s.tabActive]} onPress={() => setActiveTab('l1test')}>
          <Text style={[s.tabText, activeTab === 'l1test' && s.tabTextActive]}>L1 Test</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'history' && s.tabActive]} onPress={() => setActiveTab('history')}>
          <Text style={[s.tabText, activeTab === 'history' && s.tabTextActive]}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.tab, activeTab === 'payments' && s.tabActive]} onPress={() => setActiveTab('payments')}>
          <Text style={[s.tabText, activeTab === 'payments' && s.tabTextActive]}>Payments</Text>
        </TouchableOpacity>
      </View>

      {activeTab === 'send' ? (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.pageTitle}>{t('transaction.title')}</Text>
          <View style={s.card}>
            <Text style={s.cardLabel}>{t('transaction.selectToken')}</Text>
            {loadingTokens ? (
              <ActivityIndicator size="small" color={s.loader.color} />
            ) : tokens.length === 0 ? (
              <Text style={s.emptySmall}>{t('transaction.noTokens')}</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                {tokens.map((token) => (
                  <TouchableOpacity key={token.tokenid} style={[s.tokenChip, selectedToken?.tokenid === token.tokenid && s.tokenChipActive]}
                    onPress={() => setSelectedToken(token)}>
                    <Text style={[s.tokenChipName, selectedToken?.tokenid === token.tokenid && s.tokenChipNameActive]}>{token.tokenname}</Text>
                    <Text style={[s.tokenChipBal, selectedToken?.tokenid === token.tokenid && s.tokenChipBalActive]}>{token.balance}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
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
          <TouchableOpacity style={[s.primaryBtn, loading && s.btnDisabled]} onPress={handleSend} disabled={loading}>
            <Text style={s.primaryBtnText}>{loading ? t('transaction.sending') : t('transaction.send')}</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : activeTab === 'l1test' ? (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.pageTitle}>L1 Test</Text>
          <Text style={s.desc}>Test paying L1 chain and paying back from L1 to Layer 0</Text>

          <View style={s.card}>
            <Text style={s.cardLabel}>Select L1 Chain</Text>
            {l1Chains.length === 0 ? (
              <Text style={s.emptySmall}>No L1 chains configured. Go to Settings to add one.</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} testID="l1-chain-list">
                {l1Chains.map((chain, i) => (
                  <TouchableOpacity key={i} style={[s.tokenChip, selectedL1Chain === i && s.tokenChipActive]}
                    onPress={() => setSelectedL1Chain(i)} testID={`l1-chain-chip-${i}`}>
                    <Text style={[s.tokenChipName, selectedL1Chain === i && s.tokenChipNameActive]}>{chain.name}</Text>
                    <Text style={[s.tokenChipBal, selectedL1Chain === i && s.tokenChipBalActive]}>{chain.url}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </View>

          <View style={s.modeRow} testID="l1-mode-tabs">
            <TouchableOpacity style={[s.modeTab, l1TestMode === 'pay' && s.modeTabActive]} onPress={() => setL1TestMode('pay')} testID="l1-mode-pay">
              <Text style={[s.modeTabText, l1TestMode === 'pay' && s.modeTabTextActive]}>Pay L1</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.modeTab, l1TestMode === 'payback' && s.modeTabActive]} onPress={() => setL1TestMode('payback')} testID="l1-mode-payback">
              <Text style={[s.modeTabText, l1TestMode === 'payback' && s.modeTabTextActive]}>Pay Back L1→L0</Text>
            </TouchableOpacity>
          </View>

          {l1TestMode === 'pay' ? (
            <>
              <View style={s.card} testID="l1-pay-section">
                <Text style={s.sectionLabel}>Pay L1 Chain</Text>
                <Text style={s.desc}>Bridge tokens from Layer 0 to the selected L1 chain.</Text>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>Token ID</Text>
                  <TextInput style={s.input} value={l1TestToken} onChangeText={setL1TestToken}
                    placeholder="e.g. bc for BIG" placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-pay-token-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>Amount</Text>
                  <TextInput style={s.input} value={l1TestAmount} onChangeText={setL1TestAmount}
                    placeholder="0.00" keyboardType="decimal-pad" testID="l1-pay-amount-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>L1 Destination Address</Text>
                  <TextInput style={s.input} value={l1TestDest} onChangeText={setL1TestDest}
                    placeholder="L1 address on order chain" placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-pay-dest-input" />
                </View>
                <TouchableOpacity style={s.l1Btn} onPress={handlePayL1} disabled={l1TestSub} testID="l1-pay-button">
                  <Text style={s.l1BtnText}>{l1TestSub ? 'Processing...' : 'Pay L1 Chain'}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <View style={s.card} testID="l1-payback-section">
                <Text style={s.sectionLabel}>Pay Back from L1 to L0</Text>
                <Text style={s.desc}>Withdraw tokens from the selected L1 chain back to Layer 0.</Text>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>Token ID</Text>
                  <TextInput style={s.input} value={l1TestToken} onChangeText={setL1TestToken}
                    placeholder="e.g. bc for BIG" placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-payback-token-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>Amount</Text>
                  <TextInput style={s.input} value={l1TestAmount} onChangeText={setL1TestAmount}
                    placeholder="0.00" keyboardType="decimal-pad" testID="l1-payback-amount-input" />
                </View>
                <View style={s.fieldGroup}>
                  <Text style={s.fieldLabel}>L0 Destination Address</Text>
                  <TextInput style={s.input} value={l1TestDest} onChangeText={setL1TestDest}
                    placeholder="L0 address" placeholderTextColor={s.placeholder.color} autoCapitalize="none" testID="l1-payback-dest-input" />
                </View>
                <TouchableOpacity style={s.l1Btn} onPress={handlePayBackL1} disabled={l1TestSub} testID="l1-payback-button">
                  <Text style={s.l1BtnText}>{l1TestSub ? 'Processing...' : 'Pay Back to L0'}</Text>
                </TouchableOpacity>
              </View>
            </>
          )}
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
              const badgeColor = p.status === 'confirmed' ? s.statusConfirmed.color : p.status === 'failed' || p.status === 'cancelled' ? s.statusFailed.color : s.statusPending.color;
              return (
                <View key={p.id} style={s.txCard} testID={`payment-${p.id}`}>
                  <View style={s.txInfo}>
                    <View style={s.payHeader}>
                      <Text style={s.txType}>{p.amount} {p.tokenName}</Text>
                      <View style={[s.statusBadge, { backgroundColor: badgeColor }]}>
                        <Text style={s.statusBadgeText} testID="payment-status">{p.status}</Text>
                      </View>
                    </View>
                    <Text style={s.txId}>to {p.toAddress?.slice(0, 12)}...</Text>
                    <Text style={s.txId} testID="payment-txhash">{p.txHash}</Text>
                    {p.statusDetail && <Text style={s.payDetail}>{p.statusDetail}</Text>}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.pageTitle}>Transaction History</Text>
          {loadingHistory ? (
            <ActivityIndicator size="small" color={s.loader.color} style={{ padding: 24 }} />
          ) : txHistory.length === 0 ? (
            <View style={s.emptyCard}>
              <Text style={s.emptyTitle}>No Transactions Yet</Text>
              <Text style={s.emptySub}>Your transaction history will appear here after you send or receive tokens.</Text>
            </View>
          ) : (
            txHistory.map((tx, i) => (
              <View key={i} style={s.txCard}>
                <View style={s.txDot} />
                <View style={s.txInfo}>
                  <Text style={s.txType}>UTXO</Text>
                  <Text style={s.txId}>{tx.txhash?.slice(0, 20) || '...'}</Text>
                </View>
                <Text style={s.txValue}>{tx.value || tx.balance || ''}</Text>
              </View>
            ))
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
  walletLabel: { fontSize: 13, color: theme.colors.text.secondary, marginBottom: 12, fontFamily: 'monospace' },
  unlockInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 15, width: '100%', maxWidth: 280, marginBottom: 12 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 16 },
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary },
  tabTextActive: { color: '#FFFFFF' },
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
  txDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent?.blue || '#3B82F6', marginRight: 12 },
  txInfo: { flex: 1 },
  txType: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  txId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: 'monospace' },
  txValue: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  refreshBtn: { fontSize: 14, color: theme.colors.primary, fontWeight: '600' },
  payHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  statusBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, alignItems: 'center' },
  statusBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  payDetail: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 2 },
  statusPending: { color: '#F59E0B' },
  statusConfirmed: { color: '#10B981' },
  statusFailed: { color: '#EF4444' },
  desc: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 18, marginBottom: 16 },
  modeRow: { flexDirection: 'row', marginBottom: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  modeTab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  modeTabActive: { backgroundColor: theme.colors.accent?.purple || '#8B5CF6' },
  modeTabText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary },
  modeTabTextActive: { color: '#FFFFFF' },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 6 },
  sectionLabel: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 4 },
  l1Btn: { backgroundColor: theme.colors.accent?.purple || '#8B5CF6', borderRadius: 10, paddingVertical: 15, alignItems: 'center', marginTop: 4 },
  l1BtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
}));
