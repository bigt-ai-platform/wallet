import * as React from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, Share, useWindowDimensions, Platform,
} from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import QRCode from "react-native-qrcode-svg";
import * as Clipboard from "expo-clipboard";
import { useWallet } from "@/state/wallet";
import { httpService } from "@/services/http";
import { WalletIcon } from "@/components/Icons";
import ChainBadge from "@/components/ChainBadge";
import { showAlert } from "@/utils/alert";
import { MONO_FONT } from "@/constants/fonts";
import {
  buildPaymentRequestJson, buildPaymentRequestLink,
} from "@/lib/paymentRequest";
import type { L1ChainConfig } from "@/types/api";

interface ChainOption {
  id: string;
  label: string;
  layer: number;
}

function chainOptions(l1Chains: L1ChainConfig[]): ChainOption[] {
  return [
    { id: '0', label: '', layer: 0 },
    ...l1Chains.map((c, i) => ({ id: c.chainId, label: c.name, layer: i + 1 })),
  ];
}

export default function ReceiveScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const { publicInfo } = useWallet();

  const [l1Chains, setL1Chains] = React.useState<L1ChainConfig[]>(() => httpService.getL1Chains());
  React.useEffect(() => httpService.subscribeL1Change(() => {
    setL1Chains(httpService.getL1Chains());
  }), []);

  const [amount, setAmount] = React.useState("");
  const [memo, setMemo] = React.useState("");
  const [tokenid, setTokenid] = React.useState("bc");
  const [chainId, setChainId] = React.useState('0');
  const [copied, setCopied] = React.useState("");

  const address = publicInfo?.address ?? "";

  const chainOpts = React.useMemo(() => chainOptions(l1Chains), [l1Chains]);
  const activeChain = chainOpts.find((o) => o.id === chainId) ?? chainOpts[0];

  const qrSize = Math.min(264, width - 96);

  // Host base for the shareable link: app origin on web, deep-link scheme on
  // native.
  const linkHostBase = React.useMemo(
    () => Platform.OS === 'web'
      ? (typeof window !== 'undefined' && window.location ? window.location.origin : 'https://wallet.bigt.ai')
      : 'bigtai://',
    [],
  );

  const payloadJson = React.useMemo(
    () => address ? buildPaymentRequestJson({ address, amount: amount.trim(), tokenid: tokenid.trim(), memo: memo.trim(), chainId }) : "",
    [address, amount, memo, tokenid, chainId],
  );
  const payloadLink = React.useMemo(
    () => address ? buildPaymentRequestLink({ address, amount: amount.trim(), tokenid: tokenid.trim(), memo: memo.trim(), chainId }, linkHostBase) : "",
    [address, amount, memo, tokenid, chainId, linkHostBase],
  );

  const flashCopied = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(""), 1600);
  };

  const copyText = async (text: string, what: string) => {
    try {
      await Clipboard.setStringAsync(text);
      flashCopied(what);
    } catch (err) {
      console.error('copy failed:', err);
      showAlert(t('transaction.error'), t('receive.copyFailed'));
    }
  };

  const shareRequest = async () => {
    try {
      await Share.share({ message: `${t('receive.shareTitle')}\n\n${payloadLink}` });
    } catch (err) {
      console.error('share failed:', err);
    }
  };

  if (!address) {
    return (
      <View style={s.container} testID="receive-screen">
        <View style={s.centered}>
          <WalletIcon size={48} color={theme.colors.text.secondary} />
          <Text style={s.emptyTitle}>{t('wallet.noWalletFound')}</Text>
          <Text style={s.emptySub}>{t('wallet.noWalletFoundSub')}</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push('/home/keys')}>
            <Text style={s.primaryBtnText}>{t('wallet.createWallet')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content} testID="receive-screen">
      <View style={s.topRow}>
        <TouchableOpacity onPress={() => router.back()} accessibilityRole="button" accessibilityLabel={t('common.back')} testID="receive-back">
          <Text style={s.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.pageTitle}>{t('receive.title')}</Text>
      <Text style={s.desc}>{t('receive.subtitle')}</Text>

      {/* QR preview */}
      <View style={s.qrCard}>
        {payloadJson ? (
          <QRCode
            value={payloadJson}
            size={qrSize}
            color="#000000"
            backgroundColor="#FFFFFF"
            quietZone={8}
            ecl="M"
            testID="receive-qr"
          />
        ) : (
          <View style={[s.qrPlaceholder, { width: qrSize, height: qrSize }]} />
        )}
      </View>

      {/* Address */}
      <View style={s.card}>
        <View style={s.cardHeaderRow}>
          <Text style={s.cardLabel}>{t('receive.yourAddress')}</Text>
          <TouchableOpacity
            style={s.miniBtn}
            onPress={() => copyText(address, t('receive.copiedAddress'))}
            testID="receive-copy-address"
          >
            <Text style={s.miniBtnText}>{t('receive.copy')}</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.addressText} selectable>{address}</Text>
      </View>

      {/* Request fields */}
      <View style={s.card}>
        <Text style={s.cardLabel}>{t('receive.amount')}</Text>
        <TextInput style={s.inputBig} value={amount} onChangeText={setAmount}
          placeholder="0.00" placeholderTextColor={s.placeholder.color}
          keyboardType="decimal-pad" testID="receive-amount-input" />
      </View>
      <View style={s.card}>
        <Text style={s.cardLabel}>{t('receive.tokenId')}</Text>
        <TextInput style={s.input} value={tokenid} onChangeText={setTokenid}
          placeholder="bc" placeholderTextColor={s.placeholder.color}
          autoCapitalize="none" autoCorrect={false} testID="receive-token-input" />
        <Text style={s.hint}>{t('receive.tokenHint')}</Text>
      </View>
      <View style={s.card}>
        <Text style={s.cardLabel}>{t('receive.memo')}</Text>
        <TextInput style={[s.input, s.textArea]} value={memo} onChangeText={setMemo}
          placeholder={t('receive.memo')} placeholderTextColor={s.placeholder.color}
          multiline numberOfLines={3} testID="receive-memo-input" />
      </View>

      {/* Destination chain */}
      <View style={s.card}>
        <Text style={s.cardLabel}>{t('transaction.destChain')}</Text>
        <View style={s.chipRow}>
          {chainOpts.map((o) => (
            <TouchableOpacity
              key={o.id}
              style={[s.chip, chainId === o.id && s.chipActive]}
              onPress={() => setChainId(o.id)}
              testID={`receive-chain-${o.id === '0' ? '0' : o.id}`}
            >
              <ChainBadge layer={o.layer} name={o.label || undefined} />
              <Text style={[s.chipName, chainId === o.id && s.chipNameActive]}>
                {o.layer === 0 ? t('transaction.settlement') : o.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={s.hint}>{t('receive.chainHint', { chain: activeChain?.layer === 0 ? t('transaction.settlement') : (activeChain?.label ?? '') })}</Text>
      </View>

      {/* Actions */}
      <View style={s.actions}>
        <TouchableOpacity
          style={s.secondaryBtn}
          onPress={() => copyText(payloadJson, t('receive.copiedQr'))}
          testID="receive-copy-qr"
        >
          <Text style={s.secondaryBtnText}>{t('receive.copyQr')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.primaryBtn}
          onPress={() => copyText(payloadLink, t('receive.copiedLink'))}
          testID="receive-copy-link"
        >
          <Text style={s.primaryBtnText}>{t('receive.copyLink')}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={s.shareBtn} onPress={shareRequest} testID="receive-share">
        <Text style={s.shareBtnText}>{t('receive.share')}</Text>
      </TouchableOpacity>

      <Text style={s.linkPreview} numberOfLines={2}>{payloadLink}</Text>
      <Text style={s.linkHint}>{t('receive.linkHint')}</Text>

      {copied ? <Text style={s.copiedText} testID="receive-copied">{copied}</Text> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },
  topRow: { marginBottom: 12 },
  backText: { fontSize: 14, color: theme.colors.text.link, fontWeight: '600' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  pageTitle: { fontSize: 22, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 8 },
  desc: { fontSize: 13, color: theme.colors.text.secondary, lineHeight: 19, marginBottom: 16 },
  qrCard: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 20, marginBottom: 16 },
  qrPlaceholder: { backgroundColor: '#FFFFFF', borderRadius: 8 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 16, marginBottom: 12 },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  miniBtn: { borderRadius: 6, borderWidth: 1, borderColor: theme.colors.primary, paddingHorizontal: 10, paddingVertical: 4 },
  miniBtnText: { fontSize: 12, fontWeight: '600', color: theme.colors.primary },
  addressText: { fontSize: 13, color: theme.colors.text.primary, fontFamily: MONO_FONT, lineHeight: 20 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 12, fontSize: 15 },
  inputBig: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 12, fontSize: 24, fontWeight: '700' },
  textArea: { minHeight: 72, textAlignVertical: 'top' },
  placeholder: { color: theme.colors.text.secondary },
  hint: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 6, lineHeight: 17 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.groupped.background, borderWidth: 1, borderColor: theme.colors.border },
  chipActive: { backgroundColor: theme.colors.primarySoft, borderColor: theme.colors.primary },
  chipName: { fontSize: 12, fontWeight: '600', color: theme.colors.text.primary },
  chipNameActive: { color: theme.colors.primary },
  actions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  primaryBtn: { flex: 1, backgroundColor: theme.colors.primary, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  primaryBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  secondaryBtn: { flex: 1, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.primary, paddingVertical: 13, alignItems: 'center' },
  secondaryBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.primary },
  shareBtn: { borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, paddingVertical: 13, alignItems: 'center', marginTop: 10 },
  shareBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.text.secondary },
  linkPreview: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: MONO_FONT, marginTop: 16, lineHeight: 16 },
  linkHint: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4, lineHeight: 17 },
  copiedText: { color: theme.colors.accent.emerald, fontSize: 13, fontWeight: '600', textAlign: 'center', marginTop: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: theme.colors.text.primary, marginTop: 12, marginBottom: 6 },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center', marginBottom: 20, lineHeight: 19 },
}));
