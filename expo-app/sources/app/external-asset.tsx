import * as React from 'react';
import {
  ActivityIndicator, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { MONO_FONT } from '@/constants/fonts';
import { shortAddress } from '@/lib/eth/units';
import {
  EXTERNAL_ASSETS,
  buildDepositReference,
  complianceFlags,
  formatExternalAmount,
  parseExternalAmount,
  type ExternalAsset,
  type ExternalAssetCompliance,
} from '@/lib/externalAssets';
import {
  DISTRIBUTOR_NOT_CONFIGURED,
  distributorAccount,
  getDistributorSettings,
  getExternalBalances,
  getExternalCatalogEntries,
  getExternalStatement,
  isDistributorConfigured,
  requestExternalMint,
  requestExternalRedeem,
  setDistributorSettings,
  submitExternalTransfer,
  validateTransfer,
  type ExternalBalance,
  type ExternalCatalogEntry,
  type ExternalMovement,
  type ExternalStatus,
  type TransferValidationError,
} from '@/services/distributor';
import { trackExternalOperation } from '@/services/externalOps';

/**
 * External assets (HKDAP first) — tokens issued on another chain and held
 * through an authorised distributor.
 *
 * Deliberately **not** part of the L0↔L1 vault peg: there is no wrapped token,
 * no anchor and no Ethereum key in the wallet. The screen is a thin, auditable
 * client over the distributor API (`services/distributor.ts`), so it works for
 * PQ wallets too — nothing here signs with a key we hold.
 */

const COMPLIANCE_KEY: Record<keyof ExternalAssetCompliance, string> = {
  permissioned: 'permissioned',
  allowlistRequired: 'allowlistRequired',
  pauseable: 'pauseable',
  freezeable: 'freezeable',
  mintRedeem: 'mintRedeemFlag',
};

const STATUS_KEY: Record<ExternalStatus, string> = {
  pending: 'status_pending',
  processing: 'status_processing',
  completed: 'status_completed',
  failed: 'status_failed',
};

export default function ExternalAssetScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { publicInfo } = useWallet();
  const locale = i18n.language || 'en';
  const walletAddress = publicInfo?.address ?? '';

  const [editing, setEditing] = React.useState(() => !isDistributorConfigured());
  const [apiUrl, setApiUrl] = React.useState(() => getDistributorSettings().apiUrl);
  const [token, setToken] = React.useState(() => getDistributorSettings().token);
  const [accountId, setAccountId] = React.useState(() => getDistributorSettings().accountId);

  const [balances, setBalances] = React.useState<ExternalBalance[]>([]);
  const [statement, setStatement] = React.useState<ExternalMovement[]>([]);
  const [catalog, setCatalog] = React.useState<ExternalCatalogEntry[]>([]);
  const [copied, setCopied] = React.useState(false);
  // Stable per session: the reference the user includes on a bank/vault
  // deposit must not change when the screen re-renders.
  const [referenceNonce] = React.useState(() => Date.now().toString(36));
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');

  const [assetId, setAssetId] = React.useState(EXTERNAL_ASSETS[0].id);
  const asset = EXTERNAL_ASSETS.find((a) => a.id === assetId) ?? EXTERNAL_ASSETS[0];
  const [to, setTo] = React.useState('');
  const [amount, setAmount] = React.useState('');
  const [memo, setMemo] = React.useState('');

  const account = distributorAccount(walletAddress);

  const load = React.useCallback(async () => {
    if (!isDistributorConfigured() || !walletAddress) return;
    setLoading(true);
    setError('');
    try {
      const [b, s, c] = await Promise.all([
        getExternalBalances(account),
        getExternalStatement(account),
        getExternalCatalogEntries().catch(() => [] as ExternalCatalogEntry[]),
      ]);
      setBalances(b);
      setStatement(s);
      setCatalog(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [account, walletAddress]);

  React.useEffect(() => { void load(); }, [load]);

  const saveSettings = () => {
    setDistributorSettings({ apiUrl, token, accountId });
    const now = isDistributorConfigured();
    setEditing(!now);
    if (now) {
      setNotice(t('extAsset.saved'));
      void load();
    }
  };

  const describeError = (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    return message === DISTRIBUTOR_NOT_CONFIGURED ? t('extAsset.notConfigured') : message;
  };

  const translationFor = (code: TransferValidationError) => t(`extAsset.${code}`);

  const submitTransfer = async () => {
    const invalid = validateTransfer({ account, assetId, to, amount });
    if (invalid) { setError(translationFor(invalid)); return; }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await submitExternalTransfer({ account, assetId, to, amount, memo });
      trackExternalOperation({ id: result.id, assetId: asset.id, symbol: asset.symbol, amount });
      setNotice(t('extAsset.submitted', { id: result.id }));
      setTo('');
      setAmount('');
      setMemo('');
      await load();
    } catch (e) {
      setError(t('extAsset.failed', { e: describeError(e) }));
    } finally {
      setBusy(false);
    }
  };

  const submitMintRedeem = async (kind: 'mint' | 'redeem') => {
    if (!account) { setError(t('extAsset.errAccount')); return; }
    try {
      if (parseExternalAmount(amount, asset) <= BigInt(0)) throw new Error('zero');
    } catch {
      setError(t('extAsset.errAmount'));
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const request = kind === 'mint' ? requestExternalMint : requestExternalRedeem;
      const result = await request(assetId, account, amount);
      trackExternalOperation({ id: result.id, assetId: asset.id, symbol: asset.symbol, amount });
      setNotice(t('extAsset.submitted', { id: result.id }));
      setAmount('');
      await load();
    } catch (e) {
      setError(t('extAsset.failed', { e: describeError(e) }));
    } finally {
      setBusy(false);
    }
  };

  const balanceOf = (id: string) => {
    const row = balances.find((b) => b.assetId === id);
    const item = EXTERNAL_ASSETS.find((a) => a.id === id);
    return row && item ? formatExternalAmount(row.available, item, locale) : null;
  };

  const assetOf = (id: string) =>
    EXTERNAL_ASSETS.find((a) => a.id === id) ?? EXTERNAL_ASSETS[0];

  const catalogEntry = (id: string) => catalog.find((entry) => entry.assetId === id);

  /** Bank/vault instructions come from the issuer; never hardcoded here. */
  const depositInstruction = () =>
    catalogEntry(asset.id)?.depositInstructions ?? t('extAsset.depositUnavailable');

  /** EVM deposits are addressed, not referenced. */
  const depositReference = () =>
    asset.depositKind === 'evm' ? '' : buildDepositReference(asset, account, referenceNonce);

  const depositAddress = () => catalogEntry(asset.id)?.depositAddress ?? '';

  const copyReference = async () => {
    const reference = depositReference();
    if (!reference) return;
    await Clipboard.setStringAsync(reference);
    setCopied(true);
  };

  return (
    <View style={s.container} testID="ext-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>‹</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('extAsset.title')}</Text>
      </View>

      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.subtitle}>{t('extAsset.subtitle')}</Text>

        {!!error && <Text style={s.error}>{error}</Text>}
        {!!notice && <Text style={s.notice}>{notice}</Text>}

        {editing ? (
          <View style={s.card} testID="ext-setup">
            <Text style={s.cardTitle}>{t('extAsset.setupTitle')}</Text>
            <Text style={s.meta}>{t('extAsset.setupDesc')}</Text>
            <Text style={s.label}>{t('extAsset.apiUrl')}</Text>
            <TextInput
              style={s.input}
              value={apiUrl}
              onChangeText={setApiUrl}
              placeholder={t('extAsset.apiUrlPh')}
              placeholderTextColor="#8A8A8E"
              autoCapitalize="none"
              autoCorrect={false}
              testID="ext-api-input"
            />
            <Text style={s.label}>{t('extAsset.token')}</Text>
            <TextInput
              style={s.input}
              value={token}
              onChangeText={setToken}
              placeholder={t('extAsset.tokenPh')}
              placeholderTextColor="#8A8A8E"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              testID="ext-token-input"
            />
            <Text style={s.label}>{t('extAsset.accountId')}</Text>
            <TextInput
              style={s.input}
              value={accountId}
              onChangeText={setAccountId}
              placeholder={t('extAsset.accountIdPh')}
              placeholderTextColor="#8A8A8E"
              autoCapitalize="none"
              autoCorrect={false}
              testID="ext-account-input"
            />
            <TouchableOpacity
              style={[s.btn, !apiUrl.trim() && s.btnDisabled]}
              disabled={!apiUrl.trim()}
              onPress={saveSettings}
              testID="ext-save"
            >
              <Text style={s.btnText}>{t('extAsset.save')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={s.card}>
              <View style={s.cardHead}>
                <Text style={s.cardTitle}>{t('extAsset.balances')}</Text>
                <TouchableOpacity onPress={() => void load()} disabled={loading} testID="ext-refresh">
                  <Text style={s.link}>{t('eth.refresh')}</Text>
                </TouchableOpacity>
              </View>
              {loading && <ActivityIndicator style={s.spinner} />}
              {EXTERNAL_ASSETS.map((item) => (
                <AssetRow
                  key={item.id}
                  item={item}
                  balance={balanceOf(item.id)}
                  onPress={() => setAssetId(item.id)}
                  selected={item.id === assetId}
                />
              ))}
              {!walletAddress && <Text style={s.warn}>{t('extAsset.errAccount')}</Text>}
            </View>

            <View style={s.card} testID="ext-deposit">
              <Text style={s.cardTitle}>{t('extAsset.depositTitle', { symbol: asset.symbol })}</Text>
              <Text style={s.meta}>{depositInstruction()}</Text>
              {depositReference() ? (
                <>
                  <Text style={s.label}>{t('extAsset.depositRef')}</Text>
                  <View style={s.refRow}>
                    <Text style={s.reference} testID="ext-deposit-ref">{depositReference()}</Text>
                    <TouchableOpacity
                      style={s.refCopy}
                      onPress={() => void copyReference()}
                      accessibilityRole="button"
                      testID="ext-copy-ref"
                    >
                      <Text style={s.link}>{copied ? t('extAsset.copied') : t('extAsset.copyRef')}</Text>
                    </TouchableOpacity>
                  </View>
                  <Text style={s.meta}>{t('extAsset.depositRefHint')}</Text>
                </>
              ) : null}
              {depositAddress() ? (
                <TouchableOpacity
                  style={s.btn}
                  onPress={() => router.push(
                    `/withdraw?symbol=${encodeURIComponent(asset.symbol)}&to=${encodeURIComponent(depositAddress() as string)}` as never,
                  )}
                  testID="ext-send-eth"
                >
                  <Text style={s.btnText}>{t('extAsset.sendEth')}</Text>
                </TouchableOpacity>
              ) : null}
              {depositAddress() ? <Text style={s.address}>{depositAddress()}</Text> : null}
            </View>

            <View style={s.card}>
              <Text style={s.cardTitle}>{t('extAsset.transfer')}</Text>
              <Text style={s.label}>{t('eth.recipient')}</Text>
              <TextInput
                style={s.input}
                value={to}
                onChangeText={setTo}
                placeholder={asset.destination === 'evm-address' ? '0x…' : t('extAsset.accountId')}
                placeholderTextColor="#8A8A8E"
                autoCapitalize="none"
                autoCorrect={false}
                testID="ext-to"
              />
              <Text style={s.label}>{t('eth.amount', { symbol: asset.symbol })}</Text>
              <TextInput
                style={s.input}
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor="#8A8A8E"
                keyboardType="decimal-pad"
                testID="ext-amount"
              />
              <Text style={s.label}>{t('transaction.memo')}</Text>
              <TextInput
                style={s.input}
                value={memo}
                onChangeText={setMemo}
                autoCorrect={false}
                testID="ext-memo"
              />
              <TouchableOpacity
                style={[s.btn, busy && s.btnDisabled]}
                disabled={busy}
                onPress={() => void submitTransfer()}
                testID="ext-submit"
              >
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.btnText}>{t('extAsset.submit')}</Text>}
              </TouchableOpacity>
              <View style={s.miniRow}>
                <TouchableOpacity style={s.btnSmall} disabled={busy} onPress={() => void submitMintRedeem('mint')} testID="ext-mint">
                  <Text style={s.btnSmallText}>{t('extAsset.mint')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={s.btnSmall} disabled={busy} onPress={() => void submitMintRedeem('redeem')} testID="ext-redeem">
                  <Text style={s.btnSmallText}>{t('extAsset.redeem')}</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.warn}>{t('extAsset.finality', { network: asset.network })}</Text>
            </View>

            <View style={s.card}>
              <Text style={s.cardTitle}>{t('extAsset.statement')}</Text>
              {statement.length === 0 && <Text style={s.meta}>{t('extAsset.statementEmpty')}</Text>}
              {statement.map((m) => (
                <View key={m.id} style={s.row} testID={`ext-row-${m.id}`}>
                  <View style={s.rowTop}>
                    <Text style={s.rowTitle}>
                      {t(`extAsset.${m.direction}`)} {formatExternalAmount(m.amount, assetOf(m.assetId), locale)} {assetOf(m.assetId).symbol}
                    </Text>
                    <Text style={[s.status, m.status === 'completed' && s.statusOk, m.status === 'failed' && s.statusBad]}>
                      {t(`extAsset.${STATUS_KEY[m.status]}`)}
                    </Text>
                  </View>
                  {!!m.counterparty && <Text style={s.meta}>{shortAddress(m.counterparty)}</Text>}
                  {!!m.memo && <Text style={s.meta}>{m.memo}</Text>}
                  {!!m.hash && <Text style={s.hash}>{m.hash}</Text>}
                </View>
              ))}
            </View>

            <TouchableOpacity style={s.btnSmall} onPress={() => setEditing(true)} testID="ext-edit-settings">
              <Text style={s.btnSmallText}>{t('extAsset.edit')}</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function AssetRow({
  item, balance, onPress, selected,
}: {
  item: ExternalAsset;
  balance: string | null;
  onPress: () => void;
  selected: boolean;
}) {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      style={[s.row, selected && s.rowSelected]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={`ext-balance-${item.id}`}
    >
      <View style={s.rowTop}>
        <Text style={s.rowTitle}>{item.symbol}</Text>
        <Text style={s.rowAmount}>{balance ?? '—'}</Text>
      </View>
      <Text style={s.meta}>{item.name} · {item.network}</Text>
      <Text style={s.meta}>{t('extAsset.issuer')}: {item.issuer}</Text>
      <View style={s.chips}>
        {complianceFlags(item).map((flag) => (
          <View key={flag} style={s.chip}>
            <Text style={s.chipText}>{t(`extAsset.${COMPLIANCE_KEY[flag]}`)}</Text>
          </View>
        ))}
      </View>
      {!!item.note && <Text style={s.note}>{item.note}</Text>}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  content: { padding: 16, paddingTop: 4 },
  subtitle: { fontSize: 12, color: theme.colors.text.secondary, marginBottom: 12, lineHeight: 18 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 13, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  row: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: theme.colors.border },
  rowSelected: { backgroundColor: theme.colors.primarySoft, borderRadius: 8 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  rowTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  rowAmount: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  meta: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  note: { fontSize: 11, color: theme.colors.text.secondary, marginTop: 6, fontStyle: 'italic' },
  warn: { fontSize: 12, color: '#B45309', marginTop: 8 },
  error: { fontSize: 13, color: '#E5484D', marginBottom: 8 },
  notice: { fontSize: 13, color: '#1F9D55', marginBottom: 8 },
  label: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginTop: 8 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13, marginTop: 6 },
  btn: { marginTop: 12, backgroundColor: theme.colors.primary, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  btnSmall: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12, marginTop: 8, alignItems: 'center', flex: 1 },
  btnSmallText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.primary },
  miniRow: { flexDirection: 'row', gap: 8 },
  link: { fontSize: 13, color: theme.colors.text.link, fontWeight: '600' },
  refRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  reference: { fontFamily: MONO_FONT, fontSize: 14, fontWeight: '700', color: theme.colors.text.primary, flexShrink: 1 },
  refCopy: { paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  address: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.secondary, marginTop: 6 },
  spinner: { marginVertical: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 999, paddingVertical: 2, paddingHorizontal: 8 },
  chipText: { fontSize: 10, color: theme.colors.text.secondary },
  status: { fontSize: 12, fontWeight: '700', color: '#B45309' },
  statusOk: { color: '#1F9D55' },
  statusBad: { color: '#E5484D' },
  hash: { fontFamily: MONO_FONT, fontSize: 11, color: theme.colors.text.link, marginTop: 2 },
}));
