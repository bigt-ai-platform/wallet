import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl, useWindowDimensions, Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as Clipboard from 'expo-clipboard';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import { orderOnLayer1 } from '@/services/transaction';
import { recordOrder } from '@/services/tracking';
import { BC_DECIMALS, decimalsFor, orderPriceShift } from '@/lib/tokenformat';
import { utcOffsetLabel } from '@/lib/timeformat';
import { CopyIcon } from '@/components/Icons';
import WalletUnlock from '@/components/WalletUnlock';
import {
  PriceChart, VolumeChart, INTERVALS,
  type ChartData, type ChartPoint,
} from '@/components/MarketChart';
import { MONO_FONT } from '@/constants/fonts';
import type { MarketPrice, OrderInfo, RecentTrade, TokenItem, WalletAccountItem } from '@/types/api';

const PERCENTS = [25, 50, 75, 100] as const;

/**
 * Quote assets the screen can price a token against: the chain base "bc"
 * plus the fixed tokens that exist on the L1 order chain, matched by name at
 * runtime (see the quote discovery effect). Binance-style pair labels keep
 * the traded token on the left and the quote on the right, e.g. BTC/CNY.
 */
const QUOTE_SYMBOLS = ['CNY'] as const;

interface SelectedToken {
  tokenid: string;
  tokenname: string;
  decimals: number;
}

type QuoteToken = SelectedToken;

const BC_QUOTE: QuoteToken = {
  tokenid: 'bc',
  tokenname: 'BC',
  decimals: BC_DECIMALS,
};

interface BookLevel {
  price: number;
  amount: number;
  total: number;
}

type OrderKind = 'buy' | 'sell';

/**
 * Binance-style spot trade screen, laid out like the reference trade page:
 *
 *   ┌── pair + 24h stats ──────────────────────────────────────────┐
 *   │ Order Book │      Chart (top)                              │ Market      │
 *   │  (asks)    │ ──────────────────────────────                │ Trades      │
 *   │  (bids)    │      Buy form     │     Sell form             │ (recent)    │
 *   └────────────┴────────────────────┴───────────────────────────┴─────────────┘
 *
 * On narrow screens the columns stack and the two order forms collapse into a
 * Buy/Sell toggle (Binance's mobile behaviour).
 *
 * Live data comes from the L1 order chain: the aggregated bid/ask book from
 * `getOrders`, executed matches from `getOrdersTicker`, and the time-series
 * from `getOrdersTicker`. Raw on-chain long values are scaled by the traded
 * token's decimals (the L1 matcher prices with `tokenDecimals + priceShift`,
 * and `priceShift` is 0 for the `bc` base), mirroring Java `MarketOrderItem`.
 */
