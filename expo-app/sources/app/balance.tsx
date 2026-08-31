import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  TextInput, Modal,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { MONO_FONT } from '@/constants/fonts';
import type { UTXO } from '@/types/api';

interface LayerUtxo extends UTXO {
  layer: number; // 0 = L0, 1..N = L1 chains
  layerName: string;
  /** Server URL this UTXO lives on (L0 undefined = default, or an L1 chain). */
  baseUrl?: string;
}

interface Aggregated {
  tokenId: string;
  tokenName: string;
  total: bigint;
  count: number;
  layers: number[];
}

function toBigInt(v: any): bigint {
  try { return BigInt(v ?? 0); } catch { return BigInt(0); }
}

function formatValue(v: bigint): string {
  return v.toString();
}

function LayerDropdown({ value, options, onChange }: {
  value: 'all' | number;
  options: Array<{ key: 'all' | number; label: string }>;
  onChange: (key: 'all' | number) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.key === value);
  return (
    <>
      <TouchableOpacity style={s.dropdown} onPress={() => setOpen(true)} testID="balance-layer-select">
        <Text style={s.dropdownText}>{current?.label ?? 'All Layers'}</Text>
        <Text style={s.dropdownChevron}>▾</Text>
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>Layer</Text>
            {options.map((o) => (
              <TouchableOpacity
                key={String(o.key)}
                style={[s.modalOption, o.key === value && s.modalOptionActive]}
                onPress={() => { onChange(o.key); setOpen(false); }}
              >
                <Text style={[s.modalOptionText, o.key === value && s.modalOptionTextActive]}>{o.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

export default function BalanceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { publicInfo, isUnlocked } = useWallet();
  const l1Chains = React.useMemo(() => httpService.getL1Chains(), []);
  const [utxos, setUtxos] = React.useState<LayerUtxo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');
  const [aggregate, setAggregate] = React.useState(false);
  const [activeLayer, setActiveLayer] = React.useState<'all' | number>('all');
  // Per-UTXO detail fetched on demand by the "… more" button (key = hash:index).
  const [detailData, setDetailData] = React.useState<Record<string, { detail?: any; finalized?: boolean }>>({});
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (publicInfo?.address && isUnlocked) loadAll();
  }, [publicInfo, isUnlocked]);

  const parseDate = (v: string): number | null => {
    if (!v) return null;
    const ms = Date.parse(v);
    return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
  };

  const loadLayer = async (
    baseUrl: string | undefined,
    layer: number,
    layerName: string
  ): Promise<LayerUtxo[]> => {
    const fromTime = parseDate(fromDate);
    const toTime = parseDate(toDate);
    // getOutputsHistory is exposed on both L0 and L1 (BaseDispatcherController).
    // Query by toAddress: the outputs the wallet owns (getOutputsHistory matches
    // outputs.fromaddress AND toaddress, so the wallet goes in the to slot).
    const res = await httpService.getOutputsHistory({
      toAddress: publicInfo?.address,
      fromTime: fromTime ?? undefined,
      toTime: toTime ?? undefined,
      baseUrl,
    });
    if (!res.success || !res.data) return [];
    // getOutputsHistory returns `value` as a Coin object {value, tokenid,
    // tokenHex, big}, the token id as `tokenId` (camelCase), and no
    // `spendable` flag — normalize to the UTXO shape the screen renders
    // (spendable = confirmed + unspent + not spend-pending). Per-UTXO block
    // detail (chainlength/finalized/height) is fetched on demand via "…".
    return res.data.map((u: any): LayerUtxo => ({
      ...u,
      value:
        u.value && typeof u.value === 'object'
          ? String((u.value as any).value ?? 0)
          : u.value,
      tokenid: u.tokenId || (u.value && (u.value as any).tokenHex) || u.tokenid,
      spendable:
        u.spendable ??
        (!!u.confirmed && !u.spent && !u.spendPending),
      layer,
      layerName,
      baseUrl,
    }));
  };

  // Fetch one output's detail + its containing block info and the chain's
  // finalized checkpoint; expand the card to show them (balance "… for more").
  const showDetail = async (u: LayerUtxo, key: string) => {
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (detailData[key]) return;
    try {
      const [detail, chainNum]: [any, any] = await Promise.all([
        httpService.getOutputDetail(`${u.hashHex ?? u.txhash}:${u.index}`, u.baseUrl),
        httpService.getChainNumber(u.baseUrl).catch(() => ({ success: false })),
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

  const loadAll = async () => {
    if (!publicInfo?.address) return;
    setLoading(true);
    try {
      const results = await Promise.all([
        loadLayer(undefined, 0, 'L0'),
        ...l1Chains.map((c, i) => loadLayer(c.url, i + 1, c.name)),
      ]);
      setUtxos(results.flat());
    } catch (e) {
      console.error('Error loading balance UTXOs:', e);
    } finally {
      setLoading(false);
    }
  };

  const filtered = utxos.filter((u) =>
    activeLayer === 'all' ? true : u.layer === activeLayer
  );

  // Every layer as a list entry: All Layers, L0, then one per L1 chain.
  const layerList: Array<{ key: 'all' | number; label: string }> = [
    { key: 'all', label: 'All Layers' },
    { key: 0, label: 'L0' },
    ...l1Chains.map((c, i) => ({ key: i + 1, label: c.name || `L1-${i + 1}` })),
  ];

  const agg = React.useMemo(() => {
    const map = new Map<string, Aggregated>();
    for (const u of filtered) {
      const key = u.tokenid || 'unknown';
      const cur = map.get(key) || { tokenId: key, tokenName: u.tokenname || key.slice(0, 8), total: BigInt(0), count: 0, layers: [] };
      cur.total += toBigInt(u.value);
      cur.count += 1;
      if (!cur.layers.includes(u.layer)) cur.layers.push(u.layer);
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => (a.total > b.total ? -1 : 1));
  }, [filtered]);

  if (!isUnlocked) {
    return (
      <View style={s.container} testID="balance-screen">
        <View style={s.centered}>
          <Text style={s.lockedTitle}>{t('wallet.locked')}</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push('/home/keys')}>
            <Text style={s.primaryBtnText}>{t('wallet.manageWallet')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const totalCount = filtered.length;

  return (
    <View style={s.container} testID="balance-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>Balance</Text>
      </View>

      <View style={s.filterCard}>
        <Text style={s.cardLabel}>Date Range (from / to)</Text>
        <View style={s.dateRow}>
          <TextInput style={s.dateInput} value={fromDate} onChangeText={setFromDate}
            placeholder="from e.g. 2024-01-01" placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" testID="balance-from-date" />
          <TextInput style={s.dateInput} value={toDate} onChangeText={setToDate}
            placeholder="to e.g. 2026-01-01" placeholderTextColor={s.placeholder.color}
            autoCapitalize="none" testID="balance-to-date" />
        </View>
        <View style={s.optionRow}>
          <TouchableOpacity onPress={() => setAggregate(!aggregate)} style={[s.aggToggle, aggregate && s.aggToggleOn]} testID="balance-aggregate-toggle">
            <Text style={[s.aggToggleText, aggregate && s.aggToggleTextOn]}>{aggregate ? 'Aggregated by Token' : 'List all UTXOs'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={loadAll} style={s.refreshBtn} disabled={loading} testID="balance-refresh">
            <Text style={s.refreshText}>{loading ? '...' : 'Apply / Refresh'}</Text>
          </TouchableOpacity>
        </View>
        <Text style={s.cardLabel}>Layer</Text>
        <LayerDropdown value={activeLayer} options={layerList} onChange={setActiveLayer} />
        <Text style={s.countText}>{totalCount} UTXO{totalCount === 1 ? '' : 's'}</Text>
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {loading ? (
          <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 32 }} />
        ) : aggregate ? (
          agg.length === 0 ? (
            <Text style={s.emptyText}>No UTXOs found for the selected filters.</Text>
          ) : (
            agg.map((a) => (
              <View key={a.tokenId} style={s.card}>
                <View style={s.aggHeader}>
                  <Text style={s.tokenName}>{a.tokenName}</Text>
                  <Text style={s.tokenValue}>{formatValue(a.total)}</Text>
                </View>
                <Text style={s.tokenMeta}>{a.count} UTXO{a.count === 1 ? '' : 's'} · layers: {a.layers.sort((x, y) => x - y).map((l) => (l === 0 ? 'L0' : `L1-${l}`)).join(', ')}</Text>
                <Text style={s.tokenId}>{a.tokenId.slice(0, 18)}...</Text>
              </View>
            ))
          )
        ) : filtered.length === 0 ? (
          <Text style={s.emptyText}>No UTXOs found for the selected filters.</Text>
        ) : (
          filtered.map((u, i) => {
            const key = `${u.hashHex ?? u.txhash}:${u.index}`;
            const entry = detailData[key];
            const d = entry?.detail;
            return (
            <View key={key} style={s.card}>
              <View style={s.aggHeader}>
                <Text style={s.tokenName}>{u.tokenname || u.tokenid?.slice(0, 8) || 'token'}</Text>
                <Text style={s.tokenValue}>{formatValue(toBigInt(u.value))}</Text>
              </View>
              <Text style={s.tokenMeta}>layer {u.layerName} · {u.confirmed ? 'confirmed' : 'pending'} · {u.spendable ? 'spendable' : 'locked'}</Text>
              <Text style={s.tokenMeta}>to {u.address ? u.address.slice(0, 18) : '...'}{u.time ? ` · ${new Date(u.time * 1000).toISOString().slice(0, 10)}` : ''}</Text>
              <Text style={s.tokenId}>{(u.txhash || '').slice(0, 20)}</Text>
              {expandedKey === key && (
                <View style={s.detailBox}>
                  {d ? (
                    <>
                      <Text style={s.tokenMeta}>Block: {(d.blockHash || '').slice(0, 20)}…</Text>
                      <Text style={s.tokenMeta}>Height: {d.blockHeight ?? '?'} · Chainlength: {d.blockChainlength ?? '?'}</Text>
                      <Text style={s.tokenMeta}>Confirmed: {d.blockConfirmed ? 'yes' : 'no'} · Finalized: {entry?.finalized ? 'yes' : 'no'}</Text>
                      {d.output?.fromaddress ? <Text style={s.tokenMeta}>From: {d.output.fromaddress}</Text> : null}
                      {d.output?.memo ? <Text style={s.tokenMeta}>Memo: {d.output.memo}</Text> : null}
                    </>
                  ) : (
                    <Text style={s.tokenMeta}>Loading…</Text>
                  )}
                </View>
              )}
              <TouchableOpacity
                style={s.moreBtn}
                onPress={() => showDetail(u, key)}
                accessibilityRole="button"
                accessibilityLabel={`more-details-${i}`}
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
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  lockedTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 8 },
  primaryBtn: { backgroundColor: theme.colors.primary, borderRadius: 10, paddingVertical: 15, paddingHorizontal: 32, alignItems: 'center' },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  filterCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 12, marginHorizontal: 16 },
  cardLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  dateRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  dateInput: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
  optionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  aggToggle: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  aggToggleOn: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  aggToggleText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
  aggToggleTextOn: { color: '#FFFFFF' },
  refreshBtn: { borderWidth: 1, borderColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  refreshText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.link },
  countText: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 4 },
  content: { padding: 16, paddingTop: 8 },
  loader: { color: theme.colors.primary },
  emptyText: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', padding: 32 },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 14, marginBottom: 8 },
  aggHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  tokenName: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  tokenValue: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  tokenMeta: { fontSize: 12, color: theme.colors.text.secondary, marginBottom: 2 },
  tokenId: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: MONO_FONT },
  moreBtn: { alignSelf: 'flex-start', marginTop: 6, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  moreText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  detailBox: { marginTop: 8, padding: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.groupped.background, borderRadius: 8 },
  layerRow: { flexGrow: 0, marginHorizontal: 16, marginBottom: 8 },
  layerRowContent: { gap: 8, paddingVertical: 2 },
  layerChip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  layerChipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  layerChipText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.secondary },
  layerChipTextActive: { color: '#FFFFFF' },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, paddingHorizontal: 12, paddingVertical: 10, marginTop: 4 },
  dropdownText: { fontSize: 14, color: theme.colors.text.primary },
  dropdownChevron: { fontSize: 14, color: theme.colors.text.secondary },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: 24 },
  modalSheet: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 14, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 },
  modalOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 8, borderRadius: 8 },
  modalOptionActive: { backgroundColor: theme.colors.primarySoft },
  modalOptionText: { fontSize: 14, color: theme.colors.text.primary },
  modalOptionTextActive: { color: theme.colors.primary, fontWeight: '600' },
}));
