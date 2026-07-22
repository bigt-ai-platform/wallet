import * as React from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Platform,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { useWallet } from "@/state/wallet";
import { httpService } from "@/services/http";
import { sendTransaction } from "@/services/transaction";
import type { WalletAccountItem } from "@/types/api";

export default function TransactionScreen() {
  const { t } = useTranslation();
  const { publicInfo, isUnlocked, getUnlockedWallet, getPassword } = useWallet();
  const [selectedToken, setSelectedToken] = React.useState<WalletAccountItem | null>(null);
  const [tokens, setTokens] = React.useState<WalletAccountItem[]>([]);
  const [toAddress, setToAddress] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadingTokens, setLoadingTokens] = React.useState(false);

  React.useEffect(() => {
    if (publicInfo && isUnlocked) loadTokens();
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
    } catch (e) {
      console.error("Error loading tokens:", e);
    } finally {
      setLoadingTokens(false);
    }
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
            const txHash = (result.data as any)?.txHash || result.data || '';
            Alert.alert("Success", `Transaction sent!\n\nTx: ${String(txHash).slice(0, 16)}...`);
            setToAddress(""); setAmount(""); setMemo(""); loadTokens();
          } catch (error) {
            Alert.alert("Error", error instanceof Error ? error.message : "Failed");
          } finally { setLoading(false); }
        },
      },
    ]);
  };

  if (!isUnlocked) {
    return (
      <View style={s.container} testID="transaction-screen">
        <View style={s.centered}>
          <Text style={s.lockedTitle}>{t('transaction.locked')}</Text>
          <Text style={s.lockedSub}>{t('transaction.lockedSub')}</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push("/wallet/keys")}>
            <Text style={s.primaryBtnText}>{t('transaction.unlock')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} testID="transaction-screen">
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
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  lockedTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 8 },
  lockedSub: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 16 },
  card: {
    backgroundColor: theme.colors.card.background, borderRadius: 12,
    borderWidth: 1, borderColor: theme.colors.card.border, padding: 16, marginBottom: 12,
  },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
  input: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8,
    backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary,
    padding: 12, fontSize: 14,
  },
  inputBig: {
    borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8,
    backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary,
    padding: 12, fontSize: 24, fontWeight: '700',
  },
  textArea: { minHeight: 72, textAlignVertical: 'top' },
  placeholder: { color: theme.colors.text.secondary },
  hint: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 6 },
  emptySmall: { fontSize: 13, color: theme.colors.text.secondary, paddingVertical: 8 },
  loader: { color: theme.colors.primary },
  tokenChip: {
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8,
    backgroundColor: theme.colors.groupped.background, borderWidth: 1, borderColor: theme.colors.border,
    minWidth: 80, alignItems: 'center',
  },
  tokenChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  tokenChipName: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  tokenChipNameActive: { color: '#FFFFFF' },
  tokenChipBal: { fontSize: 11, color: theme.colors.text.secondary },
  tokenChipBalActive: { color: '#FFFFFF', opacity: 0.85 },
  primaryBtn: {
    backgroundColor: theme.colors.primary, borderRadius: 10,
    paddingVertical: 15, alignItems: 'center', marginTop: 8,
  },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  btnDisabled: { opacity: 0.5 },
}));
