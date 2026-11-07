import * as React from 'react';
import {
  ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useWallet } from '@/state/wallet';
import { useTransactionConfirm } from '@/components/TransactionConfirm';
import WalletUnlock from '@/components/WalletUnlock';
import { notifySystemMessage } from '@/services/systemMessages';
import {
  accountFromPrivateKey, assetsOf, getErc20Meta, loadBalances,
  prepareNativeTransfer, prepareTokenTransfer, sendNativeTransfer, sendTokenTransfer,
  waitForReceipt, type EthAsset, type EthAssetBalance, type PreparedTransfer,
} from '@/services/eth';
import { addEthToken, getEthChain, isEthRpcConfigured, removeEthToken } from '@/services/ethRpc';
import { buildEthPaymentUri } from '@/lib/eth/eip681';
import { formatUnits, parseUnits, shortAddress } from '@/lib/eth/units';
import { ethExplorerTx } from '@/lib/eth/chains';
import { isAddress, requireAddress } from '@/lib/eth/address';
import { MONO_FONT } from '@/constants/fonts';

/**
 * Ethereum deposit / withdraw for the wallet's legacy EC key.
 *
 * "Deposit" = our own address + EIP-681 QR on the selected network; "withdraw"
 * = a signed EIP-1559 transfer (native coin or ERC-20) to an external address.
 * PQ wallets are gated: their key has no secp256k1 counterpart.
 */

interface ActivityItem {
  hash: string;
  symbol: string;
  amount: string;
  status: 'pending' | 'success' | 'failed';
  at: number;
}

