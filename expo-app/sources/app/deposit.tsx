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
import { ethereumKey } from '@/lib/walletKeys';
import { useTransactionConfirm } from '@/components/TransactionConfirm';
import WalletUnlock from '@/components/WalletUnlock';
import { httpService } from '@/services/http';
import { notifySystemMessage } from '@/services/systemMessages';
import {
  accountFromPrivateKey, getErc20Balance, sendTokenTransfer,
} from '@/services/eth';
import {
  getBridgeDeposits, getBridgeSettings, getDepositAddress, isBridgeConfigured,
  type BridgeDeposit, type DepositAddress,
} from '@/services/ethBridge';
import { getEthChain } from '@/services/ethRpc';
import { buildEthPaymentUri } from '@/lib/eth/eip681';
import { formatUnits, parseUnits, shortAddress } from '@/lib/eth/units';
import { isAddress, toChecksumAddress } from '@/lib/eth/address';
import { DEPOSIT_ASSETS, findDepositAsset, findDepositNetwork, type DepositNetwork } from '@/lib/depositAssets';
import { MONO_FONT } from '@/constants/fonts';

/**
 * Deposit (exchange style): pick coin -> pick network -> address + QR + memo.
 *
 * For USDT on Ethereum the address is the issuer's (or the user's own, when the
 * issuer API assigns one) and the issuer credits the same amount of the USDT
 * token created on the L1 order chain to this wallet's L1 address. The wallet
 * can also pay the deposit from its own Ethereum balance.
 */

type Step = 'coin' | 'network' | 'address';

/** Navigation helper: the generated typed-route union lags behind new screens. */
type RouteTarget = Parameters<ReturnType<typeof useRouter>['push']>[0];