export default function TradeScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { isUnlocked, publicInfo, getUnlockedWallet } = useWallet();
  const { width } = useWindowDimensions();
  const isWide = width >= 820;

  const [tokenSearch, setTokenSearch] = React.useState('');
  const [tokenResults, setTokenResults] = React.useState<MarketPrice[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [selected, setSelected] = React.useState<SelectedToken | null>(null);
  const tokenDecimals = selected ? decimalsFor(selected.tokenid, selected.decimals) : 0;

  const [interval, setIntervalMinutes] = React.useState(1440);
  const [intervalOpen, setIntervalOpen] = React.useState(false);
  const [chart, setChart] = React.useState<ChartData | null>(null);
  const [chartW, setChartW] = React.useState(320);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  const [orders, setOrders] = React.useState<OrderInfo[]>([]);
  const [trades, setTrades] = React.useState<RecentTrade[]>([]);
  const [stats, setStats] = React.useState<{ last: number; change: number; high: number; low: number; vol: number }>({ last: 0, change: 0, high: 0, low: 0, vol: 0 });

  // Shared price (Binance syncs the price across the buy/sell forms) with a
  // separate amount/total per side; mobile shows one side at a time.
  const [price, setPrice] = React.useState('');
  const [amountBuy, setAmountBuy] = React.useState('');
  const [totalBuy, setTotalBuy] = React.useState('');
  const [amountSell, setAmountSell] = React.useState('');
  const [totalSell, setTotalSell] = React.useState('');
  const [mobileSide, setMobileSide] = React.useState<OrderKind>('buy');
  const [submitting, setSubmitting] = React.useState<OrderKind | null>(null);

  const [balances, setBalances] = React.useState<WalletAccountItem[]>([]);
  const [quote, setQuote] = React.useState<QuoteToken>(BC_QUOTE);
  const [quotes, setQuotes] = React.useState<QuoteToken[]>([BC_QUOTE]);

  // Raw order prices carry the quote shift too: scale = tokenDecimals +
  // priceShift(quote), 6 for CNY against 0 for bc.
  const priceShift = orderPriceShift(quote.tokenid);
  const priceDecimals = tokenDecimals + priceShift;

  /** Raw long → human number using the token's decimals. */
  const toHuman = (raw: number | undefined, dec: number) => (Number(raw) || 0) / Math.pow(10, dec);
  const trim = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(8))) : '');

  const searchTokens = async (keyword: string) => {
    setTokenSearch(keyword);
    if (!keyword.trim()) { setTokenResults([]); return; }
    setSearching(true);
    try {
      const res = await httpService.searchExchangeTokens(keyword.trim());
      if (res.success && res.data) {
        setTokenResults(res.data.map((tk) => ({
          tokenid: tk.tokenid,
          tokenname: tk.tokenname || tk.tokenid?.slice(0, 8),
          price: '0', change: '0', executedquantity: '0', decimals: tk.decimals,
        })));
      }
    } catch (e) { console.error('Error searching tokens:', e); }
    finally { setSearching(false); }
  };

  // Resolve the known quote assets (BC plus CNY when this L1 chain has it).
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const found: QuoteToken[] = [BC_QUOTE];
      for (const symbol of QUOTE_SYMBOLS) {
        try {
          const res = await httpService.searchExchangeTokens(symbol);
          if (!res.success || !res.data) continue;
          const tk = res.data.find((t) => (t.tokenname || '').trim().toUpperCase() === symbol);
          if (tk?.tokenid && tk.tokenid !== BC_QUOTE.tokenid) {
            found.push({ tokenid: tk.tokenid, tokenname: symbol, decimals: tk.decimals ?? 0 });
          }
        } catch { /* chain has no such quote token */ }
      }
      if (!cancelled) setQuotes(found);
    })();
    return () => { cancelled = true; };
  }, []);

  const selectQuote = (next: QuoteToken) => {
    if (next.tokenid === quote.tokenid) return;
    setQuote(next);
    if (selected) {
      loadChart(selected, interval, next);
      loadMarket(selected, next);
    }
  };

  const selectToken = (tk: { tokenid: string; tokenname?: string; decimals?: number }, q: QuoteToken = quote) => {
    const next: SelectedToken = {
      tokenid: tk.tokenid,
      tokenname: tk.tokenname || tk.tokenid.slice(0, 8),
      decimals: decimalsFor(tk.tokenid, tk.decimals),
    };
    setSelected(next);
    setTokenSearch(next.tokenname);
    setTokenResults([]);
    loadChart(next, interval, q);
    loadMarket(next, q);
  };

  const loadChart = async (token: SelectedToken, intervalMinutes: number, q: QuoteToken = quote) => {
    try {
      const res = await httpService.getOrdersTickerSeries(token.tokenid, intervalMinutes, q.tokenid);
      if (res.success && res.data) {
        const resp = res.data as { tickers?: any[]; tokennames?: Record<string, TokenItem> };
        const dec = decimalsFor(token.tokenid, resp.tokennames?.[token.tokenid]?.decimals ?? token.decimals);
        const pdec = dec + orderPriceShift(q.tokenid);
        const datas: ChartPoint[] = (resp.tickers || [])
          .filter((tk: any) => tk.tokenid === token.tokenid)
          .map((tk: any) => ({
            price: toHuman(tk.price, pdec),
            executedQuantity: toHuman(tk.executedQuantity, dec),
            time: Number(tk.inserttime) * 1000,
          }))
          .filter((d) => d.time > 0);
        setChart({ tokenid: token.tokenid, tokenname: token.tokenname, datas });
      }
    } catch (e) { console.error('Error loading chart:', e); }
  };

  const loadMarket = async (token: SelectedToken, q: QuoteToken = quote) => {
    setLoading(true);
    try {
      const [bookRes, tradesRes, dayRes] = await Promise.all([
        httpService.getOrderBook(token.tokenid),
        httpService.getRecentTrades(token.tokenid, q.tokenid),
        httpService.getOrdersTickerSeries(token.tokenid, 1440, q.tokenid),
      ]);

      if (bookRes.success && bookRes.data) {
        // Keep only orders whose traded leg is this token against the quote.
        setOrders(bookRes.data.orders.filter((o) =>
          (o.offerTokenid === token.tokenid || o.targetTokenid === token.tokenid) &&
          (o.offerTokenid === q.tokenid || o.targetTokenid === q.tokenid)));
      }

      if (tradesRes.success && tradesRes.data) {
        setTrades((tradesRes.data.tickers || []).filter((tk) => tk.tokenid === token.tokenid));
      }

      if (dayRes.success && dayRes.data) {
        const resp = dayRes.data as { tickers?: any[]; tokennames?: Record<string, TokenItem> };
        const dec = decimalsFor(token.tokenid, resp.tokennames?.[token.tokenid]?.decimals ?? token.decimals);
        const pdec = dec + orderPriceShift(q.tokenid);
        const pts = (resp.tickers || [])
          .filter((tk: any) => tk.tokenid === token.tokenid)
          .map((tk: any) => ({
            price: toHuman(tk.price, pdec),
            qty: toHuman(tk.executedQuantity, dec),
            time: Number(tk.inserttime) * 1000,
          }))
          .sort((a, b) => a.time - b.time);
        if (pts.length > 0) {
          const first = pts[0].price;
          const last = pts[pts.length - 1].price;
          setStats({
            last,
            change: first > 0 ? ((last - first) / first) * 100 : 0,
            high: Math.max(...pts.map((p) => p.price)),
            low: Math.min(...pts.map((p) => p.price)),
            vol: pts.reduce((s, p) => s + p.qty, 0),
          });
          setPrice((cur) => (cur && Number(cur) > 0 ? cur : String(last)));
        }
      }
    } catch (e) { console.error('Error loading market:', e); }
    finally { setLoading(false); setRefreshing(false); }
  };

  /** Balances on the active L1 order chain (Avbl for the two order forms). */
  const loadBalances = React.useCallback(async () => {
    if (!isUnlocked || !publicInfo?.address) return;
    const unlocked = getUnlockedWallet();
    if (!unlocked) return;
    try {
      const l1Url = httpService.getL1Url();
      const l1Base = httpService.l1Bases(l1Url)[0] ?? l1Url;
      const res = await httpService.getBalancesOn(l1Base, unlocked.wallet.privateKey, unlocked.wallet.keyType);
      if (res.success && res.data) setBalances(res.data);
    } catch (e) { console.error('Error loading L1 balances:', e); }
  }, [isUnlocked, publicInfo?.address, getUnlockedWallet]);

  // Preselect the default market on first open: Nvidia quoted in CNY when the
  // chain has both, falling back to the old "yuan" market; the quote falls
  // back to BC when the chain has no CNY token.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let defaultQuote = BC_QUOTE;
        const qres = await httpService.searchExchangeTokens('CNY');
        if (cancelled) return;
        const cny = qres.success && qres.data
          ? qres.data.find((tk) => (tk.tokenname || '').trim().toUpperCase() === 'CNY')
          : undefined;
        if (cny && cny.tokenid !== BC_QUOTE.tokenid) {
          defaultQuote = { tokenid: cny.tokenid, tokenname: 'CNY', decimals: cny.decimals ?? 0 };
        }
        const findToken = async (name: string, firstIfNoExact = false) => {
          const res = await httpService.searchExchangeTokens(name);
          if (!res.success || !res.data || res.data.length === 0) return undefined;
          const want = name.trim().toUpperCase();
          return res.data.find((tk) => (tk.tokenname || '').trim().toUpperCase() === want)
            ?? (firstIfNoExact ? res.data[0] : undefined);
        };
        const token = (await findToken('Nvidia')) ?? (await findToken('yuan', true));
        if (cancelled || !token) return;
        if (defaultQuote.tokenid !== BC_QUOTE.tokenid) setQuote(defaultQuote);
        selectToken({ tokenid: token.tokenid, tokenname: token.tokenname, decimals: token.decimals }, defaultQuote);
      } catch { /* no default market available */ }
    })();
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => { loadBalances(); }, [loadBalances]);

  const onRefresh = () => {
    if (!selected) return;
    setRefreshing(true);
    loadChart(selected, interval);
    loadMarket(selected);
    loadBalances();
  };

  const changeInterval = (minutes: number) => {
    setIntervalMinutes(minutes);
    if (selected) loadChart(selected, minutes);
  };

  const balOf = (tokenid: string) =>
    Number(balances.find((b) => b.tokenid === tokenid)?.balance || 0);
  const availableFor = (kind: OrderKind) =>
    kind === 'buy' ? balOf(quote.tokenid) : selected ? balOf(selected.tokenid) : 0;

  const amountOf = (kind: OrderKind) => (kind === 'buy' ? amountBuy : amountSell);
  const setAmountOf = (kind: OrderKind, v: string) => (kind === 'buy' ? setAmountBuy(v) : setAmountSell(v));
  const setTotalOf = (kind: OrderKind, v: string) => (kind === 'buy' ? setTotalBuy(v) : setTotalSell(v));

  const recalc = (kind: OrderKind) => {
    const p = parseFloat(price) || 0;
    const a = parseFloat(amountOf(kind)) || 0;
    setTotalOf(kind, p * a > 0 ? trim(p * a) : '');
  };

  const applyPercent = (kind: OrderKind, pct: number) => {
    const p = parseFloat(price) || 0;
    const avbl = availableFor(kind);
    if (kind === 'sell') {
      const a = (avbl * pct) / 100;
      setAmountSell(trim(a));
      setTotalSell(p * a > 0 ? trim(p * a) : '');
    } else {
      if (p <= 0) return;
      const a = ((avbl * pct) / 100) / p;
      setAmountBuy(trim(a));
      setTotalBuy(trim(p * a));
    }
  };

  const submitOrder = async (kind: OrderKind) => {
    if (!selected || !publicInfo?.address) return;
    const priceNum = parseFloat(price);
    const amountNum = parseFloat(amountOf(kind));
    if (!priceNum || priceNum <= 0) { Alert.alert('', t('trade.invalidPrice')); return; }
    if (!amountNum || amountNum <= 0) { Alert.alert('', t('trade.invalidAmount')); return; }
    if (!isUnlocked) { Alert.alert(t('wallet.locked'), t('order.unlockFirst')); return; }

    const wallet = getUnlockedWallet();
    if (!wallet) { Alert.alert('', t('order.unlockFirst')); return; }
    const l1Url = httpService.getL1Url();
    if (!l1Url) { Alert.alert('', t('order.noL1')); return; }

    setSubmitting(kind);
    try {
      const dec = tokenDecimals;
      const scale = Math.pow(10, dec);
      const rawScale = Math.pow(10, dec + priceShift);
      const txHash = await orderOnLayer1({
        side: kind,
        privateKeyHex: wallet.wallet.privateKey,
        keyType: wallet.wallet.keyType,
        l1Url: httpService.l1Bases(l1Url)[0] ?? l1Url,
        tokenId: selected.tokenid,
        price: BigInt(Math.floor(priceNum * rawScale)),
        amount: BigInt(Math.floor(amountNum * scale)),
        baseToken: quote.tokenid,
        decimals: dec,
      });
      recordOrder({
        side: kind,
        tokenId: selected.tokenid,
        tokenName: selected.tokenname,
        baseToken: quote.tokenid,
        price,
        amount: amountOf(kind),
        decimals: dec,
        fromAddress: publicInfo.address,
        txHash,
      });
      Alert.alert(
        t('trade.orderPlaced'),
        t('order.orderPlacedDesc', { side: kind === 'buy' ? t('order.buy') : t('order.sell'), amount: amountNum, token: selected.tokenname, price: priceNum }),
      );
      setAmountOf(kind, '');
      setTotalOf(kind, '');
      loadMarket(selected);
      loadBalances();
    } catch (e: any) {
      Alert.alert('', e.message || t('trade.submitFailed'));
    } finally { setSubmitting(null); }
  };

  const book = React.useMemo(() => {
    const askMap = new Map<number, number>();
    const bidMap = new Map<number, number>();
    for (const o of orders) {
      const rawPrice = Number(o.price) || 0;
      if (rawPrice <= 0) continue;
      const s = (o.side || '').toUpperCase();
      const isBuy = s === 'BUY' || (s !== 'SELL' && o.offerTokenid === (o.orderBaseToken || quote.tokenid));
      const levelPrice = toHuman(rawPrice, priceDecimals);
      const amountRaw = isBuy ? o.targetValue : o.offerValue;
      const levelAmount = toHuman(Number(amountRaw), tokenDecimals);
      const map = isBuy ? bidMap : askMap;
      map.set(levelPrice, (map.get(levelPrice) || 0) + levelAmount);
    }
    const build = (map: Map<number, number>, desc: boolean): BookLevel[] => {
      const levels = [...map.entries()].map(([p, a]) => ({ price: p, amount: a, total: 0 }));
      levels.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
      let cum = 0;
      for (const l of levels) { cum += l.amount; l.total = cum; }
      return levels.slice(0, 12);
    };
    // Binance layout: both sides descend top→bottom and the best price sits
    // nearest the last-price row in the middle — asks are built best-first
    // (for the cheapest-12 slice + totals) then reversed for display.
    let askVol = 0;
    for (const v of askMap.values()) askVol += v;
    let bidVol = 0;
    for (const v of bidMap.values()) bidVol += v;
    return { asks: build(askMap, false).reverse(), bids: build(bidMap, true), askVol, bidVol };
  }, [orders, tokenDecimals, priceDecimals, quote.tokenid]);

  const myOrders = React.useMemo(
    () => (publicInfo?.address
      ? orders.filter((o) => (o.beneficiaryAddress || '').toLowerCase() === publicInfo.address.toLowerCase())
      : []),
    [orders, publicInfo?.address],
  );

  const recentTrades = React.useMemo(
    () => [...trades]
      .sort((a, b) => Number(b.inserttime) - Number(a.inserttime))
      .slice(0, 30)
      .map((tr, i, arr) => {
        const prev = arr[i + 1];
        return {
          price: toHuman(tr.price, priceDecimals),
          amount: toHuman(tr.executedQuantity, tokenDecimals),
          time: Number(tr.inserttime) * 1000,
          up: !prev || Number(tr.price) >= Number(prev.price),
        };
      }),
    [trades, tokenDecimals, priceDecimals],
  );

  const fmtNum = (v: number, maxFrac = 6) =>
    Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: maxFrac }) : '0';
  // A bare clock time is ambiguous across days, so the AM/PM suffix is
  // replaced by the date: "HH:mm:ss MM/DD" (24-hour).
  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getMonth() + 1)}/${p(d.getDate())}`;
  };
  const maxTotal = Math.max(book.asks[book.asks.length - 1]?.total ?? 0, book.bids[book.bids.length - 1]?.total ?? 0, 1);
  // Binance's buy/sell pressure split under the book.
  const bookDepth = book.askVol + book.bidVol;
  const bidPct = bookDepth > 0 ? (book.bidVol / bookDepth) * 100 : 50;
  const askPct = 100 - bidPct;
  const intervalLabel = INTERVALS.find((iv) => iv.minutes === interval)?.label ?? '1d';
  // Times are rendered in the device timezone; label it next to the selector.
  const tzLabel = utcOffsetLabel(Date.now());
  const sortedTimes = chart?.datas?.length ? [...chart.datas].sort((a, b) => a.time - b.time) : [];
  const firstTime = sortedTimes[0]?.time ?? 0;
  const lastTime = sortedTimes[sortedTimes.length - 1]?.time ?? 0;
  const changeColor = stats.change >= 0 ? theme.colors.positive : theme.colors.negative;

  const statItems = (
    <>
      <View style={s.statItem}>
        <Text style={s.statLabel}>{t('trade.lastPrice')}</Text>
        <Text style={[s.statValue, { color: changeColor }]} testID="trade-last-price">{fmtNum(stats.last)}</Text>
      </View>
      <View style={s.statItem}>
        <Text style={s.statLabel}>{t('trade.change24h')}</Text>
        <Text style={[s.statValue, { color: changeColor }]} testID="trade-change">{`${stats.change >= 0 ? '+' : ''}${stats.change.toFixed(2)}%`}</Text>
      </View>
      <View style={s.statItem}>
        <Text style={s.statLabel}>{t('trade.high24h')}</Text>
        <Text style={s.statValue}>{fmtNum(stats.high)}</Text>
      </View>
      <View style={s.statItem}>
        <Text style={s.statLabel}>{t('trade.low24h')}</Text>
        <Text style={s.statValue}>{fmtNum(stats.low)}</Text>
      </View>
      <View style={s.statItem}>
        <Text style={s.statLabel}>{t('trade.vol24h')}</Text>
        <Text style={s.statValue}>{fmtNum(stats.vol, 2)}</Text>
      </View>
    </>
  );

  const pairHeader = (
    <View style={s.card}>
      <View style={s.headerRow}>
        <View style={s.pairPicker}>
          <TextInput
            style={s.input}
            value={tokenSearch}
            onChangeText={searchTokens}
            placeholder={t('trade.searchToken')}
            placeholderTextColor={theme.colors.text.secondary}
            autoCapitalize="none" autoCorrect={false}
            testID="trade-token-search"
          />
          {searching ? (
            <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginTop: 8 }} />
          ) : tokenResults.length > 0 ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 8 }} testID="trade-token-results">
              {tokenResults.map((tk, i) => (
                <TouchableOpacity key={i} style={[s.chip, selected?.tokenid === tk.tokenid && s.chipActive]} onPress={() => selectToken(tk)} testID={`trade-token-${i}`}>
                  <Text style={[s.chipText, selected?.tokenid === tk.tokenid && s.chipTextActive]}>{tk.tokenname}</Text>
                  <Text style={[s.chipSub, selected?.tokenid === tk.tokenid && s.chipSubActive]}>{tk.tokenid.slice(0, 10)}...</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : selected ? (
            <View style={s.selectedRow}>
              <Text style={s.selectedText} testID="trade-selected-token" numberOfLines={1}>
                {selected.tokenname} / {quote.tokenname}
              </Text>
              <TouchableOpacity
                style={s.copyBtn}
                accessibilityRole="button"
                accessibilityLabel={t('receive.copy')}
                testID="trade-token-copy"
                onPress={() => { Clipboard.setStringAsync(selected.tokenid).catch(() => {}); }}
              >
                <CopyIcon size={14} color={theme.colors.text.link} />
              </TouchableOpacity>
            </View>
          ) : null}
          {quotes.length > 1 && (
            <View style={s.quoteRow} testID="trade-quote-options">
              {quotes.map((q) => (
                <TouchableOpacity
                  key={q.tokenid}
                  style={[s.chip, quote.tokenid === q.tokenid && s.chipActive]}
                  onPress={() => selectQuote(q)}
                  testID={`trade-quote-${q.tokenname.toLowerCase()}`}
                >
                  <Text style={[s.chipText, quote.tokenid === q.tokenid && s.chipTextActive]}>
                    {q.tokenname.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
        {isWide && <View style={s.statsInline}>{statItems}</View>}
      </View>
      {!isWide && <View style={s.statsRow}>{statItems}</View>}
    </View>
  );

  const orderBookCard = (
    <View style={s.card} testID="trade-orderbook">
      <Text style={s.cardTitle}>{t('trade.orderBook')}</Text>
      <View style={s.bookHead}>
        <Text style={[s.bookHeadText, s.bookPrice]}>{t('trade.price')}({quote.tokenname})</Text>
        <Text style={[s.bookHeadText, s.bookAmount]}>{t('order.amount')}</Text>
        <Text style={[s.bookHeadText, s.bookTotal]}>{t('order.total')}</Text>
      </View>
      {!selected ? (
        <View style={s.emptyCard}><Text style={s.emptyText}>{t('trade.selectFirst')}</Text></View>
      ) : orders.length === 0 ? (
        <View style={s.emptyCard}><Text style={s.emptyText}>{t('trade.noOrders')}</Text></View>
      ) : (
        <>
          <Text style={[s.bookSide, { color: theme.colors.negative }]} testID="trade-asks-label">{t('order.sell')}</Text>
          <View testID="trade-asks">
            {book.asks.map((l) => (
              <View key={`a-${l.price}`} style={s.bookRow}>
                <View style={[s.depthBar, { width: (`${Math.max((l.total / maxTotal) * 100, 2)}%` as `${number}%`), backgroundColor: theme.colors.accent.red }]} />
                <Text style={[s.bookPrice, { color: theme.colors.negative }]}>{fmtNum(l.price)}</Text>
                <Text style={[s.bookAmount, s.mono]}>{fmtNum(l.amount)}</Text>
                <Text style={[s.bookTotal, s.mono]}>{fmtNum(l.total)}</Text>
              </View>
            ))}
          </View>
          <View style={s.midPrice}>
            <Text style={[s.midPriceText, { color: changeColor }]}>{fmtNum(stats.last)}</Text>
          </View>
          <Text style={[s.bookSide, { color: theme.colors.positive }]} testID="trade-bids-label">{t('order.buy')}</Text>
          <View testID="trade-bids">
            {book.bids.map((l) => (
              <View key={`b-${l.price}`} style={s.bookRow}>
                <View style={[s.depthBar, { width: (`${Math.max((l.total / maxTotal) * 100, 2)}%` as `${number}%`), backgroundColor: theme.colors.accent.emerald }]} />
                <Text style={[s.bookPrice, { color: theme.colors.positive }]}>{fmtNum(l.price)}</Text>
                <Text style={[s.bookAmount, s.mono]}>{fmtNum(l.amount)}</Text>
                <Text style={[s.bookTotal, s.mono]}>{fmtNum(l.total)}</Text>
              </View>
            ))}
          </View>
          <View style={s.bookRatio} testID="trade-book-ratio">
            <Text style={[s.bookRatioLabel, { color: theme.colors.positive }]}>{`B ${bidPct.toFixed(2)}%`}</Text>
            <View style={s.bookRatioBar}>
              <View style={[s.bookRatioSeg, { width: (`${bidPct}%` as `${number}%`), backgroundColor: theme.colors.positive }]} />
              <View style={[s.bookRatioSeg, { width: (`${askPct}%` as `${number}%`), backgroundColor: theme.colors.negative }]} />
            </View>
            <Text style={[s.bookRatioLabel, { color: theme.colors.negative }]}>{`${askPct.toFixed(2)}% S`}</Text>
          </View>
        </>
      )}
    </View>
  );

  const recentTradesCard = (
    <View style={s.card} testID="trade-recent-trades">
      <Text style={s.cardTitle}>{t('trade.recentTrades')}</Text>
      <View style={s.bookHead}>
        <Text style={[s.bookHeadText, s.bookPrice]}>{t('trade.price')}({quote.tokenname})</Text>
        <Text style={[s.bookHeadText, s.bookAmount]}>{t('order.amount')}</Text>
        <Text style={[s.bookHeadText, s.bookTotal]}>{t('trade.time')} ({tzLabel})</Text>
      </View>
      {recentTrades.length === 0 ? (
        <View style={s.emptyCard}><Text style={s.emptyText}>{t('trade.noTrades')}</Text></View>
      ) : (
        recentTrades.map((tr, i) => (
          <View key={i} style={s.bookRow} testID={`trade-trade-${i}`}>
            <Text style={[s.bookPrice, { color: tr.up ? theme.colors.positive : theme.colors.negative }]}>{fmtNum(tr.price)}</Text>
            <Text style={[s.bookAmount, s.mono]}>{fmtNum(tr.amount)}</Text>
            <Text style={[s.bookTotal, s.mono]}>{fmtTime(tr.time)}</Text>
          </View>
        ))
      )}
    </View>
  );

  const myOrdersCard = myOrders.length > 0 ? (
    <View style={s.card} testID="trade-my-orders">
      <Text style={s.cardTitle}>{t('order.yourOrders')}</Text>
      {myOrders.map((o, i) => {
        const isBuy = (o.side || '').toUpperCase() === 'BUY';
        return (
          <View key={i} style={s.bookRow}>
            <Text style={[s.bookPrice, { color: isBuy ? theme.colors.positive : theme.colors.negative }]}>
              {isBuy ? t('order.buy') : t('order.sell')}
            </Text>
            <Text style={[s.bookAmount, s.mono]}>{fmtNum(toHuman(isBuy ? o.targetValue : o.offerValue, tokenDecimals))}</Text>
            <Text style={[s.bookTotal, s.mono]}>{fmtNum(toHuman(Number(o.price), priceDecimals))}</Text>
          </View>
        );
      })}
    </View>
  ) : null;

  const chartCard = (
    <View style={s.card} onLayout={(e) => setChartW(Math.max(e.nativeEvent.layout.width - 28, 160))}>
      <View style={s.chartHeader}>
        <Text style={s.cardTitle}>{selected ? `${selected.tokenname} / ${quote.tokenname}` : t('trade.title')}</Text>
        {loading && <ActivityIndicator size="small" color={theme.colors.primary} />}
      </View>
      {selected && (
        <View style={s.intervalRow} testID="trade-intervals">
          <TouchableOpacity
            onPress={() => setIntervalOpen(true)}
            style={s.intervalSelect}
            testID="trade-interval-select"
            accessibilityRole="button"
            accessibilityLabel={intervalLabel}
          >
            <Text style={s.intervalSelectText}>{intervalLabel}</Text>
            <Text style={s.intervalCaret}>▾</Text>
          </TouchableOpacity>
          <Text style={s.tzText}>{tzLabel}</Text>
        </View>
      )}
      <Modal visible={intervalOpen} transparent animationType="fade" onRequestClose={() => setIntervalOpen(false)}>
        <TouchableOpacity style={s.modalOverlay} activeOpacity={1} onPress={() => setIntervalOpen(false)}>
          <View style={s.intervalDialog}>
            <ScrollView style={s.intervalList} showsVerticalScrollIndicator={false}>
              {INTERVALS.map((iv) => (
                <TouchableOpacity
                  key={iv.minutes}
                  onPress={() => { setIntervalOpen(false); changeInterval(iv.minutes); }}
                  style={[s.intervalOption, interval === iv.minutes && s.intervalOptionActive]}
                  testID={`trade-interval-${iv.minutes}`}
                >
                  <Text style={[s.intervalOptionText, interval === iv.minutes && s.intervalOptionTextActive]}>{iv.label}</Text>
                  {interval === iv.minutes && <Text style={s.intervalOptionCheck}>✓</Text>}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
      {!selected ? (
        <View style={s.emptyCard}><Text style={s.emptyText}>{t('trade.selectFirst')}</Text></View>
      ) : chart && chart.datas.length === 0 ? (
        <View style={s.emptyCard}><Text style={s.emptyText}>{t('chart.noData')}</Text></View>
      ) : (
        <>
          <PriceChart
            chart={chart}
            width={chartW}
            height={isWide ? 200 : 220}
            intervalMinutes={interval}
            dividerColor={theme.colors.divider}
            textColor={theme.colors.text.secondary}
            posColor={theme.colors.positive}
            negColor={theme.colors.negative}
            testID="trade-chart-price"
          />
          <View style={s.dateRow}>
            <Text style={s.dateLabel}>{firstTime ? new Date(firstTime).toLocaleDateString() : ''}</Text>
            <Text style={s.dateLabel}>{intervalLabel}</Text>
            <Text style={s.dateLabel}>{lastTime ? new Date(lastTime).toLocaleDateString() : ''}</Text>
          </View>
          <VolumeChart
            chart={chart}
            width={chartW}
            height={isWide ? 90 : 110}
            intervalMinutes={interval}
            textColor={theme.colors.text.secondary}
            posColor={theme.colors.positive}
            negColor={theme.colors.negative}
            testID="trade-chart-volume"
          />
        </>
      )}
    </View>
  );

  const orderPanel = (kind: OrderKind) => {
    const isBuy = kind === 'buy';
    const amount = isBuy ? amountBuy : amountSell;
    const total = isBuy ? totalBuy : totalSell;
    const avbl = availableFor(kind);
    const unit = isBuy ? quote.tokenname : selected?.tokenname ?? '';
    const accent = isBuy ? theme.colors.accent.emerald : theme.colors.accent.red;
    return (
      <View style={[s.card, s.orderPanel]} testID={`trade-${kind}-panel`}>
        <View style={s.panelHead}>
          <Text style={[s.panelTitle, { color: isBuy ? theme.colors.positive : theme.colors.negative }]}>
            {isBuy ? t('order.buy') : t('order.sell')}
          </Text>
          <Text style={s.panelSub}>{baseTokenLabel()}</Text>
        </View>
        <View style={s.avblRow}>
          <Text style={s.avblLabel}>{t('transaction.available')}</Text>
          <Text style={s.avblValue}>{fmtNum(avbl)} {unit}</Text>
        </View>
        <View style={s.fieldGroup}>
          <Text style={s.fieldLabel}>{t('trade.priceLabel', { token: quote.tokenname })}</Text>
          <TextInput
            style={s.input} value={price}
            onChangeText={(v) => {
              setPrice(v);
              const p = parseFloat(v) || 0;
              const ab = parseFloat(amountBuy) || 0;
              const as = parseFloat(amountSell) || 0;
              setTotalBuy(p * ab > 0 ? trim(p * ab) : '');
              setTotalSell(p * as > 0 ? trim(p * as) : '');
            }}
            keyboardType="decimal-pad" placeholder="0.00"
            placeholderTextColor={theme.colors.text.secondary}
            testID={`trade-${kind}-price`}
          />
        </View>
        <View style={s.fieldGroup}>
          <Text style={s.fieldLabel}>{t('order.amount')}</Text>
          <TextInput
            style={s.input} value={amount}
            onChangeText={(v) => { setAmountOf(kind, v); const p = parseFloat(price) || 0; const a = parseFloat(v) || 0; setTotalOf(kind, p * a > 0 ? trim(p * a) : ''); }}
            keyboardType="decimal-pad" placeholder="0.00"
            placeholderTextColor={theme.colors.text.secondary}
            testID={`trade-${kind}-amount`}
          />
        </View>
        <View style={s.percentRow}>
          {PERCENTS.map((pct) => (
            <TouchableOpacity key={pct} style={s.percentBtn} onPress={() => applyPercent(kind, pct)} testID={`trade-${kind}-${pct}`}>
              <Text style={s.percentText}>{pct}%</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>{t('order.total')}</Text>
          <Text style={s.totalValue}>{total || '0'} {quote.tokenname.toUpperCase()}</Text>
        </View>
        <TouchableOpacity
          style={[s.submitBtn, { backgroundColor: accent }]}
          onPress={() => submitOrder(kind)} disabled={submitting !== null}
          testID={`trade-${kind}-submit`}
        >
          <Text style={s.submitBtnText}>
            {submitting === kind ? t('trade.placing') : `${isBuy ? t('order.buy') : t('order.sell')} ${selected?.tokenname ?? ''}`.trim()}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  function baseTokenLabel() {
    return selected ? `${selected.tokenname} / ${quote.tokenname}` : quote.tokenname;
  }

  // ---- layout ---------------------------------------------------------------

  if (!isWide) {
    return (
      <View style={s.container} testID="trade-screen">
        <View style={s.pageHeader}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('trade.title')}</Text>
          {loading && <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginLeft: 'auto' }} />}
        </View>
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
        >
          {pairHeader}
          {chartCard}
          {!isUnlocked ? (
            <View style={s.card}><WalletUnlock fullScreen={false} subtitle={t('order.unlockFirst')} testID="trade-unlock" /></View>
          ) : (
            <>
              <View style={s.sideToggle}>
                <TouchableOpacity style={[s.sideBtn, mobileSide === 'buy' && s.sideBuyActive]} onPress={() => setMobileSide('buy')} testID="trade-tab-buy">
                  <Text style={[s.sideBtnText, mobileSide === 'buy' && s.sideBtnTextActive]}>{t('order.buy')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.sideBtn, mobileSide === 'sell' && s.sideSellActive]} onPress={() => setMobileSide('sell')} testID="trade-tab-sell">
                  <Text style={[s.sideBtnText, mobileSide === 'sell' && s.sideBtnTextActive]}>{t('order.sell')}</Text>
                </TouchableOpacity>
              </View>
              {orderPanel(mobileSide)}
            </>
          )}
          {orderBookCard}
          {recentTradesCard}
          {myOrdersCard}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.container} testID="trade-screen">
      <View style={s.pageHeader}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} accessibilityRole="button" accessibilityLabel={t('common.back')}>
          <Text style={s.backText}>←</Text>
        </TouchableOpacity>
        <Text style={s.pageTitle}>{t('trade.title')}</Text>
        {loading && <ActivityIndicator size="small" color={theme.colors.primary} style={{ marginLeft: 'auto' }} />}
      </View>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
      >
        {pairHeader}
        <View style={s.columns}>
          <View style={s.colBook}>{orderBookCard}</View>
          <View style={s.colCenter}>
            {chartCard}
            {!isUnlocked ? (
              <View style={s.card}><WalletUnlock fullScreen={false} subtitle={t('order.unlockFirst')} testID="trade-unlock" /></View>
            ) : (
              <View style={s.formsRow}>
                <View style={s.formCol}>{orderPanel('buy')}</View>
                <View style={s.formCol}>{orderPanel('sell')}</View>
              </View>
            )}
          </View>
          <View style={s.colTrades}>
            {recentTradesCard}
            {myOrdersCard}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  pageHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 14 },
  backBtn: { padding: 4 },
  backText: { fontSize: 22, color: theme.colors.text.link, fontWeight: '700' },
  pageTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  scroll: { flex: 1 },
  content: { padding: 12, paddingBottom: 40 },

  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, padding: 12, marginBottom: 12 },
  cardTitle: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 9, fontSize: 14 },

  // pair header
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 16 },
  pairPicker: { flex: 1, minWidth: 0 },
  chip: { backgroundColor: theme.colors.groupped.background, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: theme.colors.border },
  chipActive: { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: theme.colors.text.link },
  chipTextActive: { color: '#FFFFFF' },
  chipSub: { fontSize: 10, color: theme.colors.text.secondary, marginTop: 1 },
  chipSubActive: { color: '#FFFFFF', opacity: 0.85 },
  selectedRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  selectedText: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: theme.colors.text.primary, fontFamily: MONO_FONT },
  copyBtn: { padding: 4 },
  quoteRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  statsInline: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, flexShrink: 0, maxWidth: '60%' },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, marginTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 },
  statItem: { minWidth: 72 },
  statLabel: { fontSize: 10, color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  statValue: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary, fontFamily: MONO_FONT },

  // chart
  chartHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  intervalRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  intervalSelect: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.groupped.background },
  intervalSelectText: { fontSize: 12, fontWeight: '700', color: theme.colors.text.primary },
  intervalCaret: { fontSize: 10, color: theme.colors.text.secondary },
  tzText: { fontSize: 10, fontWeight: '600', color: theme.colors.text.secondary },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  intervalDialog: { width: 200, maxWidth: '80%', borderRadius: theme.borderRadius.xl, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.groupped.surface, paddingVertical: 6 },
  intervalList: { maxHeight: 320 },
  intervalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 },
  intervalOptionActive: { backgroundColor: theme.colors.groupped.background },
  intervalOptionText: { fontSize: 14, color: theme.colors.text.primary },
  intervalOptionTextActive: { fontWeight: '700' },
  intervalOptionCheck: { fontSize: 14, color: theme.colors.text.link },
  dateRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2, marginBottom: 6 },
  dateLabel: { fontSize: 10, color: theme.colors.text.secondary },

  // 3-column layout
  columns: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  colBook: { width: 212, flexShrink: 0 },
  colCenter: { flex: 1, minWidth: 0 },
  colTrades: { width: 236, flexShrink: 0 },
  formsRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  formCol: { flex: 1, minWidth: 0 },
  orderPanel: { marginBottom: 12 },
  panelHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  panelTitle: { fontSize: 15, fontWeight: '800' },
  panelSub: { fontSize: 11, color: theme.colors.text.secondary, fontFamily: MONO_FONT },
  avblRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  avblLabel: { fontSize: 11, color: theme.colors.text.secondary },
  avblValue: { fontSize: 11, color: theme.colors.text.primary, fontFamily: MONO_FONT },
  fieldGroup: { marginBottom: 10 },
  fieldLabel: { fontSize: 11, fontWeight: '600', color: theme.colors.text.secondary, marginBottom: 5 },
  percentRow: { flexDirection: 'row', gap: 6, marginBottom: 10 },
  percentBtn: { flex: 1, alignItems: 'center', paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.groupped.background },
  percentText: { fontSize: 11, fontWeight: '600', color: theme.colors.text.secondary },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: theme.colors.border, marginBottom: 10 },
  totalLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.text.secondary },
  totalValue: { fontSize: 14, fontWeight: '700', color: theme.colors.text.primary, fontFamily: MONO_FONT },
  submitBtn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  submitBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },

  // mobile buy/sell toggle
  sideToggle: { flexDirection: 'row', borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border, marginBottom: 12 },
  sideBtn: { flex: 1, paddingVertical: 10, alignItems: 'center' },
  sideBuyActive: { backgroundColor: theme.colors.accent.emerald },
  sideSellActive: { backgroundColor: theme.colors.accent.red },
  sideBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.text.secondary },
  sideBtnTextActive: { color: '#FFFFFF' },

  // order book / trades table
  bookHead: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: theme.colors.border },
  bookHeadText: { fontSize: 10, color: theme.colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.3 },
  bookRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 3, position: 'relative' },
  depthBar: { position: 'absolute', right: 0, top: 1, bottom: 1, opacity: 0.12, borderRadius: 2 },
  bookPrice: { flex: 1, fontSize: 11, fontWeight: '600', fontFamily: MONO_FONT },
  bookAmount: { flex: 1, textAlign: 'right', fontSize: 11, color: theme.colors.text.primary },
  bookTotal: { flex: 1, textAlign: 'right', fontSize: 11, color: theme.colors.text.secondary },
  mono: { fontFamily: MONO_FONT },
  midPrice: { alignItems: 'center', paddingVertical: 6 },
  midPriceText: { fontSize: 16, fontWeight: '800', fontFamily: MONO_FONT },
  bookSide: { fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, paddingVertical: 3 },
  bookRatio: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  bookRatioLabel: { fontSize: 10, fontWeight: '700', fontFamily: MONO_FONT },
  bookRatioBar: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden', flexDirection: 'row', backgroundColor: theme.colors.border },
  bookRatioSeg: { height: '100%' },
  emptyCard: { alignItems: 'center', padding: 20 },
  emptyText: { fontSize: 12, color: theme.colors.text.secondary, textAlign: 'center' },
}));
