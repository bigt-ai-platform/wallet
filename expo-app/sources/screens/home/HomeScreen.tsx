import * as React from 'react';
import {
  View, Text, ScrollView, TextInput, TouchableOpacity, ActivityIndicator, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { decimalsFor, orderPriceShift, shortTokenId } from '@/lib/tokenformat';
import {
  BellIcon, ChartIcon, MarketIcon, QrScanIcon, SearchIcon, SendIcon, SwapIcon,
} from '@/components/Icons';
import { MONO_FONT } from '@/constants/fonts';
import { useSystemNotifications } from '@/lib/useSystemNotifications';
import { markSystemMessagesRead } from '@/services/systemMessages';

/** One raw `getOrdersTicker` match. `lastdayprice` / `lastdayQuantity` are the
 *  24h-ago price and the 24h traded quantity the L1 adds for a market row. */
interface TickerRow {
  tokenid?: string;
  price?: number;
  executedQuantity?: number;
  lastdayprice?: number;
  lastdayQuantity?: number;
  inserttime?: number;
}

interface MarketRow {
  tokenid: string;
  /** Traded token's display name without the quote suffix. */
  tokenName: string;
  /** Token id of the quote base (BC, USDT or CNY). */
  quoteId: string;
  name: string;
  /** Last price in the quote token (BC, USDT or CNY). */
  price: number;
  /** 24h change percent, or null when the market has no day-ago price. */
  changePct: number | null;
  /** 24h traded quantity, in the token's own units. */
  volume: number;
}

interface QuickAction {
  key: string;
  label: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
  route: string;
}

const toHuman = (raw: number | undefined, decimals: number): number =>
  (Number(raw) || 0) / Math.pow(10, decimals);

function fmtPrice(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

function fmtCompact(v: number): string {
  if (!Number.isFinite(v) || v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

const fmtChange = (c: number | null): string =>
  c == null ? '—' : `${c >= 0 ? '+' : ''}${c.toFixed(2)}%`;

const fmtNoticeTime = (ms: number): string => new Date(ms).toLocaleString(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Market-first home, the wallet's landing page (analog of binance.com's home):
 * a branded hero with the top market and quick actions (Send / Receive / Buy /
 * Sell / Spot), a horizontal "Popular" strip and a "Markets" table (last price,
 * 24h change, 24h volume). Every row opens the Spot market. Unlike Binance it
 * quotes in the native token `bc` (BIG) rather than a fiat stablecoin, and the
 * 24h figures come from the L1 ticker's `lastdayprice`/`lastdayQuantity` — one
 * `getOrdersTicker` call per quote base (BC plus discovered USDT/CNY), no
 * per-token series.
 */
export default function HomeScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const router = useRouter();
  const { publicInfo } = useWallet();

  const [markets, setMarkets] = React.useState<MarketRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const { messages: notices, unread: unreadNotices } = useSystemNotifications();
  const [refreshing, setRefreshing] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      // Quote bases: BC plus the fixed USDT/CNY tokens when the L1 has them.
      const bases: { id: string; name: string }[] = [{ id: 'bc', name: 'BC' }];
      for (const symbol of ['USDT', 'CNY']) {
        const tk = await httpService.findExchangeToken(symbol);
        if (tk?.tokenid && !bases.some((b) => b.id === tk.tokenid)) {
          bases.push({ id: tk.tokenid, name: symbol });
        }
      }
      const names: Record<string, { tokenname?: string; decimals?: number }> = {};
      // One row per traded token: keep the most recent match; the quote base
      // determines the raw price scale (tokenDecimals + priceShift).
      const latest = new Map<string, { tk: TickerRow; quote: { id: string; name: string } }>();
      for (const base of bases) {
        const res = await httpService.getOrdersTicker([], base.id);
        if (!res.success || !res.data) continue;
        const data = res.data as {
          tickers?: TickerRow[];
          tokennames?: Record<string, { tokenname?: string; decimals?: number }>;
        };
        Object.assign(names, data.tokennames || {});
        for (const tk of data.tickers || []) {
          if (!tk.tokenid) continue;
          const prev = latest.get(tk.tokenid);
          if (!prev || Number(tk.inserttime) > Number(prev.tk.inserttime)) {
            latest.set(tk.tokenid, { tk, quote: base });
          }
        }
      }
      const rows: MarketRow[] = [];
      for (const [tokenid, { tk, quote }] of latest) {
        const meta = names[tokenid];
        const dec = decimalsFor(tokenid, meta?.decimals);
        const scale = dec + orderPriceShift(quote.id);
        const price = toHuman(tk.price, scale);
        const dayPrice = toHuman(tk.lastdayprice, scale);
        const tokenName = meta?.tokenname || (tokenid === 'bc' ? 'BIG' : shortTokenId(tokenid));
        rows.push({
          tokenid,
          tokenName,
          quoteId: quote.id,
          // Keep the quote suffix for every pair, including native BC:
          // "CNY/BC", not just "CNY" (the Spot header shows CNY / BC).
          name: `${tokenName}/${quote.name}`,
          price,
          changePct: dayPrice > 0 && price > 0 ? ((price - dayPrice) / dayPrice) * 100 : null,
          volume: toHuman(tk.lastdayQuantity, dec),
        });
      }
      // Most traded first; a quiet market falls back to its price.
      rows.sort((a, b) => b.volume - a.volume || b.price - a.price);
      setMarkets(rows);
    } catch (e) {
      console.error('Error loading markets:', e);
    }
  }, []);

  React.useEffect(() => {
    (async () => { await load(); setLoading(false); })();
  }, [load]);

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return markets;
    return markets.filter(
      (m) => m.name.toLowerCase().includes(q) || m.tokenid.toLowerCase().includes(q),
    );
  }, [markets, search]);

  const top = markets[0];
  const popular = markets.slice(0, 8);

  // Deep-link the exact Home row into Spot. Without these params the trade
  // screen always opens its default market (Nvidia/USDT).
  const openMarket = (market: MarketRow) => {
    router.push({
      pathname: '/trade',
      params: {
        tokenid: market.tokenid,
        tokenname: market.tokenName,
        quote: market.quoteId,
      },
    } as never);
  };

  const actions: QuickAction[] = [
    { key: 'send', label: t('home.send'), icon: SendIcon, route: '/home/payment' },
    { key: 'receive', label: t('home.receive'), icon: QrScanIcon, route: '/receive' },
    { key: 'predict', label: t('predict.title'), icon: MarketIcon, route: '/predict' },
    { key: 'p2p', label: t('p2p.title'), icon: SwapIcon, route: '/p2p' },
    { key: 'spot', label: t('trade.title'), icon: ChartIcon, route: '/trade' },
  ];

  const changeColor = (c: number | null) =>
    c == null ? theme.colors.text.secondary : c >= 0 ? theme.colors.positive : theme.colors.negative;

  return (
    <View style={s.container} testID="home-screen">
      <ScrollView
        contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
      >
        {/* Hero: brand, top market and quick actions */}
        <View style={s.hero}>
          <Text style={s.heroBrand}>{t('sidebar.bigt')}</Text>

          {top && (
            <TouchableOpacity style={s.heroMarket} onPress={() => openMarket(top)} testID="home-top-market">
              <Text style={s.heroMarketName} numberOfLines={1}>{top.name}</Text>
              <View style={s.heroPriceRow}>
                <Text style={s.heroPrice}>{fmtPrice(top.price)}</Text>
                <Text style={[s.heroChange, { color: top.changePct != null && top.changePct < 0 ? '#FECACA' : '#D1FAE5' }]}>
                  {fmtChange(top.changePct)}
                </Text>
              </View>
            </TouchableOpacity>
          )}

          {publicInfo?.address ? (
            <Text style={s.heroAddress} numberOfLines={1} testID="home-address">
              {publicInfo.address.slice(0, 10)}…{publicInfo.address.slice(-6)}
            </Text>
          ) : null}

          <View style={s.quickRow}>
            {actions.map((a) => {
              const Icon = a.icon;
              return (
                <TouchableOpacity key={a.key} style={s.quickBtn} onPress={() => router.push(a.route as never)} testID={`home-action-${a.key}`}>
                  <View style={s.quickIcon}>
                    <Icon size={20} color="#FFFFFF" />
                  </View>
                  <Text style={s.quickLabel}>{a.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {notices.length > 0 && (
          <View style={s.noticeCard} testID="home-notifications">
            <View style={s.noticeHeader}>
              <View style={s.noticeTitleWrap}>
                <BellIcon size={16} color={theme.colors.primary} />
                <Text style={s.noticeTitle}>{t('notifications.title')}</Text>
                {unreadNotices > 0 && (
                  <View style={[s.noticeUnread, { backgroundColor: theme.colors.primary }]} testID="home-notifications-unread">
                    <Text style={s.noticeUnreadText}>{unreadNotices > 99 ? '99+' : unreadNotices}</Text>
                  </View>
                )}
              </View>
              <TouchableOpacity onPress={() => router.push('/notifications' as never)} testID="home-notifications-view-all">
                <Text style={[s.noticeLink, { color: theme.colors.text.link }]}>{t('notifications.viewAll')}</Text>
              </TouchableOpacity>
            </View>

            {notices.slice(0, 3).map((notice) => {
              const tone = notice.tone === 'success'
                ? theme.colors.positive
                : notice.tone === 'error'
                  ? theme.colors.negative
                  : theme.colors.primary;
              return (
                <View key={notice.id} style={[s.noticeRow, { borderTopColor: theme.colors.border }]} testID={`home-notice-${notice.id}`}>
                  <View style={[s.noticeDot, { backgroundColor: tone }, notice.read && { opacity: 0.35 }]} />
                  <View style={s.noticeCopy}>
                    <Text style={[s.noticeRowTitle, { color: theme.colors.text.primary }, !notice.read && { fontWeight: '700' }]} numberOfLines={1}>
                      {notice.title}
                    </Text>
                    {!!notice.body && (
                      <Text style={[s.noticeBody, { color: theme.colors.text.secondary }]} numberOfLines={2}>{notice.body}</Text>
                    )}
                  </View>
                  <Text style={[s.noticeTime, { color: theme.colors.text.secondary }]}>{fmtNoticeTime(notice.createdAt)}</Text>
                </View>
              );
            })}

            {unreadNotices > 0 && (
              <TouchableOpacity style={s.markReadBtn} onPress={() => markSystemMessagesRead()} testID="home-notifications-mark-read">
                <Text style={[s.noticeLink, { color: theme.colors.text.link }]}>{t('notifications.markAllRead')}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {loading ? (
          <View style={s.loader}><ActivityIndicator size="large" color={theme.colors.primary} /></View>
        ) : markets.length === 0 ? (
          <View style={s.emptyCard}><Text style={s.emptyTitle}>{t('home.empty')}</Text></View>
        ) : (
          <>
            {/* Popular strip */}
            {popular.length > 0 && (
              <View style={s.section}>
                <Text style={s.sectionTitle}>{t('home.popular')}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.popularRow}>
                  {popular.map((m, i) => (
                    <TouchableOpacity key={m.tokenid} style={s.popularCard} onPress={() => openMarket(m)} testID={`home-popular-${i}`}>
                      <Text style={s.popularName} numberOfLines={1}>{m.name}</Text>
                      <Text style={[s.popularPrice, { fontFamily: MONO_FONT }]}>{fmtPrice(m.price)}</Text>
                      <Text style={[s.popularChange, { color: changeColor(m.changePct), fontFamily: MONO_FONT }]}>{fmtChange(m.changePct)}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* Markets table */}
            <View style={s.section}>
              <View style={s.marketsHeader}>
                <Text style={s.sectionTitle}>{t('home.markets')}</Text>
                <View style={s.searchWrap}>
                  <SearchIcon size={15} color={theme.colors.text.secondary} />
                  <TextInput
                    style={s.searchInput}
                    value={search}
                    onChangeText={setSearch}
                    placeholder={t('home.search')}
                    placeholderTextColor={theme.colors.text.secondary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID="home-search"
                  />
                </View>
              </View>

              <View style={s.tableHead}>
                <Text style={[s.colToken, s.th]}>{t('home.token')}</Text>
                <Text style={[s.colPrice, s.th]}>{t('trade.price')}</Text>
                <Text style={[s.colChange, s.th]}>{t('trade.change24h')}</Text>
                <Text style={[s.colVolume, s.th]}>{t('trade.vol24h')}</Text>
              </View>

              {filtered.map((m, i) => (
                <TouchableOpacity key={m.tokenid} style={s.row} onPress={() => openMarket(m)} testID={`home-market-${i}`}>
                  <View style={s.colToken}>
                    <Text style={s.rowName} numberOfLines={1}>{m.name}</Text>
                    <Text style={s.rowSub} numberOfLines={1}>{shortTokenId(m.tokenid)}</Text>
                  </View>
                  <Text style={[s.colPrice, s.mono]}>{fmtPrice(m.price)}</Text>
                  <Text style={[s.colChange, s.mono, { color: changeColor(m.changePct) }]}>{fmtChange(m.changePct)}</Text>
                  <Text style={[s.colVolume, s.mono]}>{fmtCompact(m.volume)}</Text>
                </TouchableOpacity>
              ))}

              {filtered.length === 0 && (
                <View style={s.emptyCard}><Text style={s.emptyTitle}>{t('tokens.noMatches')}</Text></View>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  content: { padding: 16, paddingBottom: 40 },

  hero: { backgroundColor: theme.colors.primary, borderRadius: 16, padding: 18, marginBottom: 18 },
  heroBrand: { color: '#FFFFFF', fontSize: 26, fontWeight: '800', marginBottom: 14 },
  heroMarket: { backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: 12, padding: 12, marginBottom: 14 },
  heroMarketName: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontWeight: '600' },
  heroPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 4 },
  heroPrice: { color: '#FFFFFF', fontSize: 26, fontWeight: '800', fontFamily: MONO_FONT },
  heroChange: { fontSize: 13, fontWeight: '700', fontFamily: MONO_FONT },
  heroAddress: { color: 'rgba(255,255,255,0.75)', fontSize: 11, fontFamily: MONO_FONT, marginBottom: 14 },

  quickRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 4 },
  quickBtn: { alignItems: 'center', flex: 1 },
  quickIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  quickLabel: { color: '#FFFFFF', fontSize: 11, fontWeight: '600' },

  loader: { paddingVertical: 48, alignItems: 'center' },

  noticeCard: {
    backgroundColor: theme.colors.groupped.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    padding: 14,
    marginBottom: 18,
  },
  noticeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  noticeTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  noticeTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary },
  noticeUnread: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  noticeUnreadText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  noticeLink: { fontSize: 12, fontWeight: '600' },
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderTopWidth: 1, paddingTop: 10, marginTop: 10 },
  noticeDot: { width: 7, height: 7, borderRadius: 4, marginTop: 5 },
  noticeCopy: { flex: 1, minWidth: 0 },
  noticeRowTitle: { fontSize: 13, fontWeight: '600' },
  noticeBody: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  noticeTime: { fontSize: 10, marginTop: 2 },
  markReadBtn: { alignSelf: 'flex-end', marginTop: 10, paddingVertical: 2 },

  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 10 },

  popularRow: { gap: 10, paddingRight: 16 },
  popularCard: { width: 128, backgroundColor: theme.colors.groupped.surface, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 12, padding: 12 },
  popularName: { fontSize: 13, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  popularPrice: { fontSize: 14, fontWeight: '600', color: theme.colors.text.primary, marginBottom: 2 },
  popularChange: { fontSize: 12, fontWeight: '700' },

  marketsHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  searchWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, maxWidth: 220, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, paddingHorizontal: 10, paddingVertical: 7 },
  searchInput: { flex: 1, color: theme.colors.text.primary, fontSize: 13, padding: 0 },

  tableHead: { flexDirection: 'row', alignItems: 'center', paddingBottom: 8, marginTop: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  th: { fontSize: 10, fontWeight: '700', color: theme.colors.text.secondary, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.border },

  colToken: { flex: 1.6, minWidth: 0, paddingRight: 6 },
  colPrice: { flex: 1, textAlign: 'right', fontSize: 13, color: theme.colors.text.primary },
  colChange: { flex: 0.9, textAlign: 'right', fontSize: 13 },
  colVolume: { flex: 1, textAlign: 'right', fontSize: 13, color: theme.colors.text.secondary },
  mono: { fontFamily: MONO_FONT },
  rowName: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
  rowSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 1 },

  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 28, alignItems: 'center', marginTop: 8 },
  emptyTitle: { fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary },
}));