export default function EthereumScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const confirmTx = useTransactionConfirm();
  const { isUnlocked, getUnlockedWallet } = useWallet();
  const locale = i18n.language || 'en';

  const wallet = getUnlockedWallet();
  const keyType = wallet?.wallet.keyType;
  const privateKey = wallet?.wallet.privateKey;
  const isEc = keyType === 'EC';
  const account = React.useMemo(
    () => (isEc && privateKey ? accountFromPrivateKey(privateKey) : ''),
    [isEc, privateKey]
  );

  const [chain, setChain] = React.useState(() => getEthChain());
  const [balances, setBalances] = React.useState<EthAssetBalance[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');

  // Deposit sheet + withdraw form state.
  const [deposit, setDeposit] = React.useState<EthAsset | null>(null);
  const [withdraw, setWithdraw] = React.useState<EthAsset | null>(null);
  const [to, setTo] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [prepared, setPrepared] = React.useState<PreparedTransfer | null>(null);
  const [preparing, setPreparing] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [activity, setActivity] = React.useState<ActivityItem[]>([]);

  // Add-token form.
  const [addOpen, setAddOpen] = React.useState(false);
  const [tokenAddress, setTokenAddress] = React.useState('');
  const [adding, setAdding] = React.useState(false);

  const assets = React.useMemo(() => assetsOf(chain), [chain]);
  const balanceOf = (asset: EthAsset): bigint =>
    balances.find((b) => b.asset.key === asset.key)?.raw ?? 0n;

  const refresh = React.useCallback(async () => {
    if (!account) return;
    if (!isEthRpcConfigured()) {
      setError(t('eth.notConfigured'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const rows = await loadBalances(account, chain);
      setBalances(rows);
    } catch (e) {
      setError((e as Error).message || t('eth.errRpc'));
    } finally {
      setLoading(false);
    }
  }, [account, chain, t]);

  React.useEffect(() => {
    setChain(getEthChain());
  }, [isUnlocked]);

  React.useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, chain.id, isUnlocked]);

  // Recompute the fee preview whenever the withdraw inputs change.
  React.useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    if (!withdraw || !isEc || !privateKey || !isAddress(to) || !amount) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, withdraw.decimals);
    } catch {
      return;
    }
    if (raw <= 0n) return;
    setPreparing(true);
    const run = async () => {
      try {
        const req = { privateKeyHex: privateKey, to, amount: raw, chain };
        const next = withdraw.token
          ? await prepareTokenTransfer({ ...req, token: withdraw.token })
          : await prepareNativeTransfer(req);
        if (!cancelled) setPrepared(next);
      } catch {
        if (!cancelled) setPrepared(null);
      } finally {
        if (!cancelled) setPreparing(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withdraw?.key, to, amount, chain.id, isEc, privateKey]);

  const copy = async (value: string) => {
    await Clipboard.setStringAsync(value);
    setNotice(t('eth.copied'));
  };

  const depositUri = React.useMemo(() => {
    if (!deposit || !account) return '';
    if (deposit.token) {
      return buildEthPaymentUri({
        address: account,
        chainId: chain.chainId,
        token: { contract: deposit.token.address, to: account, amount: 0n },
      }).replace('&uint256=0', '');
    }
    return buildEthPaymentUri({ address: account, chainId: chain.chainId });
  }, [deposit, account, chain.chainId]);

  const startWithdraw = (asset: EthAsset) => {
    setWithdraw(asset);
    setDeposit(null);
    setTo('');
    setAmount('');
    setPrepared(null);
    setError('');
    setNotice('');
  };

  const submitWithdraw = async () => {
    if (!withdraw || !privateKey || sending) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, withdraw.decimals);
    } catch {
      setError(t('eth.errAmount'));
      return;
    }
    if (!isValidChecksumSafe(to)) {
      setError(t('eth.errAddress'));
      return;
    }
    const available = balanceOf(withdraw);
    if (raw > available) {
      setError(t('eth.errInsufficient'));
      return;
    }
    const ok = await confirmTx({
      title: t('eth.confirmTitle'),
      subtitle: t('eth.confirmSubtitle', {
        amount: formatUnits(raw, withdraw.decimals, locale),
        symbol: withdraw.symbol,
        to: shortAddress(to),
      }),
    });
    if (!ok) return;
    setSending(true);
    setError('');
    try {
      const req = { privateKeyHex: privateKey, to, amount: raw, chain };
      const sent = withdraw.token
        ? await sendTokenTransfer({ ...req, token: withdraw.token })
        : await sendNativeTransfer(req);
      const item: ActivityItem = {
        hash: sent.hash,
        symbol: withdraw.symbol,
        amount: formatUnits(raw, withdraw.decimals, locale),
        status: 'pending',
        at: Date.now(),
      };
      setActivity((prev) => [item, ...prev].slice(0, 20));
      setNotice(t('eth.sentNotice', { hash: shortHex(sent.hash) }));
      setWithdraw(null);
      setAmount('');
      setTo('');
      void trackReceipt(item);
      void refresh();
    } catch (e) {
      setError((e as Error).message || t('eth.errSend'));
    } finally {
      setSending(false);
    }
  };

  const trackReceipt = async (item: ActivityItem) => {
    try {
      const receipt = await waitForReceipt(item.hash, chain, { attempts: 45, intervalMs: 4000 });
      const status = receipt?.status === 'success' ? 'success' : receipt ? 'failed' : 'pending';
      setActivity((prev) => prev.map((a) => (a.hash === item.hash ? { ...a, status } : a)));
      if (status === 'success') {
        notifySystemMessage({
          tone: 'success',
          title: t('eth.sentTitle'),
          body: t('eth.sentBody', { amount: item.amount, symbol: item.symbol, hash: shortHex(item.hash) }),
        });
      } else if (status === 'failed') {
        notifySystemMessage({
          tone: 'error',
          title: t('eth.failedTitle'),
          body: t('eth.failedBody', { hash: shortHex(item.hash) }),
        });
      }
    } catch {
      /* the activity row keeps its pending state */
    }
  };

  const addToken = async () => {
    if (adding) return;
    if (!isAddress(tokenAddress)) {
      setError(t('eth.errToken'));
      return;
    }
    setAdding(true);
    setError('');
    try {
      const contract = requireAddress(tokenAddress);
      const token = await getErc20Meta(contract, chain);
      addEthToken(token, chain);
      setTokenAddress('');
      setAddOpen(false);
      setNotice(t('eth.tokenAdded', { symbol: token.symbol }));
      void refresh();
    } catch (e) {
      setError((e as Error).message || t('eth.errToken'));
    } finally {
      setAdding(false);
    }
  };

  const removeToken = (asset: EthAsset) => {
    if (!asset.token) return;
    removeEthToken(asset.token.address, chain);
    void refresh();
  };

  if (!isUnlocked) {
    return (
      <View style={s.container} testID="eth-screen">
        <Header onBack={() => router.back()} title={t('eth.title')} />
        <WalletUnlock />
      </View>
    );
  }

  return (
    <View style={s.container} testID="eth-screen">
      <Header onBack={() => router.back()} title={t('eth.title')} />

      <ScrollView contentContainerStyle={s.content}>
        {!isEc ? (
          <View style={s.card} testID="eth-ec-gate">
            <Text style={s.cardTitle}>{t('eth.ecRequiredTitle')}</Text>
            <Text style={s.meta}>{t('eth.ecRequired')}</Text>
            <TouchableOpacity style={s.btn} onPress={() => router.push('/home/keys')} accessibilityRole="button">
              <Text style={s.btnText}>{t('eth.ecRequiredAction')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={s.card}>
              <View style={s.rowBetween}>
                <Text style={s.cardTitle}>{t('eth.account')}</Text>
                <TouchableOpacity onPress={() => router.push('/settings')} accessibilityRole="button">
                  <Text style={s.link}>{chain.name} · {t('eth.networkSettings')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.address} testID="eth-address" selectable>{account}</Text>
              <View style={s.row}>
                <TouchableOpacity style={s.btnSmall} onPress={() => void copy(account)} testID="eth-copy-address">
                  <Text style={s.btnSmallText}>{t('eth.copy')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.btnSmall} onPress={() => void refresh()} testID="eth-refresh">
                  <Text style={s.btnSmallText}>{loading ? '…' : t('eth.refresh')}</Text>
                </TouchableOpacity>
              </View>
            </View>

            {error ? <Text style={s.error} testID="eth-error">{error}</Text> : null}
            {notice ? <Text style={s.notice} testID="eth-notice">{notice}</Text> : null}

            <View style={s.card}>
              <Text style={s.cardTitle}>{t('eth.balances')}</Text>
              {loading && balances.length === 0 ? (
                <ActivityIndicator style={{ padding: 24 }} />
              ) : (
                assets.map((asset) => (
                  <View key={asset.key} style={s.assetRow} testID={`eth-asset-${asset.symbol}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.assetSymbol}>{asset.symbol}</Text>
                      <Text style={s.assetBalance}>
                        {formatUnits(balanceOf(asset), asset.decimals, locale)}
                      </Text>
                    </View>
                    <TouchableOpacity
                      style={s.btnSmall}
                      onPress={() => { setDeposit(asset); setWithdraw(null); setError(''); }}
                      accessibilityRole="button"
                      testID={`eth-deposit-${asset.symbol}`}
                    >
                      <Text style={s.btnSmallText}>{t('eth.deposit')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.btnSmall}
                      onPress={() => startWithdraw(asset)}
                      accessibilityRole="button"
                      testID={`eth-withdraw-${asset.symbol}`}
                    >
                      <Text style={s.btnSmallText}>{t('eth.withdraw')}</Text>
                    </TouchableOpacity>
                    {asset.token && !chain.tokens.some((b) => b.address.toLowerCase() === asset.token!.address.toLowerCase()) ? (
                      <TouchableOpacity onPress={() => removeToken(asset)} accessibilityRole="button">
                        <Text style={s.remove}>×</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ))
              )}
              <TouchableOpacity style={s.btn} onPress={() => setAddOpen(true)} accessibilityRole="button" testID="eth-add-token">
                <Text style={s.btnText}>{t('eth.addToken')}</Text>
              </TouchableOpacity>
              {addOpen ? (
                <View style={s.addBox}>
                  <TextInput
                    style={s.input}
                    value={tokenAddress}
                    onChangeText={setTokenAddress}
                    placeholder={t('eth.tokenAddressPh')}
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID="eth-token-address"
                  />
                  <View style={s.row}>
                    <TouchableOpacity style={s.btnSmall} onPress={() => void addToken()} disabled={adding} testID="eth-token-add">
                      <Text style={s.btnSmallText}>{adding ? '…' : t('eth.add')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={s.btnSmall} onPress={() => { setAddOpen(false); setTokenAddress(''); }}>
                      <Text style={s.btnSmallText}>{t('eth.cancel')}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : null}
            </View>

            {deposit ? (
              <View style={s.card} testID="eth-deposit-card">
                <Text style={s.cardTitle}>{t('eth.depositTitle', { symbol: deposit.symbol })}</Text>
                <View style={s.qrBox}>
                  <QRCode value={depositUri} size={200} backgroundColor="#fff" color="#000" />
                </View>
                <Text style={s.address} selectable testID="eth-deposit-address">{account}</Text>
                <Text style={s.warn}>{t('eth.depositWarn', { symbol: deposit.symbol, network: chain.name })}</Text>
                <Text style={s.meta}>{t('eth.noMemo')}</Text>
                <View style={s.row}>
                  <TouchableOpacity style={s.btnSmall} onPress={() => void copy(account)} testID="eth-deposit-copy">
                    <Text style={s.btnSmallText}>{t('eth.copyAddress')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btnSmall} onPress={() => void copy(depositUri)}>
                    <Text style={s.btnSmallText}>{t('eth.copyUri')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btnSmall} onPress={() => setDeposit(null)}>
                    <Text style={s.btnSmallText}>{t('eth.close')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            {withdraw ? (
              <View style={s.card} testID="eth-withdraw-card">
                <Text style={s.cardTitle}>{t('eth.withdrawTitle', { symbol: withdraw.symbol })}</Text>
                <Text style={s.meta}>{t('eth.available', { amount: formatUnits(balanceOf(withdraw), withdraw.decimals, locale), symbol: withdraw.symbol })}</Text>
                <Text style={s.label}>{t('eth.recipient')}</Text>
                <TextInput
                  style={s.input}
                  value={to}
                  onChangeText={setTo}
                  placeholder={t('eth.recipientPh')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="eth-withdraw-to"
                />
                <Text style={s.label}>{t('eth.amount')}</Text>
                <TextInput
                  style={s.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.0"
                  keyboardType="decimal-pad"
                  testID="eth-withdraw-amount"
                />
                <Text style={s.meta} testID="eth-fee">
                  {preparing
                    ? t('eth.estimating')
                    : prepared
                      ? t('eth.feeLine', {
                        fee: formatUnits(prepared.maxFeeWei, 18, locale),
                        gas: prepared.gasLimit.toString(),
                      })
                      : t('eth.feeUnknown')}
                </Text>
                <View style={s.row}>
                  <TouchableOpacity
                    style={[s.btn, sending && s.btnDisabled]}
                    onPress={() => void submitWithdraw()}
                    disabled={sending}
                    accessibilityRole="button"
                    testID="eth-withdraw-submit"
                  >
                    <Text style={s.btnText}>{sending ? t('eth.sending') : t('eth.withdraw')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btnSmall} onPress={() => setWithdraw(null)}>
                    <Text style={s.btnSmallText}>{t('eth.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            <View style={s.card}>
              <Text style={s.cardTitle}>{t('eth.activity')}</Text>
              {activity.length === 0 ? (
                <Text style={s.meta}>{t('eth.emptyActivity')}</Text>
              ) : (
                activity.map((item) => (
                  <View key={item.hash} style={s.activityRow} testID={`eth-activity-${item.hash.slice(0, 10)}`}>
                    <Text style={s.assetBalance}>{item.amount} {item.symbol}</Text>
                    <Text style={s.meta}>{t(`eth.state_${item.status}`)}</Text>
                    <Text style={s.hash} selectable onPress={() => void copy(ethExplorerTx(chain, item.hash))}>
                      {shortHex(item.hash)}
                    </Text>
                  </View>
                ))
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Header({ onBack, title }: { onBack: () => void; title: string }) {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={onBack} style={s.backBtn} accessibilityRole="button">
        <Text style={s.backText}>←</Text>
      </TouchableOpacity>
      <Text style={s.pageTitle}>{title}</Text>
    </View>
  );
}

function shortHex(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : hash;
}

function isValidChecksumSafe(value: string): boolean {
  try {
    requireAddress(value);
    return true;
  } catch {
    return false;
  }
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  content: { padding: 16, paddingTop: 4 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  address: { fontFamily: MONO_FONT, fontSize: 12, color: theme.colors.text.primary, marginTop: 4 },
  label: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginTop: 10, marginBottom: 4 },
  meta: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  warn: { fontSize: 12, color: '#B45309', marginTop: 8 },
  error: { fontSize: 13, color: '#E5484D', marginBottom: 8 },
  notice: { fontSize: 13, color: '#1F9D55', marginBottom: 8 },
  link: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  btn: { marginTop: 10, backgroundColor: theme.colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  btnSmall: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  btnSmallText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.primary },
  assetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  assetSymbol: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  assetBalance: { fontSize: 13, color: theme.colors.text.primary },
  activityRow: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 2 },
  hash: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.link },
  remove: { fontSize: 16, fontWeight: '700', color: theme.colors.text.secondary, paddingHorizontal: 4 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13 },
  addBox: { marginTop: 8 },
  qrBox: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, marginVertical: 8 },
}));
