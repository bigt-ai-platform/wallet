import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import SegmentedTabs from '@/components/SegmentedTabs';
import { MONO_FONT } from '@/constants/fonts';
import type { UTXO } from '@/types/api';

interface LayerUtxo extends UTXO {
  layer: number; // 0 = L0, 1..N = L1 chains
  layerName: string;
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
  const [activeTab, setActiveTab] = React.useState<'all' | 'l0' | 'l1'>('all');

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
    const res = await httpService.getOutputsHistory({
      address: publicInfo?.address,
      fromTime: fromTime ?? undefined,
      toTime: toTime ?? undefined,
      baseUrl,
    });
    if (!res.success || !res.data) return [];
    return res.data.map((u: UTXO) => ({ ...u, layer, layerName }));
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
    activeTab === 'all' ? true : activeTab === 'l0' ? u.layer === 0 : u.layer > 0
  );

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
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push('/wallet/keys')}>
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
        <Text style={s.countText}>{totalCount} UTXO{totalCount === 1 ? '' : 's'}</Text>
      </View>

      <SegmentedTabs
        tabs={[
          { key: 'all', label: 'All Layers' },
          { key: 'l0', label: 'Layer 0' },
          { key: 'l1', label: 'L1-*' },
        ]}
        active={activeTab}
        onChange={(k) => setActiveTab(k as typeof activeTab)}
      />

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
          filtered.map((u, i) => (
            <View key={i} style={s.card}>
              <View style={s.aggHeader}>
                <Text style={s.tokenName}>{u.tokenname || u.tokenid?.slice(0, 8) || 'token'}</Text>
                <Text style={s.tokenValue}>{formatValue(toBigInt(u.value))}</Text>
              </View>
              <Text style={s.tokenMeta}>layer {u.layerName} · {u.confirmed ? 'confirmed' : 'pending'} · {u.spendable ? 'spendable' : 'locked'}</Text>
              <Text style={s.tokenMeta}>to {u.address ? u.address.slice(0, 18) : '...'}{u.time ? ` · ${new Date(u.time * 1000).toISOString().slice(0, 10)}` : ''}</Text>
              <Text style={s.tokenId}>{(u.txhash || '').slice(0, 20)}</Text>
            </View>
          ))
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
}));
