import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import { toBigInt, formatValue } from '@/lib/amountformat';
import { MONO_FONT } from '@/constants/fonts';
import type { UTXO } from '@/types/api';

/**
 * Public address balance lookup (port of the server webapp's
 * /public/balance.jsf): query the outputs history of any address without an
 * unlocked wallet. Supports the direction filter (received vs sent), a
 * history toggle (include spent outputs), an aggregated per-token view and a
 * per-UTXO list with on-demand block detail ("…" button).
 */

interface HistoryUtxo extends UTXO {
  /** Sending address of the transaction that created this output. */
  fromAddress?: string;
  /** Whether the output was already consumed by a later transaction. */
  spent?: boolean;
  /** Whether a pending outgoing transaction currently reserves this output. */
  spendPending?: boolean;
}

interface Aggregated {
  tokenId: string;
  tokenName: string;
  total: bigint;
  count: number;
}

export default function PublicBalanceScreen() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const locale = i18n.language || 'en';
  const [address, setAddress] = React.useState('');
  // false = received (query by toaddress), true = sent (query by fromaddress)
  const [sent, setSent] = React.useState(false);
  const [history, setHistory] = React.useState(false);
  const [aggregate, setAggregate] = React.useState(true);
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');
  const [utxos, setUtxos] = React.useState<HistoryUtxo[]>([]);
  const [tokenDecimals, setTokenDecimals] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState(false);
  const [error, setError] = React.useState('');
  // Per-UTXO detail fetched on demand by the "… more" button (key = hash:index).
  const [detailData, setDetailData] = React.useState<Record<string, { detail?: any; finalized?: boolean }>>({});
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);

  const parseDate = (v: string): number | null => {
    if (!v) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  };

  const load = async () => {
    const addr = address.trim();
    if (!addr) {
      setError(t('publicBalance.errAddress'));
      return;
    }
    setError('');
    setLoading(true);
    setExpandedKey(null);
    try {
      // Best-effort per-token decimals from the public token list so amounts
      // display in whole units (BIG = 6 decimals), like the Java page uses
      // Token.getDecimals().
      const tokens = await httpService.getTokensItemList().catch(() => ({ success: false, data: undefined }) as any);
      const map: Record<string, number> = {};
      (tokens?.data ?? []).forEach((tok: any) => {
        if (tok && tok.tokenid && tok.decimals != null) map[tok.tokenid] = Number(tok.decimals);
      });
      setTokenDecimals(map);

      const fromTime = parseDate(fromDate);
      const toTime = parseDate(toDate);
      const res = await httpService.getOutputsHistory({
        address: sent ? addr : undefined,
        toAddress: sent ? undefined : addr,
        fromTime: fromTime ?? undefined,
        toTime: toTime ?? undefined,
      });
      if (!res.success || !res.data) {
        setUtxos([]);
        setError(res.error || t('balance.empty'));
        return;
      }
      // getOutputsHistory returns `value` as a Coin object and the token id as
      // `tokenId` (camelCase) — normalize to the UTXO shape rendered below.
      const normalized: HistoryUtxo[] = (res.data as any[]).map((u: any): HistoryUtxo => ({
        ...u,
        value:
          u.value && typeof u.value === 'object'
            ? String((u.value as any).value ?? 0)
            : u.value,
        tokenid: u.tokenId || (u.value && (u.value as any).tokenHex) || u.tokenid,
        fromAddress: u.fromaddress || u.fromAddress || '',
        spent: !!u.spent,
        spendPending: !!u.spendPending,
        spendable:
          u.spendable ??
          (!!u.confirmed && !u.spent && !u.spendPending),
      }));
      // Without the history toggle only unspent outputs count as balance.
      setUtxos(history ? normalized : normalized.filter((u) => !u.spent));
      setSearched(true);
    } catch (e) {
      console.error('Error loading public balance:', e);
      setUtxos([]);
      setError(t('balance.empty'));
    } finally {
      setLoading(false);
    }
  };

  // Fetch one output's detail + its containing block info and the chain's
  // finalized checkpoint; expand the card to show them (same "…" pattern as
  // the wallet balance screen).
  const showDetail = async (u: HistoryUtxo, key: string) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (detailData[key]) return;
    try {
      const [detail, chainNum]: [any, any] = await Promise.all([
        httpService.getOutputDetail(`${u.hashHex ?? u.txhash}:${u.index}`),
        httpService.getChainNumber().catch(() => ({ success: false })),
      ]);
      const d = detail?.success ? detail.data : null;
      const finalizedCl = chainNum?.success
        ? Number(chainNum.data?.finalizedChainLength)
        : undefined;
      const chainlength = d?.blockChainlength != null ? Number(d.blockChainlength) : undefined;
      const finalized =
        chainlength != null && finalizedCl != null && chainlength <= finalizedCl;
      setDetailData((prev) => ({ ...prev, [key]: { detail: d, finalized } }));
    } catch {
      setDetailData((prev) => ({ ...prev, [key]: { detail: undefined, finalized: false } }));
    }
  };

  // Java formats balances with the token's own metadata decimals; the base
  // token "bc" uses NetworkParameters.BIGTANGLE_DECIMAL, other tokens
  // default to 0 (Java Token default).
  const decimalsOf = (tokenId: string): number =>
    tokenDecimals[tokenId] ?? (tokenId === 'bc' ? 6 : 0);

  const agg = React.useMemo(() => {
    const map = new Map<string, Aggregated>();
    for (const u of utxos) {
      const key = u.tokenid || 'unknown';
      const cur = map.get(key) || { tokenId: key, tokenName: u.tokenname || key.slice(0, 8), total: BigInt(0), count: 0 };
      cur.total += toBigInt(u.value);
      cur.count += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => (a.total > b.total ? -1 : 1));
  }, [utxos]);

  const totalCount = utxos.length;

  return (
    <View style={s.container} testID="public-balance-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('sidebar.addressBalance')}</Text>
      </View>

      <View style={s.filterCard}>
        <Text style={s.cardLabel}>{t('publicBalance.address')}</Text>
        <TextInput
          style={s.addressInput}
          value={address}
          onChangeText={setAddress}
          placeholder={t('publicBalance.addressPh')}
          placeholderTextColor={s.placeholder.color}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          testID="public-balance-address"
        />
        <Text style={s.cardLabel}>{t('balance.dateRange')}</Text>
        <View style={s.dateRow}>
          <TextInput style={s.dateInput} value={fromDate} onChangeText={setFromDate}
            placeholder={t('balance.fromPh')} placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" testID="public-balance-from-date" />
          <TextInput style={s.dateInput} value={toDate} onChangeText={setToDate}
            placeholder={t('balance.toPh')} placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" testID="public-balance-to-date" />
        </View>
        <View style={s.optionRow}>
          <TouchableOpacity
            onPress={() => setSent(!sent)}
            style={[s.toggle, sent && s.toggleOn]}
            testID="public-balance-direction"
          >
            <Text style={[s.toggleText, sent && s.toggleTextOn]}>
              {sent ? t('publicBalance.sent') : t('publicBalance.received')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setHistory(!history)}
            style={[s.toggle, history && s.toggleOn]}
            testID="public-balance-history"
          >
            <Text style={[s.toggleText, history && s.toggleTextOn]}>{t('publicBalance.history')}</Text>
          </TouchableOpacity>
        </View>
        <View style={s.optionRow}>
          <TouchableOpacity
            onPress={() => setAggregate(!aggregate)}
            style={[s.toggle, aggregate && s.toggleOn]}
            testID="public-balance-aggregate-toggle"
          >
            <Text style={[s.toggleText, aggregate && s.toggleTextOn]}>{aggregate ? t('balance.aggregated') : t('balance.listUtxos')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={load} style={s.refreshBtn} disabled={loading} testID="public-balance-apply">
            <Text style={s.refreshText}>{loading ? '...' : t('balance.applyRefresh')}</Text>
          </TouchableOpacity>
        </View>
        {searched && !loading ? (
          <Text style={s.countText}>{t('balance.count', { count: totalCount })}</Text>
        ) : null}
        {error ? <Text style={s.errorText}>{error}</Text> : null}
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {loading ? (
          <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 32 }} />
        ) : aggregate ? (
          agg.length === 0 ? (
            searched ? <Text style={s.emptyText}>{t('balance.empty')}</Text> : null
          ) : (
            agg.map((a) => (
              <View key={a.tokenId} style={s.card}>
                <View style={s.cardHeader}>
                  <Text style={s.tokenName}>{a.tokenName}</Text>
                  <Text style={s.tokenValue}>{formatValue(a.total, decimalsOf(a.tokenId), locale)}</Text>
                </View>
                <Text style={s.tokenMeta}>{t('balance.metaUtxosNoLayer', { count: a.count })}</Text>
                <Text style={s.tokenId}>{a.tokenId.slice(0, 18)}...</Text>
              </View>
            ))
          )
        ) : utxos.length === 0 ? (
          searched ? <Text style={s.emptyText}>{t('balance.empty')}</Text> : null
        ) : (
          utxos.map((u) => {
            const key = `${u.hashHex ?? u.txhash}:${u.index}`;
            const entry = detailData[key];
            const d = entry?.detail;
            const confirmLabel = u.confirmed ? t('balance.confirmYes') : t('balance.confirmNo');
            const stateLabel = u.spendable
              ? t('balance.stateSpendable')
              : u.spent
                ? t('balance.stateSpent')
                : u.spendPending
                  ? t('balance.statePendingSpend')
                  : t('balance.stateLocked');
            const fromLabel = u.fromAddress ? u.fromAddress.slice(0, 18) : '...';
            const toLabel = u.address ? u.address.slice(0, 18) : '...';
            const dateSuffix = u.time ? ` · ${new Date(u.time * 1000).toISOString().slice(0, 10)}` : '';
            return (
              <View key={key} style={s.card}>
                <View style={s.cardHeader}>
                  <Text style={s.tokenName}>{u.tokenname || u.tokenid?.slice(0, 8) || t('balance.tokenFallback')}</Text>
                  <Text style={s.tokenValue}>{formatValue(toBigInt(u.value), decimalsOf(u.tokenid || 'bc'), locale)}</Text>
                </View>
                <Text style={s.tokenMeta}>{t('balance.metaLineNoLayer', { confirm: confirmLabel, state: stateLabel })}</Text>
                <Text style={s.tokenMeta}>{t('balance.fromTo', { from: fromLabel, to: toLabel })}{dateSuffix}</Text>
                {u.memo ? <Text style={s.tokenMeta}>{t('balance.detailMemo', { memo: u.memo })}</Text> : null}
                <Text style={s.tokenId}>{(u.txhash || '').slice(0, 20)}</Text>
                {expandedKey === key && (
                  <View style={s.detailBox}>
                    {d ? (
                      <>
                        <Text style={s.tokenMeta}>{t('balance.detailBlock', { hash: (d.blockHash || '').slice(0, 20) })}</Text>
                        <Text style={s.tokenMeta}>{t('balance.detailHeight', { height: d.blockHeight ?? '?', chainlength: d.blockChainlength ?? '?' })}</Text>
                        <Text style={s.tokenMeta}>{t('balance.detailConfirmed', { confirmed: d.blockConfirmed ? t('balance.yes') : t('balance.no'), finalized: entry?.finalized ? t('balance.yes') : t('balance.no') })}</Text>
                        {d.output?.fromaddress ? <Text style={s.tokenMeta}>{t('balance.detailFrom', { address: d.output.fromaddress })}</Text> : null}
                        {d.output?.memo ? <Text style={s.tokenMeta}>{t('balance.detailMemo', { memo: d.output.memo })}</Text> : null}
                      </>
                    ) : (
                      <Text style={s.tokenMeta}>{t('balance.loading')}</Text>
                    )}
                  </View>
                )}
                <TouchableOpacity
                  style={s.moreBtn}
                  onPress={() => showDetail(u, key)}
                  accessibilityRole="button"
                  accessibilityLabel={t('balance.moreDetails')}
                >
                  <Text style={s.moreText}>{expandedKey === key ? '−' : '⋯'}</Text>
                </TouchableOpacity>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  filterCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12, marginHorizontal: 16 },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  addressInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13, marginBottom: 10, minHeight: 44, textAlignVertical: 'top' },
  dateRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  dateInput: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
  optionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  toggle: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, flex: 1, alignItems: 'center' },
  toggleOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  toggleText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
  toggleTextOn: { color: '#FFFFFF' },
  refreshBtn: { borderWidth: 1, borderColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  refreshText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.link },
  countText: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  errorText: { fontSize: 12, color: '#E5484D', marginTop: 4 },
  content: { padding: 16, paddingTop: 8 },
  loader: { color: theme.colors.primary },
  emptyText: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', padding: 32 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 8 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  tokenName: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  tokenValue: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  tokenMeta: { fontSize: 12, color: theme.colors.text.secondary, marginBottom: 2 },
  tokenId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: MONO_FONT },
  moreBtn: { alignSelf: 'flex-start', marginTop: 6, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  moreText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  detailBox: { marginTop: 8, padding: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.groupped.background, borderRadius: 8 },
}));
