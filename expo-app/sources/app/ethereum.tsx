import * as React from 'react';
import {
  ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { useWallet } from '@/state/wallet';
import { ethereumKey } from '@/lib/walletKeys';
import WalletUnlock from '@/components/WalletUnlock';
import {
  accountFromPrivateKey, assetsOf, getErc20Meta, getIncomingDeposits, loadBalances,
  type DepositRow, type EthAsset, type EthAssetBalance,
} from '@/services/eth';
import {
  ETH_RPC_NOT_CONFIGURED, addEthToken, getEthChain, isEthRpcConfigured, removeEthToken,
} from '@/services/ethRpc';
import { ethExplorerTx } from '@/lib/eth/chains';
import { formatUnits, shortAddress } from '@/lib/eth/units';
import { isAddress, requireAddress } from '@/lib/eth/address';
import { MONO_FONT } from '@/constants/fonts';

/**
 * Ethereum account overview: address, balances, token list and deposit history.
 *
 * Payments live on the dedicated exchange-style pages: **Deposit** opens
 * `/deposit` and **Withdraw** opens `/withdraw`, each preselected with the
 * tapped asset (one canonical flow instead of duplicated inline sheets).
 */

/** Navigation helper: the generated typed-route union lags behind new screens. */
type RouteTarget = Parameters<ReturnType<typeof useRouter>['push']>[0];

export default function EthereumScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { isUnlocked, publicInfo, getUnlockedWallet } = useWallet();
  const locale = i18n.language || 'en';

  const wallet = getUnlockedWallet();
  const ethKey = wallet ? ethereumKey(wallet) : null;
  const hasEthKey = !!ethKey;
  const account = React.useMemo(
    () => (ethKey ? accountFromPrivateKey(ethKey.privateKey) : ''),
    [ethKey]
  );

  const [chain, setChain] = React.useState(() => getEthChain());
  const [balances, setBalances] = React.useState<EthAssetBalance[]>([]);
  const [deposits, setDeposits] = React.useState<DepositRow[]>([]);
  const [depositsLoading, setDepositsLoading] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [addOpen, setAddOpen] = React.useState(false);
  const [tokenAddress, setTokenAddress] = React.useState('');
  const [adding, setAdding] = React.useState(false);

  const assets = assetsOf(chain);
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
      const msg = (e as Error).message;
      setError(msg === ETH_RPC_NOT_CONFIGURED || !msg ? t('eth.notConfigured') : msg);
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

  // Incoming deposits: native transfers via the address index + ERC-20 logs.
  React.useEffect(() => {
    let cancelled = false;
    if (!account || !isEthRpcConfigured()) return;
    setDepositsLoading(true);
    getIncomingDeposits(account, chain)
      .then((rows) => {
        if (!cancelled) setDeposits(rows);
      })
      .catch(() => {
        if (!cancelled) setDeposits([]);
      })
      .finally(() => {
        if (!cancelled) setDepositsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, chain.id]);

  const copy = async (value: string) => {
    await Clipboard.setStringAsync(value);
    setNotice(t('eth.copied'));
  };

  const openDeposit = (asset: EthAsset) => {
    router.push(
      `/deposit?coin=${encodeURIComponent(asset.symbol)}&network=ethereum` as RouteTarget
    );
  };

  const openWithdraw = (asset: EthAsset) => {
    router.push(`/withdraw?symbol=${encodeURIComponent(asset.symbol)}` as RouteTarget);
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
        {!hasEthKey ? (
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
                      onPress={() => openDeposit(asset)}
                      accessibilityRole="button"
                      testID={`eth-deposit-${asset.symbol}`}
                    >
                      <Text style={s.btnSmallText}>{t('eth.deposit')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={s.btnSmall}
                      onPress={() => openWithdraw(asset)}
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

            <View style={s.card} testID="eth-deposits">
              <Text style={s.cardTitle}>{t('eth.deposits')}</Text>
              <Text style={s.meta}>{t('eth.depositNote')}</Text>
              {depositsLoading && deposits.length === 0 ? (
                <Text style={s.meta}>{t('eth.scanning')}</Text>
              ) : deposits.length === 0 ? (
                <Text style={s.meta}>{t('eth.emptyDeposits')}</Text>
              ) : (
                deposits.map((d, i) => (
                  <View key={`${d.hash}:${d.kind}:${i}`} style={s.activityRow} testID="eth-deposit-row">
                    <Text style={s.assetBalance}>
                      +{formatUnits(d.amount, d.decimals, locale)} {d.symbol}
                    </Text>
                    <Text style={s.meta}>{t('eth.depositFrom', { address: shortAddress(d.from || '…') })}</Text>
                    <Text style={s.hash} selectable onPress={() => void copy(ethExplorerTx(chain, d.hash))}>
                      {t('eth.depositBlock', { block: d.blockNumber })} · {shortHash(d.hash)}
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

function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 10)}…${hash.slice(-4)}` : hash;
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
  meta: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  error: { fontSize: 13, color: '#E5484D', marginBottom: 8 },
  notice: { fontSize: 13, color: '#1F9D55', marginBottom: 8 },
  link: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  btn: { marginTop: 10, backgroundColor: theme.colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  btnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  btnSmall: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
  btnSmallText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.primary },
  assetRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border },
  assetSymbol: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary },
  assetBalance: { fontSize: 13, color: theme.colors.text.primary },
  activityRow: { paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 2 },
  hash: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.link },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13 },
  addBox: { marginTop: 8 },
  remove: { fontSize: 16, fontWeight: '700', color: theme.colors.text.secondary, paddingHorizontal: 4 },
}));
