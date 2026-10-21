import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl, Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import WalletUnlock from '@/components/WalletUnlock';
import { httpService } from '@/services/http';
import {
  predictionService,
  PREDICTION_CHAIN_ID,
  type PredictionEvent,
  type PredictionPosition,
  type PredictionOutcome,
  type PredictionState,
  type PredictionOracle,
} from '@/services/prediction';

const SECONDS_PER_DAY = 86400;

/**
 * Predict tab: lists the prediction markets (contract tokens) on the
 * L1-prediction chain, shows the user's YES/NO positions, and drives the
 * contract events (create / split / merge / resolve / dispute / redeem).
 * Trading the YES/collateral or NO/collateral pair reuses the Spot screen once
 * the prediction chain is selected as the active L1 chain.
 */
export default function PredictScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { isUnlocked, publicInfo, getUnlockedWallet } = useWallet();

  const [events, setEvents] = React.useState<PredictionEvent[]>([]);
  const [positions, setPositions] = React.useState<Record<string, PredictionPosition>>({});
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const actionPending = React.useRef(false);
  const loadingRef = React.useRef(false);
  const [states, setStates] = React.useState<Record<string, PredictionState | null>>({});
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [nowSec, setNowSec] = React.useState(Math.floor(Date.now() / 1000));
  const [books, setBooks] = React.useState<Record<string, Awaited<ReturnType<typeof predictionService.fetchOutcomeBook>>>>({});
  const [bookError, setBookError] = React.useState('');
  const [bookLoading, setBookLoading] = React.useState(false);
  const [slippage, setSlippage] = React.useState('0.5');
  const [preview, setPreview] = React.useState<{
    event: PredictionEvent; index: number; side: 'buy' | 'sell'; amount: bigint;
    quote: Awaited<ReturnType<typeof predictionService.quoteOutcome>>;
  } | null>(null);
  const [confirmation, setConfirmation] = React.useState<{
    title: string; detail: string; key: string; submit: () => Promise<string>;
  } | null>(null);

  const [showCreate, setShowCreate] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [question, setQuestion] = React.useState('');
  const [supply, setSupply] = React.useState('1000000');
  const [resolutionDays, setResolutionDays] = React.useState('7');
  const [disputeWindow, setDisputeWindow] = React.useState('300');
  const [autoInvalid, setAutoInvalid] = React.useState('86400');
  const [outcomeNames, setOutcomeNames] = React.useState('YES\nNO');
  const [oracle, setOracle] = React.useState<PredictionOracle>('staked');
  const [committee, setCommittee] = React.useState('');
  const [bond, setBond] = React.useState('1000');
  const [voteWindow, setVoteWindow] = React.useState('300');
  const [collateral, setCollateral] = React.useState('bc');
  const [createError, setCreateError] = React.useState('');

  const [amounts, setAmounts] = React.useState<Record<string, string>>({});

  const unlocked = React.useMemo(() => {
    if (!isUnlocked) return null;
    const w = getUnlockedWallet();
    return w ? { privateKeyHex: w.wallet.privateKey, keyType: w.wallet.keyType as 'PQ' | 'EC' } : null;
  }, [isUnlocked, getUnlockedWallet]);

  const load = React.useCallback(async (isRefresh = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const list = await predictionService.listEvents();
      setEvents(list);
      setError('');
      if (unlocked) {
        const pos = await predictionService.getPositions(unlocked.privateKeyHex, unlocked.keyType);
        const map: Record<string, PredictionPosition> = {};
        for (const p of pos) map[p.event.contractTokenid] = p;
        setPositions(map);
        setStates(Object.fromEntries(pos.map((position) => [position.event.contractTokenid, position.state])));
      } else {
        setPositions({});
        const entries = await Promise.all(list.map(async (event) => [event.contractTokenid,
          await predictionService.getState(event.contractTokenid).catch(() => null)] as const));
        setStates(Object.fromEntries(entries));
      }
    } catch (e) {
      console.error('Error loading prediction markets:', e);
      setStates({});
      setError(e instanceof Error ? e.message : t('predict.actionFailed'));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [unlocked, t]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => {
    const clock = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    const refresh = setInterval(() => load(true), 15000);
    return () => { clearInterval(clock); clearInterval(refresh); };
  }, [load]);

  React.useEffect(() => {
    const event = events.find((item) => item.contractTokenid === expanded);
    if (!event) return;
    let cancelled = false;
    setBooks({});
    setBookError('');
    setBookLoading(true);
    Promise.all(event.outcomes.map(async (outcome) => [outcome,
      await predictionService.fetchOutcomeBook(outcome, event.collateralTokenid)] as const))
      .then((entries) => { if (!cancelled) setBooks(Object.fromEntries(entries)); })
      .catch((cause) => { if (!cancelled) setBookError(cause instanceof Error ? cause.message : t('predict.actionFailed')); })
      .finally(() => { if (!cancelled) setBookLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, events, t]);

  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  React.useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  /**
   * Actions settle asynchronously: the tx lands in one block, the contract
   * event in a later beacon block, and the payout in a later one still. A
   * single load right after the action races that, so keep reloading for a
   * bounded window until the state converges.
   */
  const schedulePoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    let n = 0;
    pollRef.current = setInterval(() => {
      load(true);
      if (++n >= 30) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }, 2000);
  };

  const needUnlock = () => {
    if (!unlocked) { Alert.alert('', t('predict.unlockFirst')); return true; }
    return false;
  };

  const runAction = async (key: string, fn: () => Promise<string>) => {
    if (needUnlock() || actionPending.current) return;
    actionPending.current = true;
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const hash = await fn();
      setConfirmation(null);
      setNotice(`${t('predict.actionDone')}: ${hash.slice(0, 16)}`);
      await load(true);
      schedulePoll();
    } catch (e) {
      console.error('Prediction action failed:', e);
      setError(e instanceof Error ? e.message : t('predict.actionFailed'));
    } finally {
      actionPending.current = false;
      setBusy(null);
    }
  };

  const parseAmount = (id: string): bigint | null => {
    const raw = (amounts[id] ?? '').trim();
    if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n || BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) {
      setError(t('predict.invalidAmount')); return null;
    }
    return BigInt(raw);
  };

  /** Action payload for outcome index: binary shorthand for 2 outcomes, tokenid otherwise. */
  const outcomeValue = (event: PredictionEvent, index: number): string => {
    if (event.outcomes.length === 2) return index === 0 ? 'yes' : 'no';
    return event.outcomes[index];
  };

  /** Human label for outcome index (configured name, binary shorthand, or tokenid prefix). */
  const outcomeLabel = (event: PredictionEvent, index: number): string => {
    const name = event.outcomeNames?.[index];
    if (name) return name;
    if (event.outcomes.length === 2) return t(index === 0 ? 'predict.yes' : 'predict.no');
    return event.outcomes[index].slice(0, 6);
  };

  const onCreate = async () => {
    if (needUnlock() || actionPending.current) return;
    setCreateError('');
    try {
      if (!/^\d+$/.test(supply.trim())) throw new Error(t('predict.errSupply'));
      if (!/^\d+$/.test(bond.trim())) throw new Error(t('predictionWorkflow.invalidBond'));
      const nowSec = Math.floor(Date.now() / 1000);
      const settings = predictionService.validateCreateEvent({
        privateKeyHex: unlocked!.privateKeyHex,
        keyType: unlocked!.keyType,
        question: question.trim(),
        supply: BigInt(supply.trim()),
        collateralTokenid: collateral.trim(),
        resolutionTimeSec: nowSec + Math.round(Number(resolutionDays) * SECONDS_PER_DAY),
        disputeWindowSec: Number(disputeWindow),
        autoInvalidSec: Number(autoInvalid),
        disputeBond: BigInt(bond.trim()),
        committeeAddresses: oracle === 'committee' ? committee.split(/\s+/).filter(Boolean) : [],
        outcomeNames: outcomeNames.split('\n').map((name) => name.trim()).filter(Boolean),
        oracle,
        proposalBond: oracle === 'staked' ? BigInt(bond.trim()) : undefined,
        voteWindowSec: Number(voteWindow),
      });
      actionPending.current = true;
      setCreating(true);
      await predictionService.createEvent(settings);
      setShowCreate(false);
      setQuestion('');
      setNotice(t('predict.created'));
      await load(true);
      schedulePoll();
    } catch (e) {
      console.error('Create market failed:', e);
      const issues = (e as { issues?: { message: string; path: unknown[] }[] })?.issues;
      setCreateError(issues ? issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n')
        : e instanceof Error ? e.message : t('predict.createFailed'));
    } finally {
      actionPending.current = false;
      setCreating(false);
    }
  };

  const openInTrade = () => {
    httpService.setActiveL1ChainId(PREDICTION_CHAIN_ID);
    router.push('/trade' as never);
  };

  const resolvePrompt = (event: PredictionEvent, outcome: PredictionOutcome) => {
    setConfirmation({ title: t('predict.resolveTitle'), key: `resolve-${event.contractTokenid}`,
      detail: `${t('predict.resolveConfirm', { outcome: labelFor(event, outcome) })}\n${t('predictionWorkflow.bond')}: ${event.oracle === 'staked' ? event.proposalBond : 0n}`,
      submit: () =>
            predictionService.resolveEvent({
              privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, outcome,
              bond: event.oracle === 'staked' ? event.proposalBond : undefined,
                }),
              });
  };

  const disputePrompt = (event: PredictionEvent, outcome: PredictionOutcome) => {
    setConfirmation({ title: t('predict.disputeTitle'), key: `dispute-${event.contractTokenid}`,
      detail: `${t('predict.disputeConfirm', { outcome: labelFor(event, outcome) })}\n${t('predictionWorkflow.bond')}: ${event.oracle === 'staked' ? event.proposalBond : event.disputeBond}`,
      submit: () =>
            predictionService.disputeEvent({
              privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, outcome,
              bond: event.oracle === 'staked' ? event.proposalBond : event.disputeBond,
                }),
              });
  };

  const vote = (event: PredictionEvent, outcome: PredictionOutcome) => {
    const bond = parseAmount(event.contractTokenid);
    if (bond === null) return;
    setConfirmation({ title: t('predict.vote'), key: `vote-${event.contractTokenid}`,
      detail: `${labelFor(event, outcome)}\n${t('predictionWorkflow.bond')}: ${bond}`, submit: () =>
      predictionService.voteEvent({
        privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, outcome, bond,
      }),
    });
  };

  /** One-tap market order on an outcome, using the amount field as the size. */
  const marketOrder = async (event: PredictionEvent, index: number, side: 'buy' | 'sell') => {
    const amt = parseAmount(event.contractTokenid);
    if (amt == null || needUnlock() || actionPending.current) return;
    actionPending.current = true;
    setBusy('quote');
    setError('');
    try {
      const quote = await predictionService.quoteOutcome({ side, event, outcomeTokenid: event.outcomes[index], amount: amt });
      if (quote.filled <= 0n) throw new Error(t('predictionWorkflow.noLiquidity'));
      setPreview({ event, index, side, amount: amt, quote });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('predict.actionFailed'));
    } finally {
      actionPending.current = false;
      setBusy(null);
    }
  };

  const labelFor = (event: PredictionEvent, outcome: string) => {
    if (outcome === 'invalid') return t('predictionWorkflow.invalid');
    const index = outcome === 'yes' ? 0 : outcome === 'no' ? 1 : event.outcomes.indexOf(outcome);
    return index >= 0 ? outcomeLabel(event, index) : outcome.slice(0, 12);
  };

  const limitForPreview = () => {
    if (!preview || !/^\d+(\.\d{1,2})?$/.test(slippage)) return null;
    const bps = Math.round(Number(slippage) * 100);
    if (!Number.isSafeInteger(bps) || bps < 0 || bps > 1000) return null;
    return preview.side === 'buy' ? preview.quote.price * BigInt(10000 + bps) / 10000n
      : (preview.quote.price * BigInt(10000 - bps) + 9999n) / 10000n;
  };

  const submitPreview = () => {
    const limitPrice = limitForPreview();
    if (!preview || limitPrice === null || nowSec * 1000 - preview.quote.quotedAt >= 30000) return;
    runAction('trade', async () => {
      const result = await predictionService.marketOrderOutcome({
        ...unlocked!, side: preview.side, event: preview.event, outcomeTokenid: preview.event.outcomes[preview.index],
        amount: preview.quote.filled, limitPrice,
      });
      setPreview(null);
      return result.txHash;
    });
  };

  const renderEvent = (event: PredictionEvent) => {
    const pos = positions[event.contractTokenid];
    const isOpen = expanded === event.contractTokenid;
    const resolveMs = event.resolutionTimeSec * 1000;
    const due = resolveMs > 0 && resolveMs <= Date.now();
    const state = states[event.contractTokenid] ?? null;
    const available = predictionService.getActionAvailability(event, state, nowSec);
    const blocked = !!busy || creating || !state?.initialized || unlocked?.keyType === 'EC';
    const oracleBlocked = (action: 'resolve' | 'dispute' | 'vote', outcome: string) => blocked
      || !!predictionService.getOracleActionError(action, event, state, outcome, publicInfo?.address ?? '', nowSec);
    const deadline = state?.status === 'PENDING' ? state.disputeDeadlineSec : state?.status === 'VOTING' ? state.voteDeadlineSec : undefined;
    return (
      <View key={event.contractTokenid} style={s.card} testID={`predict-event-${event.contractTokenid.slice(0, 8)}`}>
        <TouchableOpacity onPress={() => setExpanded(isOpen ? null : event.contractTokenid)}>
          <Text style={s.question}>{event.question || event.contractTokenid.slice(0, 16)}</Text>
          <View style={s.metaRow}>
            <Text style={s.meta}>{event.collateralTokenid === 'bc' ? 'BIG' : event.collateralTokenid.slice(0, 12)} · {event.outcomes.length}×</Text>
            <Text style={[s.meta, due ? s.metaDue : null]}>
              {event.resolutionTimeSec > 0
                ? `${t(due ? 'predict.closed' : 'predict.opensIn')} ${new Date(resolveMs).toISOString().slice(0, 10)}`
                : ''}
            </Text>
          </View>
          <Text style={s.status} testID="predict-status">
            {state?.initialized ? t(`predictionWorkflow.status.${state.status}`)
              : t(state ? 'predictionWorkflow.initializing' : 'predictionWorkflow.stateUnavailable')}
            {state?.outcome ? `: ${labelFor(event, state.outcome)}` : ''}
          </Text>
          {deadline ? <Text style={s.meta} testID="predict-deadline">
            {t(state?.status === 'PENDING' ? 'predictionWorkflow.challengeDeadline' : 'predictionWorkflow.voteDeadline')}: {new Date(deadline * 1000).toLocaleString()}
            {nowSec >= deadline ? ` (${t('predictionWorkflow.awaitingCheckpoint')})` : ''}
          </Text> : null}
          {pos && event.outcomes.some((o) => (pos.shares[o] ?? 0n) > 0n) && (
            <Text style={s.position} testID="predict-position">
              {t('predict.yourPosition')}: {event.outcomes
                .map((o, i) => `${outcomeLabel(event, i)} ${(pos.shares[o] ?? 0n).toString()}`)
                .join(' · ')}
            </Text>
          )}
        </TouchableOpacity>

        {isOpen && isUnlocked && (
          <View style={s.detail}>
            <Text style={s.meta}>{t(`predictionWorkflow.${event.oracle}`)} · {t('predictionWorkflow.bond')}: {(event.oracle === 'staked' ? event.proposalBond : event.disputeBond).toString()}</Text>
            {state?.proposalOutcome ? <Text style={s.meta}>{t('predictionWorkflow.proposed')}: {labelFor(event, state.proposalOutcome)}</Text> : null}
            {state?.challengeOutcome ? <Text style={s.meta}>{t('predictionWorkflow.challenged')}: {labelFor(event, state.challengeOutcome)}</Text> : null}
            {unlocked?.keyType === 'EC' ? <Text style={s.errorText}>{t('predictionWorkflow.pqRequired')}</Text> : null}
            <View style={s.actionRow}>
              <TouchableOpacity accessibilityRole="button" style={[s.actionBtn, (blocked || !available.trade) && s.disabled]} disabled={blocked || !available.trade} onPress={openInTrade} testID="predict-trade">
                <Text style={s.actionText}>{t('predict.trade')}</Text>
              </TouchableOpacity>
              {pos && pos.redeemable > 0n && (
                <TouchableOpacity
                  accessibilityRole="button"
                  style={[s.actionBtn, (blocked || !available.redeem) && s.disabled]}
                  disabled={blocked || !available.redeem}
                  onPress={() => runAction(`redeem-${event.contractTokenid}`, () =>
                    predictionService.redeemShares({
                      privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, shares: pos.shares,
                    }))}
                  testID="predict-redeem">
                  <Text style={s.actionText}>{t('predict.redeem')} {pos.redeemable.toString()}</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={s.amountRow}>
              <TextInput
                style={s.amountInput}
                value={amounts[event.contractTokenid] ?? ''}
                onChangeText={(v) => setAmounts((prev) => ({ ...prev, [event.contractTokenid]: v }))}
                keyboardType="numeric"
                placeholder={t('predict.splitAmount')}
                placeholderTextColor={s.placeholder.color}
                testID="predict-amount"
              />
              <TouchableOpacity
                accessibilityRole="button"
                style={[s.miniBtn, (blocked || !available.split) && s.disabled]}
                disabled={blocked || !available.split}
                onPress={() => {
                  const amt = parseAmount(event.contractTokenid);
                  if (amt == null) return;
                  runAction(`split-${event.contractTokenid}`, () =>
                    predictionService.splitShares({
                      privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType,
                      contractTokenid: event.contractTokenid, collateralTokenid: event.collateralTokenid, amount: amt,
                    }));
                }}
                testID="predict-split">
                <Text style={s.miniText}>{t('predict.split')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                style={[s.miniBtn, (blocked || !available.merge) && s.disabled]}
                disabled={blocked || !available.merge}
                onPress={() => {
                  const amt = parseAmount(event.contractTokenid);
                  if (amt == null) return;
                  runAction(`merge-${event.contractTokenid}`, () =>
                    predictionService.mergeShares({
                      privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, amount: amt,
                    }));
                }}
                testID="predict-merge">
                <Text style={s.miniText}>{t('predict.merge')}</Text>
              </TouchableOpacity>
            </View>

            <View style={s.actionRow}>
              {event.outcomes.map((o, i) => (
                <TouchableOpacity accessibilityRole="button" key={`resolve-${o}`} style={[s.miniBtn, oracleBlocked('resolve', o) && s.disabled]}
                  disabled={oracleBlocked('resolve', o)}
                  onPress={() => resolvePrompt(event, outcomeValue(event, i))}
                  testID={`predict-resolve-${i}`}>
                  <Text style={s.miniText}>{t('predict.resolve')} {outcomeLabel(event, i)}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity accessibilityRole="button" style={[s.miniBtn, oracleBlocked('resolve', 'invalid') && s.disabled]} disabled={oracleBlocked('resolve', 'invalid')} onPress={() => resolvePrompt(event, 'invalid')} testID="predict-resolve-invalid">
                <Text style={s.miniText}>{t('predict.resolveInvalid')}</Text>
              </TouchableOpacity>
            </View>
            <View style={s.actionRow}>
              {event.outcomes.map((o, i) => (
                <TouchableOpacity accessibilityRole="button" key={`dispute-${o}`} style={[s.miniBtn, oracleBlocked('dispute', o) && s.disabled]}
                  disabled={oracleBlocked('dispute', o)}
                  onPress={() => disputePrompt(event, outcomeValue(event, i))}
                  testID={`predict-dispute-${i}`}>
                  <Text style={s.miniText}>{t('predict.dispute')} {outcomeLabel(event, i)}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity accessibilityRole="button" style={[s.miniBtn, oracleBlocked('dispute', 'invalid') && s.disabled]} disabled={oracleBlocked('dispute', 'invalid')}
                onPress={() => disputePrompt(event, 'invalid')} testID="predict-dispute-invalid">
                <Text style={s.miniText}>{t('predict.dispute')} {t('predictionWorkflow.invalid')}</Text>
              </TouchableOpacity>
            </View>

            {bookLoading ? <ActivityIndicator color={theme.colors.primary} /> : null}
            {bookError ? <Text style={s.errorText}>{bookError}</Text> : null}
            {event.outcomes.map((outcome, index) => {
              const book = books[outcome];
              if (!book) return null;
              return <View key={outcome} style={s.bookRow} testID={`predict-book-${index}`}>
                <Text style={s.bookLabel}>{outcomeLabel(event, index)}</Text>
                <Text style={s.meta}>{t('predictionWorkflow.bid')}: {book.bids[0]?.price.toString() ?? '-'} · {t('predictionWorkflow.ask')}: {book.asks[0]?.price.toString() ?? '-'}</Text>
                <Text style={s.meta}>{t('predictionWorkflow.buyLiquidity')}: {book.asks.reduce((total, level) => total + level.amount, 0n).toString()} · {t('predictionWorkflow.sellLiquidity')}: {book.bids.reduce((total, level) => total + level.amount, 0n).toString()}</Text>
              </View>;
            })}
            <View style={s.actionRow}>
              {event.outcomes.map((o, i) => (
                <React.Fragment key={`mkt-${o}`}>
                  <TouchableOpacity accessibilityRole="button" style={[s.miniBtn, (blocked || !available.trade) && s.disabled]} disabled={blocked || !available.trade}
                    onPress={() => marketOrder(event, i, 'buy')}
                    testID={`predict-buy-${i}`}>
                    <Text style={s.miniText}>{t('order.buy')} {outcomeLabel(event, i)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity accessibilityRole="button" style={[s.miniBtn, (blocked || !available.trade) && s.disabled]} disabled={blocked || !available.trade}
                    onPress={() => marketOrder(event, i, 'sell')}
                    testID={`predict-sell-${i}`}>
                    <Text style={s.miniText}>{t('order.sell')} {outcomeLabel(event, i)}</Text>
                  </TouchableOpacity>
                </React.Fragment>
              ))}
            </View>

            {event.oracle === 'staked' && (
              <View style={s.actionRow}>
                {event.outcomes.map((o, i) => (
                  <TouchableOpacity accessibilityRole="button" key={`vote-${o}`} style={[s.miniBtn, oracleBlocked('vote', o) && s.disabled]} disabled={oracleBlocked('vote', o)}
                    onPress={() => vote(event, outcomeValue(event, i))}
                    testID={`predict-vote-${i}`}>
                    <Text style={s.miniText}>{t('predict.vote')} {outcomeLabel(event, i)}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity accessibilityRole="button" style={[s.miniBtn, oracleBlocked('vote', 'invalid') && s.disabled]} disabled={oracleBlocked('vote', 'invalid')}
                  onPress={() => vote(event, 'invalid')} testID="predict-vote-invalid">
                  <Text style={s.miniText}>{t('predict.vote')} {t('predictionWorkflow.invalid')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={s.container} testID="predict-screen">
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}>
        <View style={s.headerRow}>
          <View style={s.headerTitle}>
            <Text style={s.title}>{t('predict.title')}</Text>
            <Text style={s.subtitle}>{t('predict.subtitle')}</Text>
          </View>
          <TouchableOpacity accessibilityLabel={t('order.refresh')} {...{ title: t('order.refresh') }} style={s.refreshBtn} onPress={() => load(true)} disabled={refreshing} testID="predict-refresh">
            <Ionicons name="refresh-outline" size={20} color={theme.colors.text.primary} />
          </TouchableOpacity>
          <TouchableOpacity style={[s.createBtn, !!busy && s.disabled]} disabled={!!busy} onPress={() => { setCreateError(''); setShowCreate(true); }} testID="predict-create">
            <Text style={s.createBtnText}>{t('predict.create')}</Text>
          </TouchableOpacity>
        </View>
        {error ? <Text style={s.errorText} accessibilityRole="alert" testID="predict-error">{error}</Text> : null}
        {notice ? <Text style={s.position} testID="predict-notice">{notice}</Text> : null}

        {!isUnlocked ? (
          <WalletUnlock fullScreen={false} subtitle={t('predict.unlockFirst')} testID="predict-unlock" />
        ) : null}

        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.primary} style={{ padding: 24 }} testID="predict-loading" />
        ) : events.length === 0 ? (
          <View style={s.emptyCard} testID="predict-empty">
            <Text style={s.emptyTitle}>{t('predict.empty')}</Text>
            <Text style={s.emptySub}>{t('predict.emptySub')}</Text>
          </View>
        ) : (
          events.map(renderEvent)
        )}
      </ScrollView>

      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => { if (!creating) setShowCreate(false); }}>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.modalTitle}>{t('predict.createTitle')}</Text>
            <TextInput style={s.input} value={question} onChangeText={setQuestion}
              placeholder={t('predict.fieldQuestionPh')} placeholderTextColor={s.placeholder.color}
              testID="predict-question" />
            <Text style={s.fieldLabel}>{t('predictionWorkflow.outcomes')}</Text>
            <TextInput style={[s.input, s.multiline]} value={outcomeNames} onChangeText={setOutcomeNames} multiline testID="predict-outcomes" />
            <Text style={s.fieldLabel}>{t('predictionWorkflow.collateral')}</Text>
            <TextInput style={s.input} value={collateral} onChangeText={setCollateral} autoCapitalize="none" testID="predict-collateral" />
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldSupply')}</Text>
              <TextInput style={s.fieldInput} value={supply} onChangeText={setSupply} keyboardType="numeric" testID="predict-supply" />
            </View>
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldResolutionDays')}</Text>
              <TextInput style={s.fieldInput} value={resolutionDays} onChangeText={setResolutionDays} keyboardType="numeric" testID="predict-resolution-days" />
            </View>
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldDisputeWindow')}</Text>
              <TextInput style={s.fieldInput} value={disputeWindow} onChangeText={setDisputeWindow} keyboardType="numeric" testID="predict-dispute-window" />
            </View>
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldAutoInvalid')}</Text>
              <TextInput style={s.fieldInput} value={autoInvalid} onChangeText={setAutoInvalid} keyboardType="numeric" testID="predict-auto-invalid" />
            </View>
            <View style={s.actionRow} accessibilityRole="radiogroup">
              {(['staked', 'committee'] as const).map((mode) => <TouchableOpacity key={mode} accessibilityRole="radio"
                accessibilityState={{ checked: oracle === mode }} style={[s.miniBtn, oracle === mode && s.selected]}
                onPress={() => setOracle(mode)} testID={`predict-oracle-${mode}`}>
                <Text style={s.miniText}>{t(`predictionWorkflow.${mode}`)}</Text>
              </TouchableOpacity>)}
            </View>
            {oracle === 'committee' ? <>
              <Text style={s.fieldLabel}>{t('predictionWorkflow.committeeAddresses')}</Text>
              <TextInput style={[s.input, s.multiline]} multiline value={committee} onChangeText={setCommittee} autoCapitalize="none" testID="predict-committee" />
            </> : null}
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predictionWorkflow.bond')}</Text>
              <TextInput style={s.fieldInput} value={bond} onChangeText={setBond} keyboardType="numeric" testID="predict-bond" />
            </View>
            {oracle === 'staked' ? <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predictionWorkflow.voteWindow')}</Text>
              <TextInput style={s.fieldInput} value={voteWindow} onChangeText={setVoteWindow} keyboardType="numeric" testID="predict-vote-window" />
            </View> : null}
            {createError ? <Text style={s.errorText} accessibilityRole="alert" testID="predict-create-error">{createError}</Text> : null}
            {creating && <ActivityIndicator color={theme.colors.primary} />}
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowCreate(false)} disabled={creating} testID="predict-create-cancel">
                <Text style={s.modalCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalOk} onPress={onCreate} disabled={creating} testID="predict-create-submit">
                <Text style={s.modalOkText}>{creating ? t('predict.btnCreating') : t('predict.create')}</Text>
              </TouchableOpacity>
            </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal visible={!!preview} transparent animationType="fade" onRequestClose={() => { if (!busy) setPreview(null); }}>
        <View style={s.modalBackdrop}><View style={s.modalCard}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={s.modalTitle}>{t('predictionWorkflow.orderPreview')}</Text>
            {preview ? <>
              <Text style={s.question}>{t(`order.${preview.side}`)} {outcomeLabel(preview.event, preview.index)}</Text>
              <Text style={s.position} testID="predict-quote-fill">{t('predictionWorkflow.estimatedFill')}: {preview.quote.filled.toString()} / {preview.amount.toString()}</Text>
              <Text style={s.meta}>{t('predictionWorkflow.crossingPrice')}: {preview.quote.price.toString()}</Text>
              <Text style={s.meta}>{t('predictionWorkflow.quoteUnits')}: {preview.event.collateralTokenid === 'bc' ? 'BIG' : preview.event.collateralTokenid}</Text>
              <View style={s.fieldRow}>
                <Text style={s.fieldLabel}>{t('predictionWorkflow.slippage')}</Text>
                <TextInput style={s.fieldInput} value={slippage} onChangeText={setSlippage} keyboardType="decimal-pad" testID="predict-slippage" />
              </View>
              <Text style={s.meta} testID="predict-price-limit">{t('predictionWorkflow.priceLimit')}: {limitForPreview()?.toString() ?? t('predict.invalidAmount')}</Text>
              <Text style={s.meta}>{t('predictionWorkflow.limitOrderRisk')}</Text>
              {nowSec * 1000 - preview.quote.quotedAt >= 30000 ? <Text style={s.errorText}>{t('predictionWorkflow.quoteExpired')}</Text> : null}
              {error ? <Text style={s.errorText} accessibilityRole="alert">{error}</Text> : null}
              <View style={s.modalActions}>
                <TouchableOpacity style={s.modalCancel} disabled={!!busy} onPress={() => setPreview(null)} testID="predict-quote-cancel"><Text style={s.modalCancelText}>{t('common.cancel')}</Text></TouchableOpacity>
                <TouchableOpacity accessibilityRole="button" style={[s.modalOk, (!!busy || limitForPreview() === null || nowSec * 1000 - preview.quote.quotedAt >= 30000) && s.disabled]}
                  disabled={!!busy || limitForPreview() === null || nowSec * 1000 - preview.quote.quotedAt >= 30000}
                  onPress={submitPreview} testID="predict-quote-submit"><Text style={s.modalOkText}>{t('predictionWorkflow.submitOrder')}</Text></TouchableOpacity>
              </View>
            </> : null}
          </ScrollView>
        </View></View>
      </Modal>
      <Modal visible={!!confirmation} transparent animationType="fade" onRequestClose={() => { if (!busy) setConfirmation(null); }}>
        <View style={s.modalBackdrop}><View style={s.modalCard}>
          <Text style={s.modalTitle}>{confirmation?.title}</Text>
          <Text style={s.question}>{confirmation?.detail}</Text>
          {error ? <Text style={s.errorText} accessibilityRole="alert">{error}</Text> : null}
          <View style={s.modalActions}>
            <TouchableOpacity style={s.modalCancel} disabled={!!busy} onPress={() => setConfirmation(null)} testID="predict-action-cancel"><Text style={s.modalCancelText}>{t('common.cancel')}</Text></TouchableOpacity>
            <TouchableOpacity style={[s.modalOk, !!busy && s.disabled]} disabled={!!busy} onPress={() => confirmation && runAction(confirmation.key, confirmation.submit)} testID="predict-action-confirm"><Text style={s.modalOkText}>{t('predictionWorkflow.confirm')}</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  headerTitle: { flexGrow: 1, flexShrink: 1, minWidth: 150 },
  refreshBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  selected: { borderColor: theme.colors.primary, borderWidth: 2 },
  status: { fontSize: 12, fontWeight: '700', color: theme.colors.text.primary, marginVertical: 6 },
  errorText: { fontSize: 12, color: theme.colors.negative, marginVertical: 8, flexShrink: 1 },
  bookRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border, marginBottom: 8 },
  bookLabel: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  title: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  subtitle: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 2 },
  createBtn: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  createBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 32, alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center' },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: theme.colors.border },
  question: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 6, gap: 8 },
  meta: { fontSize: 11, color: theme.colors.text.secondary, flexShrink: 1 },
  metaDue: { color: theme.colors.negative, fontWeight: '700' },
  position: { fontSize: 12, color: theme.colors.primary, marginTop: 6, fontWeight: '600' },
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  actionBtn: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  actionText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  miniBtn: { backgroundColor: theme.colors.groupped.background, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: theme.colors.border },
  miniText: { color: theme.colors.text.primary, fontWeight: '600', fontSize: 12 },
  amountRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' },
  amountInput: { flexGrow: 1, flexShrink: 1, minWidth: 100, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 560, maxHeight: '90%', alignSelf: 'center', backgroundColor: theme.colors.groupped.surface, borderRadius: 14, padding: 20, borderWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 17, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14, marginBottom: 10 },
  fieldRow: { flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  fieldLabel: { fontSize: 13, color: theme.colors.text.secondary, flex: 1 },
  fieldInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 8, fontSize: 14, width: 120, textAlign: 'right' },
  creatingHint: { fontSize: 12, color: theme.colors.text.secondary, marginBottom: 8 },
  modalActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  modalCancel: { paddingHorizontal: 16, paddingVertical: 10 },
  modalCancelText: { color: theme.colors.text.secondary, fontWeight: '600' },
  modalOk: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 10 },
  modalOkText: { color: '#FFFFFF', fontWeight: '700' },
}));
