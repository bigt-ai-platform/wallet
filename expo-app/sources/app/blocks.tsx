import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet } from 'react-native-unistyles';
import { httpService } from '@/services/http';
import { toBlockRow, type BlockRow } from '@/lib/blockinfo';
import { IS_DEV } from '@/constants/app';
import { Utils, TestParams, MainNetParams } from 'bigtangle-ts';
import { MONO_FONT } from '@/constants/fonts';

/**
 * Block explorer (port of the server webapp's /public/blocks.jsf): list the
 * latest blocks of a chain or look one up by its hash, and expand a block to
 * its full dump (the app equivalent of the Java block2string dialog).
 */

interface ChainOption {
  key: 'l0' | number;
  label: string;
  url?: string;
}

function ChainDropdown({ value, options, onChange }: {
  value: 'l0' | number;
  options: ChainOption[];
  onChange: (key: 'l0' | number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.key === value);
  return (
    <>
      <TouchableOpacity
        style={s.dropdown}
        onPress={() => setOpen((o) => !o)}
        testID="blocks-chain-select"
        accessibilityRole="button"
        accessibilityLabel={t('blocks.chain')}
      >
        <Text style={s.dropdownText}>{current?.label ?? t('balance.allLayers')}</Text>
        <Text style={s.dropdownChevron}>{open ? '▴' : '▾'}</Text>
      </TouchableOpacity>
      {open && (
        <View style={s.dropdownList} testID="blocks-chain-options">
          {options.map((o) => (
            <TouchableOpacity
              key={String(o.key)}
              style={[s.dropdownOption, o.key === value && s.dropdownOptionActive]}
              onPress={() => { onChange(o.key); setOpen(false); }}
            >
              <Text style={[s.dropdownOptionText, o.key === value && s.dropdownOptionTextActive]}>{o.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </>
  );
}

export default function BlocksScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  // L0 is the default node; the configured L1 chains complete the dropdown
  // (the web page discovers extra chains from a seeds registry — here the
  // user manages them in settings).
  const chains: ChainOption[] = React.useMemo(() => [
    { key: 'l0', label: 'L0' },
    ...httpService.getL1Chains().map((c, i) => ({ key: i as number, label: c.name || `L1-${i + 1}`, url: c.url })),
  ], []);
  const [activeChain, setActiveChain] = React.useState<'l0' | number>('l0');
  const [blockhash, setBlockhash] = React.useState('');
  const [lastNum, setLastNum] = React.useState('50');
  const [rows, setRows] = React.useState<BlockRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [searched, setSearched] = React.useState(false);
  // The expanded block's full dump (Java block2string), fetched on demand by
  // the "Details" button (key = block hash).
  const [detailData, setDetailData] = React.useState<Record<string, string>>({});
  const [expandedKey, setExpandedKey] = React.useState<string | null>(null);

  const chainUrl = (key: 'l0' | number): string | undefined =>
    key === 'l0' ? undefined : chains.find((c) => c.key === key)?.url;

  const parseLastNum = (): number => {
    const n = parseInt(lastNum, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 50;
  };

  const load = async () => {
    setLoading(true);
    setError('');
    setExpandedKey(null);
    const baseUrl = chainUrl(activeChain);
    try {
      const res = blockhash.trim()
        ? await httpService.searchBlockByHashs([blockhash.trim()], baseUrl)
        : await httpService.findBlockEvaluations(parseLastNum(), baseUrl);
      if (!res.success || !res.data) {
        setRows([]);
        setError(res.error || t('blocks.empty'));
        return;
      }
      setRows(res.data.map(toBlockRow));
      setSearched(true);
    } catch (e) {
      console.error('Error loading blocks:', e);
      setRows([]);
      setError(t('blocks.empty'));
    } finally {
      setLoading(false);
    }
  };

  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the raw block and decode it client-side into the full multi-line
  // dump, exactly like Java's `showBlock` (makeBlock + block2string).
  const showDetail = async (row: BlockRow) => {
    const key = row.hash;
    if (expandedKey === key) {
      setExpandedKey(null);
      return;
    }
    setExpandedKey(key);
    if (detailData[key]) return;
    try {
      const res = await httpService.getBlockDataHex(row.hash, chainUrl(activeChain));
      if (!res.success || !res.data) {
        setDetailData((prev) => ({ ...prev, [key]: res.error || t('blocks.empty') }));
        return;
      }
      const params = IS_DEV || httpService.getUseTestnet() ? TestParams.get() : MainNetParams.get();
      const bytes = new Uint8Array(Utils.HEX.decode(res.data));
      const block = params.getDefaultSerializer().makeBlock(bytes);
      setDetailData((prev) => ({ ...prev, [key]: block.toString() }));
    } catch (e) {
      console.error('Error decoding block:', e);
      setDetailData((prev) => ({ ...prev, [key]: String(e) }));
    }
  };

  const formatTime = (ms: number): string =>
    ms > 0 ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '-';

  return (
    <View style={s.container} testID="blocks-screen">
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('sidebar.blocks')}</Text>
      </View>

      <View style={s.filterCard}>
        <Text style={s.cardLabel}>{t('blocks.chain')}</Text>
        <ChainDropdown value={activeChain} options={chains} onChange={setActiveChain} />
        <Text style={s.cardLabel}>{t('blocks.blockhash')}</Text>
        <TextInput
          style={s.hashInput}
          value={blockhash}
          onChangeText={setBlockhash}
          placeholder={t('blocks.blockhashPh')}
          placeholderTextColor={s.placeholder.color}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          testID="blocks-hash-input"
        />
        <View style={s.optionRow}>
          <View style={s.lastNumBox}>
            <Text style={s.lastNumLabel}>{t('blocks.lastNum')}</Text>
            <TextInput
              style={s.lastNumInput}
              value={lastNum}
              onChangeText={setLastNum}
              keyboardType="number-pad"
              testID="blocks-last-num"
            />
          </View>
          <TouchableOpacity onPress={load} style={s.refreshBtn} disabled={loading} testID="blocks-apply">
            <Text style={s.refreshText}>{loading ? '...' : t('balance.applyRefresh')}</Text>
          </TouchableOpacity>
        </View>
        {searched && !loading ? (
          <Text style={s.countText}>{t('blocks.results', { count: rows.length })}</Text>
        ) : null}
        {error ? <Text style={s.errorText}>{error}</Text> : null}
      </View>

      <ScrollView contentContainerStyle={s.content}>
        {loading ? (
          <ActivityIndicator size="large" color={s.loader.color} style={{ padding: 32 }} />
        ) : rows.length === 0 ? (
          searched ? <Text style={s.emptyText}>{t('blocks.empty')}</Text> : null
        ) : (
          rows.map((row) => {
            const key = row.hash;
            return (
              <View key={key || row.height} style={s.card} testID="blocks-card">
                <View style={s.cardHeader}>
                  <Text style={s.tokenName}>#{row.height}</Text>
                  <Text style={s.tokenValue}>{row.rating}</Text>
                </View>
                <Text style={s.tokenMeta}>{row.blockType || '-'} · {row.confirmed ? t('balance.confirmYes') : t('balance.confirmNo')}</Text>
                <Text style={s.tokenMeta}>{t('blocks.depth')}: {row.chainlength}</Text>
                <Text style={s.tokenMeta}>{t('blocks.insertTime')}: {formatTime(row.insertTime)}</Text>
                <Text style={s.tokenMeta}>{t('blocks.update')}: {formatTime(row.milestoneLastUpdateTime)}</Text>
                <Text style={s.tokenId}>{key ? (key.length > 34 ? `${key.slice(0, 34)}…` : key) : '…'}</Text>
                {expandedKey === key && (
                  <View style={s.detailBox}>
                    <Text style={s.detailTitle}>{t('blocks.blockInfo')}</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <Text style={s.detailDump} selectable testID="blocks-detail-dump">{detailData[key] ?? t('balance.loading')}</Text>
                    </ScrollView>
                  </View>
                )}
                <TouchableOpacity
                  style={s.moreBtn}
                  onPress={() => showDetail(row)}
                  accessibilityRole="button"
                  accessibilityLabel={t('blocks.details')}
                >
                  <Text style={s.moreText}>{expandedKey === key ? '−' : t('blocks.details')}</Text>
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
  hashInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 13, marginBottom: 10, minHeight: 44, textAlignVertical: 'top' },
  placeholder: { color: theme.colors.text.secondary },
  optionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  lastNumBox: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, flex: 1 },
  lastNumLabel: { fontSize: 13, color: theme.colors.text.secondary },
  lastNumInput: { flex: 1, fontSize: 14, color: theme.colors.text.primary, paddingVertical: 2 },
  refreshBtn: { borderWidth: 1, borderColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  refreshText: { fontSize: 13, fontWeight: '600', color: theme.colors.text.link },
  countText: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 6 },
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
  detailBox: { marginTop: 8, padding: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.groupped.background, borderRadius: 8 },
  detailTitle: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  detailDump: { fontSize: 11, color: theme.colors.text.primary, fontFamily: MONO_FONT },
  moreBtn: { alignSelf: 'flex-start', marginTop: 6, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 },
  moreText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, paddingHorizontal: 12, paddingVertical: 10 },
  dropdownText: { fontSize: 14, color: theme.colors.text.primary },
  dropdownChevron: { fontSize: 14, color: theme.colors.text.secondary },
  dropdownList: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, marginBottom: 10, marginTop: -4 },
  dropdownOption: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
  dropdownOptionActive: { backgroundColor: theme.colors.primarySoft },
  dropdownOptionText: { fontSize: 14, color: theme.colors.text.primary },
  dropdownOptionTextActive: { color: theme.colors.primary, fontWeight: '600' },
}));
