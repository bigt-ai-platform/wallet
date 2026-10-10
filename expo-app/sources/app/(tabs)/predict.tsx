import * as React from 'react';
import {
  View, Text, ScrollView, ActivityIndicator, TouchableOpacity,
  TextInput, Alert, RefreshControl, Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWallet } from '@/state/wallet';
import { httpService } from '@/services/http';
import {
  predictionService,
  PREDICTION_CHAIN_ID,
  type PredictionEvent,
  type PredictionPosition,
  type PredictionOutcome,
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

  const [showCreate, setShowCreate] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [question, setQuestion] = React.useState('');
  const [supply, setSupply] = React.useState('1000000');
  const [resolutionDays, setResolutionDays] = React.useState('7');
  const [disputeWindow, setDisputeWindow] = React.useState('300');
  const [autoInvalid, setAutoInvalid] = React.useState('86400');

  const [amounts, setAmounts] = React.useState<Record<string, string>>({});

  const unlocked = React.useMemo(() => {
    if (!isUnlocked) return null;
    const w = getUnlockedWallet();
    return w ? { privateKeyHex: w.wallet.privateKey, keyType: w.wallet.keyType as 'PQ' | 'EC' } : null;
  }, [isUnlocked, getUnlockedWallet]);

  const load = React.useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const list = await predictionService.listEvents();
      setEvents(list);
      if (unlocked) {
        const pos = await predictionService.getPositions(unlocked.privateKeyHex, unlocked.keyType);
        const map: Record<string, PredictionPosition> = {};
        for (const p of pos) map[p.event.contractTokenid] = p;
        setPositions(map);
      }
    } catch (e) {
      console.error('Error loading prediction markets:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [unlocked]);

  React.useEffect(() => { load(); }, [load]);

  const needUnlock = () => {
    if (!unlocked) { Alert.alert('', t('predict.unlockFirst')); return true; }
    return false;
  };

  const runAction = async (key: string, fn: () => Promise<string>) => {
    if (needUnlock()) return;
    setBusy(key);
    try {
      await fn();
      Alert.alert('', t('predict.actionDone'));
      await load(true);
    } catch (e) {
      console.error('Prediction action failed:', e);
      Alert.alert('', t('predict.actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const parseAmount = (id: string): bigint | null => {
    const raw = (amounts[id] ?? '').trim();
    if (!/^\d+$/.test(raw) || raw === '0') { Alert.alert('', t('predict.invalidAmount')); return null; }
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
    if (needUnlock()) return;
    if (!question.trim()) { Alert.alert('', t('predict.errQuestion')); return; }
    const s = BigInt(supply.trim() || '0');
    if (s <= 0n) { Alert.alert('', t('predict.errSupply')); return; }
    setCreating(true);
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      await predictionService.createEvent({
        privateKeyHex: unlocked!.privateKeyHex,
        keyType: unlocked!.keyType,
        question: question.trim(),
        supply: s,
        collateralTokenid: 'bc',
        resolutionTimeSec: nowSec + Number(resolutionDays || '7') * SECONDS_PER_DAY,
        disputeWindowSec: Number(disputeWindow || '300'),
        autoInvalidSec: Number(autoInvalid || '86400'),
        disputeBond: 1000n,
        committeeAddresses: [],
        oracle: 'staked',
        proposalBond: 1000n,
        voteWindowSec: Number(disputeWindow || '300'),
      });
      setShowCreate(false);
      setQuestion('');
      Alert.alert(t('predict.created'), t('predict.createdDesc', { supply: s.toString() }));
      await load(true);
    } catch (e) {
      console.error('Create market failed:', e);
      Alert.alert('', t('predict.createFailed'));
    } finally {
      setCreating(false);
    }
  };

  const openInTrade = () => {
    httpService.setActiveL1ChainId(PREDICTION_CHAIN_ID);
    router.push('/trade' as never);
  };

  const resolvePrompt = (event: PredictionEvent, outcome: PredictionOutcome) => {
    Alert.alert(t('predict.resolveTitle'),
      t('predict.resolveConfirm', { outcome: outcome.toUpperCase() }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('predict.resolve'),
          onPress: () => runAction(`resolve-${event.contractTokenid}`, () =>
            predictionService.resolveEvent({
              privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, outcome,
              bond: event.oracle === 'staked' ? event.proposalBond : undefined,
            })),
        },
      ]);
  };

  const disputePrompt = (event: PredictionEvent, outcome: PredictionOutcome) => {
    Alert.alert(t('predict.disputeTitle'),
      t('predict.disputeConfirm', { outcome: outcome.toUpperCase() }), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('predict.dispute'),
          onPress: () => runAction(`dispute-${event.contractTokenid}`, () =>
            predictionService.disputeEvent({
              privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, outcome,
              bond: event.oracle === 'staked' ? event.proposalBond : undefined,
            })),
        },
      ]);
  };

  const vote = (event: PredictionEvent, outcome: PredictionOutcome) => {
    const bond = parseAmount(event.contractTokenid) ?? event.proposalBond;
    runAction(`vote-${event.contractTokenid}`, () =>
      predictionService.voteEvent({
        privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, outcome, bond,
      }));
  };

  /** One-tap market order on an outcome, using the amount field as the size. */
  const marketOrder = (event: PredictionEvent, index: number, side: 'buy' | 'sell') => {
    const amt = parseAmount(event.contractTokenid);
    if (amt == null) return;
    runAction(`mkt-${side}-${event.contractTokenid}`, () =>
      predictionService.marketOrderOutcome({
        side, privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType,
        event, outcomeTokenid: event.outcomes[index], amount: amt,
      }).then((r) => r.txHash));
  };

  const renderEvent = (event: PredictionEvent) => {
    const pos = positions[event.contractTokenid];
    const isOpen = expanded === event.contractTokenid;
    const resolveMs = event.resolutionTimeSec * 1000;
    const due = resolveMs > 0 && resolveMs <= Date.now();
    return (
      <View key={event.contractTokenid} style={s.card} testID={`predict-event-${event.contractTokenid.slice(0, 8)}`}>
        <TouchableOpacity onPress={() => setExpanded(isOpen ? null : event.contractTokenid)}>
          <Text style={s.question}>{event.question || event.contractTokenid.slice(0, 16)}</Text>
          <View style={s.metaRow}>
            <Text style={s.meta}>{event.collateralTokenid.toUpperCase()} · {event.outcomes.length}×</Text>
            <Text style={[s.meta, due ? s.metaDue : null]}>
              {event.resolutionTimeSec > 0
                ? `${t(due ? 'predict.closed' : 'predict.opensIn')} ${new Date(resolveMs).toISOString().slice(0, 10)}`
                : ''}
            </Text>
          </View>
          {pos && event.outcomes.some((o) => (pos.shares[o] ?? 0n) > 0n) && (
            <Text style={s.position} testID="predict-position">
              {t('predict.yourPosition')}: {event.outcomes
                .map((o, i) => `${outcomeLabel(event, i)} ${(pos.shares[o] ?? 0n).toString()}`)
                .join(' · ')}
            </Text>
          )}
        </TouchableOpacity>

        {isOpen && (
          <View style={s.detail}>
            <View style={s.actionRow}>
              <TouchableOpacity style={s.actionBtn} onPress={openInTrade} testID="predict-trade">
                <Text style={s.actionText}>{t('predict.trade')}</Text>
              </TouchableOpacity>
              {pos && pos.redeemable > 0n && (
                <TouchableOpacity
                  style={s.actionBtn}
                  disabled={busy === `redeem-${event.contractTokenid}`}
                  onPress={() => runAction(`redeem-${event.contractTokenid}`, () =>
                    predictionService.redeemShares({
                      privateKeyHex: unlocked!.privateKeyHex, keyType: unlocked!.keyType, event, shares: pos.shares,
                    }))}
                  testID="predict-redeem">
                  <Text style={s.actionText}>{t('predict.redeem')}</Text>
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
                style={s.miniBtn}
                disabled={busy === `split-${event.contractTokenid}`}
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
                style={s.miniBtn}
                disabled={busy === `merge-${event.contractTokenid}`}
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
                <TouchableOpacity key={`resolve-${o}`} style={s.miniBtn}
                  onPress={() => resolvePrompt(event, outcomeValue(event, i))}
                  testID={`predict-resolve-${i}`}>
                  <Text style={s.miniText}>{t('predict.resolve')} {outcomeLabel(event, i)}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={s.miniBtn} onPress={() => resolvePrompt(event, 'invalid')} testID="predict-resolve-invalid">
                <Text style={s.miniText}>{t('predict.resolveInvalid')}</Text>
              </TouchableOpacity>
            </View>
            <View style={s.actionRow}>
              {event.outcomes.map((o, i) => (
                <TouchableOpacity key={`dispute-${o}`} style={s.miniBtn}
                  onPress={() => disputePrompt(event, outcomeValue(event, i))}
                  testID={`predict-dispute-${i}`}>
                  <Text style={s.miniText}>{t('predict.dispute')} {outcomeLabel(event, i)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={s.actionRow}>
              {event.outcomes.map((o, i) => (
                <React.Fragment key={`mkt-${o}`}>
                  <TouchableOpacity style={s.miniBtn}
                    onPress={() => marketOrder(event, i, 'buy')}
                    testID={`predict-buy-${i}`}>
                    <Text style={s.miniText}>{t('order.buy')} {outcomeLabel(event, i)}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.miniBtn}
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
                  <TouchableOpacity key={`vote-${o}`} style={s.miniBtn}
                    onPress={() => vote(event, outcomeValue(event, i))}
                    testID={`predict-vote-${i}`}>
                    <Text style={s.miniText}>{t('predict.vote')} {outcomeLabel(event, i)}</Text>
                  </TouchableOpacity>
                ))}
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
          <View>
            <Text style={s.title}>{t('predict.title')}</Text>
            <Text style={s.subtitle}>{t('predict.subtitle')}</Text>
          </View>
          <TouchableOpacity style={s.createBtn} onPress={() => setShowCreate(true)} testID="predict-create">
            <Text style={s.createBtnText}>{t('predict.create')}</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <ActivityIndicator size="large" color={theme.colors.primary} style={{ padding: 24 }} />
        ) : events.length === 0 ? (
          <View style={s.emptyCard}>
            <Text style={s.emptyTitle}>{t('predict.empty')}</Text>
            <Text style={s.emptySub}>{t('predict.emptySub')}</Text>
          </View>
        ) : (
          events.map(renderEvent)
        )}
      </ScrollView>

      <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>{t('predict.createTitle')}</Text>
            <TextInput style={s.input} value={question} onChangeText={setQuestion}
              placeholder={t('predict.fieldQuestionPh')} placeholderTextColor={s.placeholder.color}
              testID="predict-question" />
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldSupply')}</Text>
              <TextInput style={s.fieldInput} value={supply} onChangeText={setSupply} keyboardType="numeric" />
            </View>
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldResolutionDays')}</Text>
              <TextInput style={s.fieldInput} value={resolutionDays} onChangeText={setResolutionDays} keyboardType="numeric" />
            </View>
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldDisputeWindow')}</Text>
              <TextInput style={s.fieldInput} value={disputeWindow} onChangeText={setDisputeWindow} keyboardType="numeric" />
            </View>
            <View style={s.fieldRow}>
              <Text style={s.fieldLabel}>{t('predict.fieldAutoInvalid')}</Text>
              <TextInput style={s.fieldInput} value={autoInvalid} onChangeText={setAutoInvalid} keyboardType="numeric" />
            </View>
            {creating && <Text style={s.creatingHint}>{t('predict.creatingHint')}</Text>}
            <View style={s.modalActions}>
              <TouchableOpacity style={s.modalCancel} onPress={() => setShowCreate(false)} disabled={creating}>
                <Text style={s.modalCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.modalOk} onPress={onCreate} disabled={creating} testID="predict-create-submit">
                <Text style={s.modalOkText}>{creating ? t('predict.btnCreating') : t('predict.create')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary },
  subtitle: { fontSize: 12, color: theme.colors.text.secondary, marginTop: 2 },
  createBtn: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  createBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  emptyCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 12, padding: 32, alignItems: 'center', borderWidth: 1, borderColor: theme.colors.border },
  emptyTitle: { fontSize: 15, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 6 },
  emptySub: { fontSize: 13, color: theme.colors.text.secondary, textAlign: 'center' },
  card: { backgroundColor: theme.colors.groupped.surface, borderRadius: 10, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: theme.colors.border },
  question: { fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, gap: 8 },
  meta: { fontSize: 11, color: theme.colors.text.secondary },
  metaDue: { color: theme.colors.negative, fontWeight: '700' },
  position: { fontSize: 12, color: theme.colors.primary, marginTop: 6, fontWeight: '600' },
  detail: { marginTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  actionBtn: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  actionText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  miniBtn: { backgroundColor: theme.colors.groupped.background, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: theme.colors.border },
  miniText: { color: theme.colors.text.primary, fontWeight: '600', fontSize: 12 },
  amountRow: { flexDirection: 'row', gap: 8, marginBottom: 8, alignItems: 'center' },
  amountInput: { flex: 1, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14 },
  placeholder: { color: theme.colors.text.secondary },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalCard: { backgroundColor: theme.colors.groupped.surface, borderRadius: 14, padding: 20, borderWidth: 1, borderColor: theme.colors.border },
  modalTitle: { fontSize: 17, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 10, fontSize: 14, marginBottom: 10 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  fieldLabel: { fontSize: 13, color: theme.colors.text.secondary, flex: 1 },
  fieldInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.background, color: theme.colors.text.primary, padding: 8, fontSize: 14, width: 120, textAlign: 'right' },
  creatingHint: { fontSize: 12, color: theme.colors.text.secondary, marginBottom: 8 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 8 },
  modalCancel: { paddingHorizontal: 16, paddingVertical: 10 },
  modalCancelText: { color: theme.colors.text.secondary, fontWeight: '600' },
  modalOk: { backgroundColor: theme.colors.primary, borderRadius: 8, paddingHorizontal: 18, paddingVertical: 10 },
  modalOkText: { color: '#FFFFFF', fontWeight: '700' },
}));