export default function DepositScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const confirmTx = useTransactionConfirm();
  const { isUnlocked, publicInfo, getUnlockedWallet } = useWallet();
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

  const l1Chain = React.useMemo(
    () => httpService.getL1Chains().find((c) => c.chainId === 'ordermatch') ?? httpService.getL1Chains()[0],
    []
  );

  const [step, setStep] = React.useState<Step>('coin');
  const [coin, setCoin] = React.useState('USDT');
  const [network, setNetwork] = React.useState<DepositNetwork | null>(null);
  const [search, setSearch] = React.useState('');
  const [target, setTarget] = React.useState<DepositAddress | null>(null);
  const [targetError, setTargetError] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const [sourceBalance, setSourceBalance] = React.useState<bigint>(0n);
  const [l1Balance, setL1Balance] = React.useState<string>('');
  const [history, setHistory] = React.useState<BridgeDeposit[]>([]);

  const [amount, setAmount] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [error, setError] = React.useState('');

  const bridge = getBridgeSettings();
  const min = Number(bridge.minUsdt || '0');
  const asset = findDepositAsset(coin);
  const networks = asset?.networks ?? [];

  const loadAddress = React.useCallback(async () => {
    if (!account) return;
    setLoading(true);
    setTargetError('');
    try {
      const next = await getDepositAddress(account);
      setTarget(next);
      if (!next) setTargetError(t('deposit.notConfigured'));
    } catch (e) {
      setTarget(null);
      setTargetError((e as Error).message || t('deposit.notConfigured'));
    } finally {
      setLoading(false);
    }
  }, [account, t]);

  const loadBalancesAndHistory = React.useCallback(async () => {
    if (!account || !network) return;
    try {
      setSourceBalance(await getErc20Balance(network.tokenAddress, account, getEthChain()));
    } catch {
      setSourceBalance(0n);
    }
    // L1 credit destination: the wallet's Bigtangle address on the order chain.
    // The USDT token id is chain-specific, so look it up in its balances.
    const bigtanglePrivateKey = wallet?.wallet.privateKey;
    const bigtangleKeyType = wallet?.wallet.keyType;
    if (bigtanglePrivateKey && l1Chain) {
      try {
        const res = await httpService.getBalancesOn(l1Chain.url, bigtanglePrivateKey, bigtangleKeyType);
        const usdt = (res.data ?? []).find(
          (b) => (b.tokenname || '').toUpperCase().includes('USDT') || b.tokenid?.toLowerCase().includes('usdt')
        );
        setL1Balance(usdt ? `${usdt.balance} ${usdt.tokenname || 'USDT'}` : t('deposit.l1Unavailable'));
      } catch {
        setL1Balance(t('deposit.l1Unavailable'));
      }
    }
    try {
      const remote = await getBridgeDeposits(publicInfo?.address ?? account);
      // Keep locally-sent deposits the issuer has not reported yet.
      setHistory((prev) => {
        const localOnly = prev.filter((p) => !remote.some((r) => r.hash === p.hash));
        return [...remote, ...localOnly];
      });
    } catch {
      /* keep the local history when the API is unreachable */
    }
  }, [account, network, wallet, l1Chain, publicInfo?.address, t]);

  React.useEffect(() => {
    if (step === 'address') void loadAddress();
  }, [step, loadAddress]);

  React.useEffect(() => {
    if (step === 'address') void loadBalancesAndHistory();
  }, [step, loadBalancesAndHistory]);

  const copy = async (value: string) => {
    await Clipboard.setStringAsync(value);
    setNotice(t('eth.copied'));
  };

  const qrValue = React.useMemo(() => {
    if (!target || !network) return '';
    try {
      return buildEthPaymentUri({
        address: toChecksumAddress(target.address),
        chainId: getEthChain().chainId,
      });
    } catch {
      return target.address;
    }
  }, [target, network]);

  const submitFromWallet = async () => {
    if (!target || !network || !privateKey || sending) return;
    let raw: bigint;
    try {
      raw = parseUnits(amount, network.decimals);
    } catch {
      setError(t('eth.errAmount'));
      return;
    }
    if (raw <= 0n) {
      setError(t('eth.errAmount'));
      return;
    }
    if (min > 0 && Number(amount) < min) {
      setError(t('deposit.errMin', { amount: bridge.minUsdt }));
      return;
    }
    if (raw > sourceBalance) {
      setError(t('eth.errInsufficient'));
      return;
    }
    if (!isAddress(target.address)) {
      setError(t('eth.errAddress'));
      return;
    }
    const ok = await confirmTx({
      title: t('deposit.title'),
      subtitle: t('deposit.confirmSubtitle', {
        amount: formatUnits(raw, network.decimals, locale),
        coin,
        to: shortAddress(target.address),
      }),
    });
    if (!ok) return;
    setSending(true);
    setError('');
    try {
      const sent = await sendTokenTransfer({
        privateKeyHex: privateKey,
        token: { address: network.tokenAddress, symbol: coin, decimals: network.decimals },
        to: target.address,
        amount: raw,
        chain: getEthChain(),
      });
      const row: BridgeDeposit = {
        hash: sent.hash,
        amount: formatUnits(raw, network.decimals, locale),
        status: 'pending',
      };
      setHistory((prev) => [row, ...prev]);
      setNotice(t('deposit.sentNotice', { hash: sent.hash.slice(0, 10) }));
      notifySystemMessage({
        tone: 'success',
        title: t('deposit.title'),
        body: t('deposit.sentNotice', { hash: sent.hash.slice(0, 10) }),
      });
      setAmount('');
      setStep('address');
      void loadBalancesAndHistory();
    } catch (e) {
      setError((e as Error).message || t('eth.errSend'));
    } finally {
      setSending(false);
    }
  };

  if (!isUnlocked) {
    return (
      <View style={s.container} testID="deposit-screen">
        <Header title={t('deposit.title')} onBack={() => router.back()} />
        <WalletUnlock />
      </View>
    );
  }

  if (!isEc) {
    return (
      <View style={s.container} testID="deposit-screen">
        <Header title={t('deposit.title')} onBack={() => router.back()} />
        <View style={s.content}>
          <View style={s.card} testID="deposit-ec-gate">
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
    <View style={s.container} testID="deposit-screen">
      <Header
        title={step === 'coin' ? t('deposit.title') : step === 'network' ? t('deposit.selectNetwork') : t('deposit.addressTitle', { coin })}
        onBack={() => {
          if (step === 'address') setStep('network');
          else if (step === 'network') setStep('coin');
          else router.back();
        }}
      />
      <ScrollView contentContainerStyle={s.content}>
        {/* Exchange-style entry: Deposit | Withdraw, plus the fiat (P2P) path. */}
        <View style={s.tabs} testID="deposit-tabs">
          <TouchableOpacity style={[s.tab, s.tabOn]} accessibilityRole="button">
            <Text style={[s.tabText, s.tabTextOn]}>{t('deposit.tabDeposit')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.tab}
            onPress={() => router.push('/withdraw' as RouteTarget)}
            accessibilityRole="button"
            testID="deposit-tab-withdraw"
          >
            <Text style={s.tabText}>{t('deposit.tabWithdraw')}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={s.fiatLink} onPress={() => router.push('/p2p' as RouteTarget)} accessibilityRole="button">
          <Text style={s.link}>{t('deposit.fiatLink')}</Text>
        </TouchableOpacity>

        {error ? <Text style={s.error} testID="deposit-error">{error}</Text> : null}
        {notice ? <Text style={s.notice} testID="deposit-notice">{notice}</Text> : null}

        {step === 'coin' ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{t('deposit.selectCoin')}</Text>
            <TextInput
              style={s.input}
              value={search}
              onChangeText={setSearch}
              placeholder={t('deposit.searchPh')}
              autoCapitalize="none"
              testID="deposit-search"
            />
            {DEPOSIT_ASSETS.filter(
              (a) => !search || a.coin.toLowerCase().includes(search.toLowerCase()) || a.name.toLowerCase().includes(search.toLowerCase())
            ).map((a) => (
              <TouchableOpacity
                key={a.coin}
                style={s.row}
                onPress={() => { setCoin(a.coin); setStep('network'); }}
                accessibilityRole="button"
                testID={`deposit-coin-${a.coin}`}
              >
                <AssetBadge coin={a.coin} />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{a.coin}</Text>
                  <Text style={s.meta}>{a.name}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {step === 'network' ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>{t('deposit.selectNetwork')}</Text>
            {networks.map((n) => (
              <TouchableOpacity
                key={n.id}
                style={s.row}
                onPress={() => { setNetwork(n); setStep('address'); }}
                accessibilityRole="button"
                testID={`deposit-network-${n.id}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{n.name}</Text>
                  <Text style={s.meta}>{t('deposit.creditedTo')}: {t('deposit.l1Network', { chain: l1Chain?.name || 'L1' })}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        {step === 'address' && network ? (
          <>
            {loading ? <ActivityIndicator style={{ padding: 24 }} /> : null}
            {targetError ? (
              <View style={s.card}>
                <Text style={s.warn}>{targetError}</Text>
                <TouchableOpacity style={s.btn} onPress={() => router.push('/settings')} testID="deposit-open-settings">
                  <Text style={s.btnText}>{t('deposit.openSettings')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {target ? (
              <View style={s.card} testID="deposit-address-card">
                <Text style={s.cardTitle}>{t('deposit.addressTitle', { coin })}</Text>
                <View style={s.qrBox}>
                  <QRCode value={qrValue} size={190} backgroundColor="#fff" color="#000" />
                </View>
                <Text style={s.address} selectable testID="deposit-address">{toChecksumAddress(target.address)}</Text>
                <View style={s.row}>
                  <TouchableOpacity style={s.btnSmall} onPress={() => void copy(target.address)} testID="deposit-copy-address">
                    <Text style={s.btnSmallText}>{t('eth.copyAddress')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btnSmall} onPress={() => void copy(qrValue)}>
                    <Text style={s.btnSmallText}>{t('eth.copyUri')}</Text>
                  </TouchableOpacity>
                </View>
                {target.memo ? (
                  <View style={s.memoBox} testID="deposit-memo">
                    <Text style={s.label}>{t('deposit.memoLabel')}</Text>
                    <Text style={s.address} selectable>{target.memo}</Text>
                    <Text style={s.warn}>{t('deposit.memoWarning')}</Text>
                  </View>
                ) : null}
                <Text style={s.warn} testID="deposit-warning">
                  {t('eth.depositWarn', { symbol: coin, network: network.name })}
                </Text>
                <Text style={s.meta}>{target.source === 'api' ? t('deposit.issuerPerUser') : t('deposit.issuerStatic')}</Text>
                {min > 0 ? <Text style={s.meta}>{t('deposit.min', { amount: bridge.minUsdt })}</Text> : null}
                <Text style={s.meta}>{t('deposit.creditedTo')}: {publicInfo?.address}</Text>
                {l1Balance ? <Text style={s.meta} testID="deposit-l1-balance">{l1Balance}</Text> : null}
              </View>
            ) : null}

            {target ? (
              <View style={s.card} testID="deposit-pay-card">
                <Text style={s.cardTitle}>{t('deposit.payFromWallet')}</Text>
                <Text style={s.meta}>{t('eth.available', { amount: formatUnits(sourceBalance, network.decimals, locale), symbol: coin })}</Text>
                <TextInput
                  style={s.input}
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.0"
                  keyboardType="decimal-pad"
                  testID="deposit-amount"
                />
                <TouchableOpacity
                  style={[s.btn, sending && s.btnDisabled]}
                  onPress={() => void submitFromWallet()}
                  disabled={sending}
                  accessibilityRole="button"
                  testID="deposit-submit"
                >
                  <Text style={s.btnText}>{sending ? t('eth.sending') : t('deposit.submit')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            <View style={s.card} testID="deposit-history">
              <Text style={s.cardTitle}>{t('deposit.history')}</Text>
              {history.length === 0 ? (
                <Text style={s.meta}>{t('eth.emptyDeposits')}</Text>
              ) : (
                history.map((d) => (
                  <View key={d.hash} style={s.historyRow} testID="deposit-history-row">
                    <Text style={s.rowTitle}>+{d.amount} {coin}</Text>
                    <Text style={s.meta}>{t(`deposit.state_${d.status}`)}</Text>
                    <Text style={s.hash} onPress={() => void copy(`${network.explorer}/tx/${d.hash}`)}>
                      {d.hash.slice(0, 12)}…
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

/** Coin badge in the asset list (exchange-style circular logo). */
function AssetBadge({ coin }: { coin: string }) {
  const colors: Record<string, string> = {
    USDT: '#26A17B', USDC: '#2775CA', BNB: '#F3BA2F', BTC: '#F7931A', SOL: '#9945FF',
  };
  return (
    <View style={[s.badge, { backgroundColor: colors[coin] ?? '#6B7280' }]}>
      <Text style={s.badgeText}>{(coin === 'USDT' ? '₮' : coin.slice(0, 2)).slice(0, 2)}</Text>
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
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12 },
  cardTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border },
  rowTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  meta: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  warn: { fontSize: 12, color: '#B45309', marginTop: 8 },
  error: { fontSize: 13, color: '#E5484D', marginBottom: 8 },
  notice: { fontSize: 13, color: '#1F9D55', marginBottom: 8 },
  chevron: { fontSize: 20, color: theme.colors.text.secondary, paddingHorizontal: 6 },
  btn: { marginTop: 10, backgroundColor: theme.colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  btnSmall: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10, marginTop: 8 },
  btnSmallText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.primary },
  address: { fontFamily: MONO_FONT, fontSize: 12, color: theme.colors.text.primary, marginTop: 6 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13, marginTop: 8 },
  qrBox: { alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 10, padding: 12, marginVertical: 8 },
  memoBox: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, marginTop: 10 },
  label: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary },
  historyRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  hash: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.link, marginTop: 2 },
  tabs: { flexDirection: 'row', borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: 'hidden', marginBottom: 6 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10 },
  tabOn: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  tabTextOn: { color: '#FFFFFF' },
  fiatLink: { alignSelf: 'flex-end', paddingVertical: 4, marginBottom: 8 },
  link: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#FFFFFF', fontSize: 12, fontWeight: '800' },
}));
