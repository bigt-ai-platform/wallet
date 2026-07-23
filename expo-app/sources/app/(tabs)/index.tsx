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
import { WalletIcon } from "@/components/Icons";
import type { WalletAccountItem } from "@/types/api";

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
  const [activeTab, setActiveTab] = React.useState<'send' | 'history'>('send');
  const [txHistory, setTxHistory] = React.useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [unlockPwd, setUnlockPwd] = React.useState("");
  const [unlocking, setUnlocking] = React.useState(false);

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
            Alert.alert("Success", `Tx sent!`);
            setToAddress(""); setAmount(""); setMemo(""); loadTokens(); loadHistory();
          } catch (error) {
            Alert.alert("Error", error instanceof Error ? error.message : "Failed");
          } finally { setLoading(false); }
        },
      },
    ]);
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
        <TouchableOpacity style={[s.tab, activeTab === 'history' && s.tabActive]} onPress={() => setActiveTab('history')}>
          <Text style={[s.tabText, activeTab === 'history' && s.tabTextActive]}>History</Text>
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
}));
