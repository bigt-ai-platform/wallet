import * as React from 'react';
import {
  ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { ethereumKey } from '@/lib/walletKeys';
import { useTransactionConfirm } from '@/components/TransactionConfirm';
import WalletUnlock from '@/components/WalletUnlock';
import { notifySystemMessage } from '@/services/systemMessages';
import {
  accountFromPrivateKey, assetsOf, loadBalances, prepareNativeTransfer,
  prepareTokenTransfer, sendNativeTransfer, sendTokenTransfer, waitForReceipt,
  type EthAsset, type GasPreset, type PreparedTransfer,
} from '@/services/eth';
import { getEthChain } from '@/services/ethRpc';
import { ethExplorerTx } from '@/lib/eth/chains';
import { formatUnits, parseUnits, shortAddress } from '@/lib/eth/units';
import { isAddress, requireAddress } from '@/lib/eth/address';
import { MONO_FONT } from '@/constants/fonts';

/**
 * Withdraw (exchange style): Select Asset -> Select Network -> address, amount,
 * network fee, review. Same signer as the Ethereum screen; this is the focused
 * counterpart of the Deposit page.
 */

type Step = 'asset' | 'network' | 'form';

interface Activity {
  hash: string;
  symbol: string;
  amount: string;
  status: 'pending' | 'success' | 'failed';
}

/** Navigation helper: the generated typed-route union lags behind new screens. */
type RouteTarget = Parameters<ReturnType<typeof useRouter>['push']>[0];

export default function WithdrawScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const confirmTx = useTransactionConfirm();
  const { isUnlocked, getUnlockedWallet } = useWallet();
  const locale = i18n.language || 'en';

  const wallet = getUnlockedWallet();
  // Dual-key wallets sign Ethereum with their EC key, whatever the primary
  // (Bigtangle) key type is.
  const ethKey = wallet ? ethereumKey(wallet) : null;
  const privateKey = ethKey?.privateKey;
  const isEc = !!ethKey;
  const account = React.useMemo(
    () => (privateKey ? accountFromPrivateKey(privateKey) : ''),
    [privateKey]
  );

  const [chain] = React.useState(() => getEthChain());
  const [step, setStep] = React.useState<Step>('asset');
  const [asset, setAsset] = React.useState<EthAsset | null>(null);
  const [balances, setBalances] = React.useState<Record<string, bigint>>({});
  const [loading, setLoading] = React.useState(false);

  const [to, setTo] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [preset, setPreset] = React.useState<GasPreset>('standard');
  const [prepared, setPrepared] = React.useState<PreparedTransfer | null>(null);
  const [preparing, setPreparing] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [activity, setActivity] = React.useState<Activity[]>([]);

  const assets = assetsOf(chain);

  const refreshBalances = React.useCallback(async () => {
    if (!account) return;
    setLoading(true);
    try {
      const rows = await loadBalances(account, chain);
      const next: Record<string, bigint> = {};
      for (const row of rows) next[row.asset.key] = row.raw;
      setBalances(next);
    } catch {
      setBalances({});
    } finally {
      setLoading(false);
    }
  }, [account, chain]);

  React.useEffect(() => {
    if (step !== 'asset') return;
    void refreshBalances();
  }, [step, refreshBalances]);

  const balanceOf = (a: EthAsset): bigint => balances[a.key] ?? 0n;

  // Fee preview, recomputed on every change (same rules as /ethereum).
  React.useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    if (!asset || !privateKey || !isAddress(to) || !amount) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, asset.decimals);
    } catch {
      return;
    }
    if (raw <= 0n) return;
    setPreparing(true);
    const run = async () => {
      try {
        const req = { privateKeyHex: privateKey, to, amount: raw, chain, preset };
        const next = asset.token
          ? await prepareTokenTransfer({ ...req, token: asset.token })
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
  }, [asset?.key, to, amount, preset, chain.id, privateKey]);

  const track = async (row: Activity) => {
    const receipt = await waitForReceipt(row.hash, chain, { attempts: 45, intervalMs: 4000 });
    const status = receipt?.status === 'success' ? 'success' : receipt ? 'failed' : 'pending';
    setActivity((prev) => prev.map((a) => (a.hash === row.hash ? { ...a, status } : a)));
    if (status === 'success') {
      notifySystemMessage({
        tone: 'success',
        title: t('eth.sentTitle'),
        body: t('eth.sentBody', { amount: row.amount, symbol: row.symbol, hash: shortAddress(row.hash) }),
      });
    } else if (status === 'failed') {
      notifySystemMessage({ tone: 'error', title: t('eth.failedTitle'), body: t('eth.failedBody', { hash: shortAddress(row.hash) }) });
    }
  };

  const submit = async () => {
    if (!asset || !privateKey || sending) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, asset.decimals);
    } catch {
      setError(t('eth.errAmount'));
      return;
    }
    if (raw <= 0n) {
      setError(t('eth.errAmount'));
      return;
    }
    try {
      requireAddress(to);
    } catch {
      setError(t('eth.errAddress'));
      return;
    }
    if (raw > balanceOf(asset)) {
      setError(t('eth.errInsufficient'));
      return;
    }
    const ok = await confirmTx({
      title: t('eth.confirmTitle'),
      subtitle: t('eth.confirmSubtitle', {
        amount: formatUnits(raw, asset.decimals, locale),
        symbol: asset.symbol,
        to: shortAddress(to),
      }),
    });
    if (!ok) return;
    setSending(true);
    setError('');
    try {
      const req = { privateKeyHex: privateKey, to, amount: raw, chain, preset };
      const sent = asset.token
        ? await sendTokenTransfer({ ...req, token: asset.token })
        : await sendNativeTransfer(req);
      const row: Activity = {
        hash: sent.hash,
        symbol: asset.symbol,
        amount: formatUnits(raw, asset.decimals, locale),
        status: 'pending',
      };
      setActivity((prev) => [row, ...prev].slice(0, 20));
      setNotice(t('eth.sentNotice', { hash: `${sent.hash.slice(0, 10)}…` }));
      setAmount('');
      setTo('');
      void track(row);
      void refreshBalances();
    } catch (e) {
      const msg = (e as Error).message || '';
      setError(/own address/i.test(msg) ? t('eth.errSelf') : msg || t('eth.errSend'));
    } finally {
      setSending(false);
    }
  };

  if (!isUnlocked) {
    return (
      <View style={s.container} testID="withdraw-screen">
        <Header title={t('withdraw.title')} onBack={() => router.back()} />
        <WalletUnlock />
      </View>
    );
  }

  if (!isEc) {
    return (
      <View style={s.container} testID="withdraw-screen">
        <Header title={t('withdraw.title')} onBack={() => router.back()} />
        <View style={s.content}>
          <View style={s.card} testID="withdraw-ec-gate">
            <Text style={s.cardTitle}>{t('eth.ecRequiredTitle')}</Text>
            <Text style={s.meta}>{t('eth.ecRequired')}</Text>
            <TouchableOpacity style={s.btn} onPress={() => router.push('/home/keys')} accessibilityRole="button">
              <Text style={s.btnText}>{t('eth.ecRequiredAction')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={s.container} testID="withdraw-screen">
      <Header
        title={step === 'asset' ? t('withdraw.title') : step === 'network' ? t('deposit.selectNetwork') : t('eth.withdrawTitle', { symbol: asset?.symbol ?? '' })}
        onBack={() => {
          if (step === 'form') setStep('network');
          else if (step === 'network') setStep('asset');
          else router.back();
        }}
      />
      <ScrollView contentContainerStyle={s.content}>
        <View style={s.tabs} testID="withdraw-tabs">
          <TouchableOpacity
            style={s.tab}
            onPress={() => router.push('/deposit' as RouteTarget)}
            accessibilityRole="button"
            testID="withdraw-tab-deposit"
          >
            <Text style={s.tabText}>{t('deposit.tabDeposit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.tab, s.tabOn]} accessibilityRole="button">
            <Text style={[s.tabText, s.tabTextOn]}>{t('deposit.tabWithdraw')}</Text>
          </TouchableOpacity>
        </View>

        {error ? <Text style={s.error} testID="withdraw-error">{error}</Text> : null}
        {notice ? <Text style={s.notice} testID="withdraw-notice">{notice}</Text> : null}

        {step === 'asset' ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{t('deposit.selectCoin')}</Text>
            {loading ? <ActivityIndicator style={{ padding: 16 }} /> : null}
            {assets.map((a) => (
              <TouchableOpacity
                key={a.key}
                style={s.row}
                onPress={() => { setAsset(a); setStep('network'); }}
                accessibilityRole="button"
                testID={`withdraw-asset-${a.symbol}`}
              >
                <AssetBadge symbol={a.symbol} />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{a.symbol}</Text>
                  <Text style={s.meta}>{formatUnits(balanceOf(a), a.decimals, locale)}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {step === 'network' ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{t('deposit.selectNetwork')}</Text>
            <TouchableOpacity
              style={s.row}
              onPress={() => setStep('form')}
              accessibilityRole="button"
              testID="withdraw-network-ethereum"
            >
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle}>{chain.name}</Text>
                <Text style={s.meta}>{t('withdraw.networkHint', { chain: chain.name })}</Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {step === 'form' && asset ? (
          <>
            <View style={s.card} testID="withdraw-form">
              <Text style={s.cardTitle}>{t('eth.withdrawTitle', { symbol: asset.symbol })}</Text>
              <Text style={s.meta}>{t('eth.available', { amount: formatUnits(balanceOf(asset), asset.decimals, locale), symbol: asset.symbol })}</Text>

              <Text style={s.label}>{t('eth.recipient')}</Text>
              <TextInput
                style={s.input}
                value={to}
                onChangeText={setTo}
                placeholder={t('eth.recipientPh')}
                autoCapitalize="none"
                autoCorrect={false}
                testID="withdraw-to"
              />

              <Text style={s.label}>{t('eth.amount')}</Text>
              <TextInput
                style={s.input}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.0"
                keyboardType="decimal-pad"
                testID="withdraw-amount"
              />

              <Text style={s.label}>{t('eth.gasPreset')}</Text>
              <View style={s.row} testID="withdraw-gas-presets">
                {(['slow', 'standard', 'fast'] as GasPreset[]).map((p) => (
                  <TouchableOpacity
                    key={p}
                    onPress={() => setPreset(p)}
                    style={[s.chip, preset === p && s.chipOn]}
                    accessibilityRole="button"
                    testID={`withdraw-gas-${p}`}
                  >
                    <Text style={[s.chipText, preset === p && s.chipTextOn]}>{t(`eth.gas_${p}`)}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={s.meta} testID="withdraw-fee">
                {preparing
                  ? t('eth.estimating')
                  : prepared
                    ? asset.token
                      ? t('eth.feeLine', {
                        fee: formatUnits(prepared.maxFeeWei, 18, locale),
                        gas: prepared.gasLimit.toString(),
                      })
                      : t('withdraw.totalDebit', {
                        total: formatUnits(prepared.amount + prepared.maxFeeWei, 18, locale),
                        symbol: asset.symbol,
                      })
                    : t('eth.feeUnknown')}
              </Text>
              {asset.token && prepared ? (
                <Text style={s.meta}>{t('withdraw.feePaidIn', { symbol: chain.nativeSymbol })}</Text>
              ) : null}

              <TouchableOpacity
                style={[s.btn, sending && s.btnDisabled]}
                onPress={() => void submit()}
                disabled={sending}
                accessibilityRole="button"
                testID="withdraw-submit"
              >
                <Text style={s.btnText}>{sending ? t('eth.sending') : t('eth.withdraw')}</Text>
              </TouchableOpacity>
            </View>

            <View style={s.card} testID="withdraw-history">
              <Text style={s.cardTitle}>{t('eth.activity')}</Text>
              {activity.length === 0 ? (
                <Text style={s.meta}>{t('eth.emptyActivity')}</Text>
              ) : (
                activity.map((a) => (
                  <View key={a.hash} style={s.historyRow} testID="withdraw-history-row">
                    <Text style={s.rowTitle}>{a.amount} {a.symbol}</Text>
                    <Text style={s.meta}>{t(`eth.state_${a.status}`)}</Text>
                    <Text style={s.hash} selectable>{ethExplorerTx(chain, a.hash)}</Text>
                  </View>
                ))
              )}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function AssetBadge({ symbol }: { symbol: string }) {
  const colors: Record<string, string> = { USDT: '#26A17B', USDC: '#2775CA', ETH: '#627EEA' };
  return (
    <View style={[s.badge, { backgroundColor: colors[symbol] ?? '#6B7280' }]}>
      <Text style={s.badgeText}>{(symbol === 'USDT' ? '₮' : symbol.slice(0, 2)).slice(0, 2)}</Text>
    </View>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={s.header}>
      <TouchableOpacity onPress={onBack} style={s.backBtn} accessibilityRole="button">
        <Text style={s.backText}>←</Text>
      </TouchableOpacity>
      <Text style={s.pageTitle}>{title}</Text>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  content: { padding: 16, paddingTop: 4 },
  tabs: { flexDirection: 'row', borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: 'hidden', marginBottom: 12 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabOn: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  tabTextOn: { color: '#FFFFFF' },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border, flexWrap: 'wrap' },
  rowTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  meta: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  label: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginTop: 10, marginBottom: 4 },
  error: { fontSize: 13, color: '#E5484D', marginBottom: 8 },
  notice: { fontSize: 13, color: '#1F9D55', marginBottom: 8 },
  chevron: { fontSize: 20, color: theme.colors.text.secondary, paddingHorizontal: 6 },
  btn: { marginTop: 12, backgroundColor: theme.colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13 },
  chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  chipOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.primary },
  chipTextOn: { color: '#FFFFFF' },
  badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
  historyRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  hash: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.link, marginTop: 2 },
}));
