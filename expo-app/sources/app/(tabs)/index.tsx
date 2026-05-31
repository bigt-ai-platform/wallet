/**
 * Transaction/Payment Screen
 *
 * Main screen for sending payments and transactions
 */

import * as React from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { router } from "expo-router";
import { useWallet } from "@/state/wallet";
import { httpService } from "@/services/http";
import { sendTransaction } from "@/services/transaction";
import type { WalletAccountItem } from "@/types/api";

export default function TransactionScreen() {
  const { publicInfo, isUnlocked, getUnlockedWallet, getPassword } =
    useWallet();

  const [selectedToken, setSelectedToken] =
    React.useState<WalletAccountItem | null>(null);
  const [tokens, setTokens] = React.useState<WalletAccountItem[]>([]);
  const [toAddress, setToAddress] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [loadingTokens, setLoadingTokens] = React.useState(false);

  // Load user's tokens
  React.useEffect(() => {
    if (publicInfo && isUnlocked) {
      loadTokens();
    }
  }, [publicInfo, isUnlocked]);

  const loadTokens = async () => {
    if (!publicInfo?.address) return;

    setLoadingTokens(true);
    try {
      const response = await httpService.getMyValidTokenItemList(
        publicInfo.address,
      );
      if (response.success && response.data) {
        setTokens(response.data);
        if (response.data.length > 0 && !selectedToken) {
          setSelectedToken(response.data[0]);
        }
      }
    } catch (error) {
      console.error("Error loading tokens:", error);
    } finally {
      setLoadingTokens(false);
    }
  };

  const handleSend = async () => {
    const wallet = getUnlockedWallet();
    const password = getPassword();

    if (!wallet || !isUnlocked) {
      Alert.alert("Error", "Please unlock your wallet first");
      return;
    }

    if (!selectedToken) {
      Alert.alert("Error", "Please select a token");
      return;
    }

    if (!toAddress) {
      Alert.alert("Error", "Please enter recipient address");
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert("Error", "Please enter valid amount");
      return;
    }

    const amountNum = parseFloat(amount);
    const balance = parseFloat(selectedToken.balance);

    if (amountNum > balance) {
      Alert.alert("Error", "Insufficient balance");
      return;
    }

    // Convert amount to satoshis (assuming 8 decimals like Bitcoin)
    const decimals = selectedToken.decimals || 8;
    const satoshis = Math.floor(amountNum * Math.pow(10, decimals));

    // Confirm transaction
    Alert.alert(
      "Confirm Transaction",
      `Send ${amount} ${selectedToken.tokenname} to:\n${toAddress}\n\nFee: ~0.00001 ${selectedToken.tokenname}`,
      [
        {
          text: "Cancel",
          style: "cancel",
        },
        {
          text: "Send",
          onPress: async () => {
            setLoading(true);
            try {
              const result = await sendTransaction({
                fromAddress: publicInfo!.address,
                toAddress,
                amount: satoshis.toString(),
                tokenId: selectedToken.tokenid,
                privateKeyHex: wallet.wallet.privateKey,
                memo: memo || undefined,
              });

              if (!result.success) {
                throw new Error(result.error || "Transaction failed");
              }

              Alert.alert(
                "Success",
                `Transaction sent!\n\nTx Hash: ${result.data?.substring(0, 16)}...`,
                [
                  {
                    text: "OK",
                    onPress: () => {
                      // Clear form
                      setToAddress("");
                      setAmount("");
                      setMemo("");
                      // Reload tokens to show updated balance
                      loadTokens();
                    },
                  },
                ],
              );
            } catch (error) {
              console.error("Error sending transaction:", error);
              Alert.alert(
                "Error",
                error instanceof Error
                  ? error.message
                  : "Failed to send transaction",
              );
            } finally {
              setLoading(false);
            }
          },
        },
      ],
    );
  };

  if (!isUnlocked) {
    return (
      <View style={stylesheet.container} testID="transaction-screen">
        <View style={stylesheet.centered}>
          <Text style={stylesheet.subtitle}>
            Please unlock your wallet to make transactions
          </Text>
          <TouchableOpacity
            style={[stylesheet.button, stylesheet.primaryButton]}
            onPress={() => router.push("/wallet/keys")}
          >
            <Text style={stylesheet.buttonText}>Unlock Wallet</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      style={stylesheet.container}
      contentContainerStyle={stylesheet.content}
      testID="transaction-screen"
    >
      <Text style={stylesheet.title}>Send Payment</Text>

      {/* Token Selection */}
      <View style={stylesheet.section} testID="token-selection">
        <Text style={stylesheet.label}>Select Token</Text>
        {loadingTokens ? (
          <ActivityIndicator />
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {tokens.map((token) => (
              <TouchableOpacity
                key={token.tokenid}
                style={[
                  stylesheet.tokenCard,
                  selectedToken?.tokenid === token.tokenid &&
                    stylesheet.tokenCardSelected,
                ]}
                onPress={() => setSelectedToken(token)}
              >
                <Text style={stylesheet.tokenName}>{token.tokenname}</Text>
                <Text style={stylesheet.tokenBalance}>{token.balance}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}
      </View>

      {/* Recipient Address */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.label}>Recipient Address</Text>
        <View style={stylesheet.inputRow}>
          <TextInput
            style={[stylesheet.input, stylesheet.inputFlex]}
            value={toAddress}
            onChangeText={setToAddress}
            placeholder="Enter address"
            placeholderTextColor={stylesheet.placeholder.color}
            autoCapitalize="none"
            autoCorrect={false}
            testID="recipient-address-input"
          />
          <TouchableOpacity style={stylesheet.iconButton} testID="qr-scan-button">
            <Text style={stylesheet.iconButtonText}>QR</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Amount */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.label}>Amount</Text>
        <TextInput
          style={stylesheet.input}
          value={amount}
          onChangeText={setAmount}
          placeholder="0.00"
          placeholderTextColor={stylesheet.placeholder.color}
          keyboardType="decimal-pad"
          testID="amount-input"
        />
        {selectedToken && (
          <Text style={stylesheet.hint}>
            Available: {selectedToken.balance} {selectedToken.tokenname}
          </Text>
        )}
      </View>

      {/* Memo */}
      <View style={stylesheet.section}>
        <Text style={stylesheet.label}>Memo (Optional)</Text>
        <TextInput
          style={[stylesheet.input, stylesheet.textArea]}
          value={memo}
          onChangeText={setMemo}
          placeholder="Add a note"
          placeholderTextColor={stylesheet.placeholder.color}
          multiline
          numberOfLines={3}
          testID="memo-input"
        />
      </View>

      {/* Send Button */}
      <TouchableOpacity
        style={[
          stylesheet.button,
          stylesheet.primaryButton,
          loading && stylesheet.buttonDisabled,
        ]}
        onPress={handleSend}
        disabled={loading}
        testID="send-button"
      >
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={stylesheet.buttonText}>Send</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.groupped.background,
  },
  content: {
    padding: 16,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: theme.colors.text.primary,
    marginBottom: 24,
  },
  subtitle: {
    fontSize: 16,
    color: theme.colors.text.secondary,
    marginBottom: 16,
    textAlign: "center",
  },
  section: {
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.text.primary,
    marginBottom: 8,
  },
  input: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    color: theme.colors.text.primary,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
  },
  inputFlex: {
    flex: 1,
  },
  textArea: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  placeholder: {
    color: theme.colors.text.secondary,
  },
  hint: {
    fontSize: 12,
    color: theme.colors.text.secondary,
    marginTop: 4,
  },
  tokenCard: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 12,
    marginRight: 8,
    minWidth: 120,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  tokenCardSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary + "20",
  },
  tokenName: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.text.primary,
    marginBottom: 4,
  },
  tokenBalance: {
    fontSize: 12,
    color: theme.colors.text.secondary,
  },
  button: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  primaryButton: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#fff",
  },
  iconButton: {
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 8,
    padding: 12,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 60,
  },
  iconButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.primary,
  },
}));
