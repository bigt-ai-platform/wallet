import * as React from 'react';
import {
  ActivityIndicator, Linking, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { useWallet } from '@/state/wallet';
import { ethereumKey } from '@/lib/walletKeys';
import { useTransactionConfirm } from '@/components/TransactionConfirm';
import WalletUnlock from '@/components/WalletUnlock';
import { notifySystemMessage } from '@/services/systemMessages';
import {
  accountFromPrivateKey, assetsOf, getFeeData, getTransactionReceipt, loadBalances,
  prepareNativeTransfer, prepareTokenTransfer, sendNativeTransfer, sendTokenTransfer,
  waitForReceipt, type EthAsset, type GasPreset, type PreparedTransfer,
} from '@/services/eth';
import {
  clearWithdrawals, deleteAddress, listSavedAddresses, listWithdrawals,
  recordWithdrawal, saveAddress, setWithdrawalStatus,
} from '@/services/withdrawLocal';
import type { SavedAddress, WithdrawalRecord } from '@/lib/withdrawLocal';
import { getEthChain } from '@/services/ethRpc';
import { ethExplorerTx } from '@/lib/eth/chains';
import { formatUnits, parseUnits, shortAddress } from '@/lib/eth/units';
import { isAddress, requireAddress, sameAddress } from '@/lib/eth/address';
import { MONO_FONT } from '@/constants/fonts';

/** Plain decimal string (no grouping) that `parseUnits` accepts back. */
function toPlainUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${raw / base}.${frac}` : `${raw / base}`;
}

/**
 * Withdraw (exchange style): Select Asset -> Select Network -> address, amount,
 * network fee, review. Same signer as the Ethereum screen; this is the focused
 * counterpart of the Deposit page.
 */

type Step = 'asset' | 'network' | 'form';

/** Navigation helper: the generated typed-route union lags behind new screens. */
type RouteTarget = Parameters<ReturnType<typeof useRouter>['push']>[0];

export default function WithdrawScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const params = useLocalSearchParams<{ symbol?: string }>();
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
  const assets = assetsOf(chain);
  // A route param (e.g. the Ethereum screen's Withdraw button) opens the form
  // for that asset directly.
  const initialAsset = assets.find((a) => a.symbol === params.symbol) ?? null;
  const [step, setStep] = React.useState<Step>(initialAsset ? 'form' : 'asset');
  const [asset, setAsset] = React.useState<EthAsset | null>(initialAsset);
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
  // Persisted across restarts (device storage).
  const [history, setHistory] = React.useState<WithdrawalRecord[]>(() => listWithdrawals());
  const [saved, setSaved] = React.useState<SavedAddress[]>(() => listSavedAddresses());
  const [saveOpen, setSaveOpen] = React.useState(false);
  const [saveLabel, setSaveLabel] = React.useState('');

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

  // Balances are needed on every step (a route param can open the form
  // directly, skipping the asset picker).
  React.useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);

  const balanceOf = (a: EthAsset): bigint => balances[a.key] ?? 0n;
  const nativeBalance = balances.native ?? 0n;

  const toTrimmed = to.trim();
  const addressError = !toTrimmed
    ? ''
    : !isAddress(toTrimmed)
      ? t('eth.errAddress')
      : account && sameAddress(toTrimmed, account)
        ? t('eth.errSelf')
        : '';

  const setMax = async () => {
    if (!asset) return;
    const bal = balanceOf(asset);
    if (asset.token) {
      setAmount(toPlainUnits(bal, asset.decimals));
      return;
    }
    // Native: leave room for the worst-case fee (21000 gas x 1.2 headroom).
    try {
      const gas = prepared?.gasLimit ?? 25200n;
      const fee = await getFeeData(chain, preset);
      const max = bal - gas * fee.maxFeePerGas;
      setAmount(toPlainUnits(max > 0n ? max : 0n, asset.decimals));
    } catch {
      setAmount(toPlainUnits(bal, asset.decimals));
    }
  };

  const paste = async () => {
    const text = (await Clipboard.getStringAsync()).trim();
    if (text) setTo(text);
  };

  // Fee preview, recomputed on every change (same rules as /ethereum).
  React.useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    if (!asset || !privateKey || !isAddress(toTrimmed) || addressError || !amount) return;
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
        const req = { privateKeyHex: privateKey, to: toTrimmed, amount: raw, chain, preset };
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
  }, [asset?.key, toTrimmed, addressError, amount, preset, chain.id, privateKey]);

  // A withdrawal sent in an earlier session may have confirmed while the app
  // was closed: resolve pending rows once on mount.
  React.useEffect(() => {
    let cancelled = false;
    const pending = listWithdrawals().filter((row) => row.status === 'pending');
    (async () => {
      for (const row of pending) {
        try {
          const receipt = await getTransactionReceipt(row.hash, chain);
          if (cancelled) return;
          if (receipt) {
            setHistory(setWithdrawalStatus(row.hash, receipt.status === 'success' ? 'success' : 'failed'));
          }
        } catch {
          /* transient RPC error — keep pending */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chain]);

  const track = async (row: WithdrawalRecord) => {
    const receipt = await waitForReceipt(row.hash, chain, { attempts: 45, intervalMs: 4000 });
    const status = receipt?.status === 'success' ? 'success' : receipt ? 'failed' : 'pending';
    setHistory(setWithdrawalStatus(row.hash, status));
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

  const confirmSaveAddress = () => {
    try {
      setSaved(saveAddress(to.trim(), saveLabel));
      setSaveOpen(false);
      setSaveLabel('');
      setNotice(t('withdraw.addressSaved'));
    } catch {
      setError(t('eth.errAddress'));
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
      requireAddress(toTrimmed);
    } catch {
      setError(t('eth.errAddress'));
      return;
    }
    if (addressError) {
      setError(addressError);
      return;
    }
    if (raw > balanceOf(asset)) {
      setError(t('eth.errInsufficient'));
      return;
    }
    // The fee is paid in the native coin on top of the amount (native) or
    // alongside the token transfer.
    if (prepared) {
      const nativeNeeded = asset.token ? prepared.maxFeeWei : raw + prepared.maxFeeWei;
      if (nativeNeeded > nativeBalance) {
        setError(asset.token
          ? t('withdraw.errGas', { symbol: chain.nativeSymbol })
          : t('eth.errInsufficient'));
        return;
      }
    }
    const ok = await confirmTx({
      title: t('eth.confirmTitle'),
      subtitle: prepared
        ? t('withdraw.confirmSubtitle', {
          amount: formatUnits(raw, asset.decimals, locale),
          symbol: asset.symbol,
          to: shortAddress(toTrimmed),
          network: chain.name,
          fee: formatUnits(prepared.maxFeeWei, 18, locale),
          native: chain.nativeSymbol,
        })
        : t('eth.confirmSubtitle', {
          amount: formatUnits(raw, asset.decimals, locale),
          symbol: asset.symbol,
          to: shortAddress(toTrimmed),
        }),
    });
    if (!ok) return;
    setSending(true);
    setError('');
    try {
      const req = { privateKeyHex: privateKey, to: toTrimmed, amount: raw, chain, preset };
      const sent = asset.token
        ? await sendTokenTransfer({ ...req, token: asset.token })
        : await sendNativeTransfer(req);
      const row: WithdrawalRecord = {
        hash: sent.hash,
        symbol: asset.symbol,
        amount: formatUnits(raw, asset.decimals, locale),
        to,
        network: chain.name,
        at: Date.now(),
        status: 'pending',
      };
      setHistory(recordWithdrawal(row));
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
                <Text style={s.rowTitle}>{chain.name}{asset?.token ? ' (ERC-20)' : ''}</Text>
                <Text style={s.meta}>{t('withdraw.networkHint', { chain: chain.name })}</Text>
                <Text style={s.meta}>{t('withdraw.feeIn', { symbol: chain.nativeSymbol })}</Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {step === 'form' && asset ? (
          <>
            <View style={s.card} testID="withdraw-form">
              <Text style={s.cardTitle}>{t('eth.withdrawTitle', { symbol: asset.symbol })}</Text>

              <Text style={s.label}>{t('eth.recipient')}</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={[s.input, s.inputFlex]}
                  value={to}
                  onChangeText={setTo}
                  placeholder={t('eth.recipientPh')}
                  autoCapitalize="none"
                  autoCorrect={false}
                  testID="withdraw-to"
                />
                <TouchableOpacity onPress={() => void paste()} style={s.inputAction} accessibilityRole="button" testID="withdraw-paste">
                  <Text style={s.inputActionText}>{t('withdraw.paste')}</Text>
                </TouchableOpacity>
              </View>
              {addressError ? <Text style={s.fieldError} testID="withdraw-address-error">{addressError}</Text> : null}

              {saved.length > 0 ? (
                <View testID="withdraw-saved-addresses">
                  <Text style={s.label}>{t('withdraw.savedAddresses')}</Text>
                  <View style={s.row}>
                    {saved.map((entry) => (
                      <View key={entry.address} style={s.savedChip}>
                        <TouchableOpacity
                          onPress={() => setTo(entry.address)}
                          accessibilityRole="button"
                          testID={`withdraw-use-saved-${entry.address.slice(2, 8)}`}
                        >
                          <Text style={s.chipText}>{entry.label || shortAddress(entry.address)}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => setSaved(deleteAddress(entry.address))}
                          accessibilityRole="button"
                          testID={`withdraw-remove-saved-${entry.address.slice(2, 8)}`}
                        >
                          <Text style={s.savedRemove}>×</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                </View>
              ) : null}

              {isAddress(to) && !saved.some((a) => a.address.toLowerCase() === to.trim().toLowerCase()) ? (
                <TouchableOpacity
                  style={s.chip}
                  onPress={() => setSaveOpen(true)}
                  accessibilityRole="button"
                  testID="withdraw-save-address"
                >
                  <Text style={s.chipText}>{t('withdraw.saveAddress')}</Text>
                </TouchableOpacity>
              ) : null}
              {saveOpen ? (
                <View style={s.row}>
                  <TextInput
                    style={[s.input, s.inputFlex]}
                    value={saveLabel}
                    onChangeText={setSaveLabel}
                    placeholder={t('withdraw.labelPh')}
                    testID="withdraw-save-label"
                  />
                  <TouchableOpacity
                    style={s.chip}
                    onPress={confirmSaveAddress}
                    accessibilityRole="button"
                    testID="withdraw-save-confirm"
                  >
                    <Text style={s.chipText}>{t('withdraw.save')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.chip}
                    onPress={() => { setSaveOpen(false); setSaveLabel(''); }}
                    accessibilityRole="button"
                  >
                    <Text style={s.chipText}>{t('eth.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}

              <Text style={s.label}>{t('withdraw.network')}</Text>
              <TouchableOpacity style={s.input} onPress={() => setStep('network')} accessibilityRole="button">
                <Text style={s.inputText}>{chain.name}{asset.token ? ' (ERC-20)' : ''}</Text>
              </TouchableOpacity>

              <Text style={s.label}>{t('eth.amount')}</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={[s.input, s.inputFlex]}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.0"
                  keyboardType="decimal-pad"
                  testID="withdraw-amount"
                />
                <TouchableOpacity onPress={() => void setMax()} style={s.inputAction} accessibilityRole="button" testID="withdraw-max">
                  <Text style={s.inputActionText}>{t('withdraw.max')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.meta}>{t('eth.available', { amount: formatUnits(balanceOf(asset), asset.decimals, locale), symbol: asset.symbol })}</Text>

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
              {prepared ? (
                <View style={s.receiveRow} testID="withdraw-receive">
                  <Text style={s.label}>{t('withdraw.receiveAmount')}</Text>
                  <Text style={s.receiveValue}>{formatUnits(prepared.amount, asset.decimals, locale)} {asset.symbol}</Text>
                </View>
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
              <View style={s.rowBetween}>
                <Text style={s.cardTitle}>{t('eth.activity')}</Text>
                {history.length > 0 ? (
                  <TouchableOpacity
                    onPress={() => { setHistory(clearWithdrawals()); setNotice(t('withdraw.cleared')); }}
                    accessibilityRole="button"
                    testID="withdraw-clear-history"
                  >
                    <Text style={s.link}>{t('withdraw.clearHistory')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {history.length === 0 ? (
                <Text style={s.meta}>{t('eth.emptyActivity')}</Text>
              ) : (
                history.map((a) => (
                  <View key={a.hash} style={s.historyRow} testID="withdraw-history-row">
                    <Text style={s.rowTitle}>{a.amount} {a.symbol} → {shortAddress(a.to)}</Text>
                    <Text style={s.meta}>{t(`eth.state_${a.status}`)}</Text>
                    <Text style={s.hash} onPress={() => void Linking.openURL(ethExplorerTx(chain, a.hash))}>
                      {t('deposit.txid')}: {shortAddress(a.hash)}
                    </Text>
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
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  link: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  savedChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 999, paddingVertical: 4, paddingLeft: 10, paddingRight: 6 },
  savedRemove: { fontSize: 14, fontWeight: '700', color: theme.colors.text.secondary, paddingHorizontal: 2 },
  hash: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.link, marginTop: 2 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  inputFlex: { flex: 1 },
  inputText: { fontSize: 13, color: theme.colors.text.primary },
  inputAction: { paddingHorizontal: 10, paddingVertical: 10 },
  inputActionText: { fontSize: 13, fontWeight: '700', color: theme.colors.text.link },
  fieldError: { fontSize: 12, color: '#E5484D', marginTop: 4 },
  receiveRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 },
  receiveValue: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary },
}));
