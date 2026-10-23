import * as React from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  createPairing, listMyPairings, revokePairing, deviceRead, submitVerdict,
  type P2pAutoReleasePolicy, type P2pIdentity, type P2pPairing, type P2pDeviceReadResult, type P2pSwap,
} from '@/services/p2p';
import { deviceReadMode } from '@/lib/p2pDeviceRead';

/**
 * "Verify with my phone" (docs/p2p.md §12): pair the party's own phone (the
 * Mobile Agent app) once, have the engine read the matching entry in that
 * party's own rail app, then sign and submit the verdict. Only the caller's own
 * pairing and own side are ever used — the buyer reads the sending ledger, the
 * seller the receiving one; the engine can neither pick the other side nor
 * fabricate the evidence (the wallet signs the verdict).
 */
export default function PhoneVerifyCard({ id, swap, autoReleaseOn, onStatus, onClose, onDone }: {
  id: P2pIdentity; swap: P2pSwap; autoReleaseOn: P2pAutoReleasePolicy;
  onStatus: (s: string) => void; onClose: () => void; onDone: () => void;
}) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();

  const [pairings, setPairings] = React.useState<P2pPairing[]>([]);
  const [endpoint, setEndpoint] = React.useState('');
  const [token, setToken] = React.useState('');
  const [deviceId, setDeviceId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<P2pDeviceReadResult | null>(null);

  const load = React.useCallback(() => {
    listMyPairings(id).then(setPairings).catch(() => {});
  }, [id]);

  React.useEffect(() => { load(); }, [load]);

  const active = pairings.find((p) => !p.revoked && (p.swapId === null || p.swapId === swap.swapId));
  const side = swap.sellerDid === id.did ? 'seller' : 'buyer';
  const mode = deviceReadMode(swap.wantRail, side);

  async function pair() {
    if (busy || !endpoint.trim() || !token.trim()) return;
    setBusy(true);
    try {
      await createPairing(id, {
        endpoint: endpoint.trim(),
        token: token.trim(),
        ...(deviceId.trim() ? { deviceId: deviceId.trim() } : {}),
        swapId: swap.swapId,
      });
      setToken('');
      onStatus(t('p2pdev.paired'));
      load();
    } catch (e) {
      onStatus(t('p2pdev.pairFailed', { e: msg(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(pairingId: string) {
    setBusy(true);
    try {
      await revokePairing(id, pairingId);
      onStatus(t('p2pdev.revoked'));
      load();
    } catch (e) {
      onStatus(msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function read() {
    if (busy || !active) { onStatus(t('p2pdev.needPair')); return; }
    if (!mode) { onStatus(t('p2phelp.wechatBuyer')); return; }
    setBusy(true);
    setResult(null);
    try {
      const r = await deviceRead(id, swap.swapId, { pairingId: active.pairingId, via: mode });
      setResult(r);
      if (!r.check.ok) onStatus(t('p2pdev.mismatch', { e: r.check.error ?? '' }));
    } catch (e) {
      onStatus(t('p2pdev.readFailed', { e: msg(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (busy || !result) return;
    setBusy(true);
    try {
      await submitVerdict(id, swap.swapId, result.verdict);
      onStatus(t('p2pdev.submitted'));
      onDone();
    } catch (e) {
      onStatus(t('p2pdev.submitFailed', { e: msg(e) }));
    } finally {
      setBusy(false);
    }
  }

  const entry = result?.entry ?? null;
  const inputStyle = [s.input, { color: theme.colors.text.primary, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }];

  return (
    <View style={[s.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.card.background }]} testID="p2p-verify-card">
      <View style={s.rowBetween}>
        <Text style={[s.title, { color: theme.colors.text.primary }]}>{t('p2pdev.title')}</Text>
        <TouchableOpacity onPress={onClose} testID="p2p-verify-close">
          <Text style={{ color: theme.colors.text.secondary }}>{t('p2pdev.close')}</Text>
        </TouchableOpacity>
      </View>
      <Text style={[s.sub, { color: theme.colors.text.secondary }]}>{t('p2pdev.desc')}</Text>
      {/* Auto-release policy (`SETTLEMENT_CNY_AUTO_RELEASE_ON`): is a qualifying
          read the confirm, or evidence only? Default is `off`. */}
      <Text style={[s.policy, { color: theme.colors.text.secondary }]} testID="p2p-verify-policy">
        {autoReleaseOn === 'off'
          ? t('p2pdev.policyOff')
          : t('p2pdev.policyOn', { policy: autoReleaseOn })}
      </Text>
      <Text style={[s.policy, { color: theme.colors.text.secondary }]} testID="p2p-verify-mode-hint">
        {mode === null
          ? t('p2phelp.wechatBuyer')
          : mode === 'notification'
            ? t('p2phelp.wechatSeller')
            : t('p2phelp.openDetail', { rail: swap.wantRail ?? '' })}
      </Text>

      {pairings.filter((p) => !p.revoked).length === 0 ? (
        <View style={{ marginTop: 8, gap: 8 }}>
          <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('p2pdev.pairTitle')}</Text>
          <Text style={[s.policy, { color: theme.colors.text.secondary }]} testID="p2p-verify-reach-hint">{t('p2phelp.reach')}</Text>
          <TextInput style={inputStyle} value={endpoint} onChangeText={setEndpoint} placeholder={t('p2pdev.endpointPh')} placeholderTextColor={theme.colors.text.secondary} autoCapitalize="none" testID="p2p-verify-endpoint" />
          <TextInput style={inputStyle} value={token} onChangeText={setToken} placeholder={t('p2pdev.tokenPh')} placeholderTextColor={theme.colors.text.secondary} autoCapitalize="none" secureTextEntry testID="p2p-verify-token" />
          <TextInput style={inputStyle} value={deviceId} onChangeText={setDeviceId} placeholder={t('p2pdev.device')} placeholderTextColor={theme.colors.text.secondary} autoCapitalize="none" testID="p2p-verify-device" />
          <Button label={t('p2pdev.pair')} color={theme.colors.accent.blue} onPress={pair} disabled={busy || !endpoint.trim() || !token.trim()} testID="p2p-verify-pair" />
        </View>
      ) : (
        <View style={{ marginTop: 8, gap: 6 }}>
          <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('p2pdev.pairings')}</Text>
          {pairings.filter((p) => !p.revoked).map((p) => (
            <View key={p.pairingId} style={s.rowBetween} testID={`p2p-verify-pairing-${p.pairingId}`}>
              <Text style={[s.mono, { color: theme.colors.text.secondary }]} numberOfLines={1}>
                {p.endpoint} · {t('p2pdev.expires')} {new Date(p.expiresAt).toLocaleDateString()}
              </Text>
              <TouchableOpacity onPress={() => void revoke(p.pairingId)} disabled={busy} testID={`p2p-verify-revoke-${p.pairingId}`}>
                <Text style={{ color: theme.colors.negative }}>{t('p2pdev.revoke')}</Text>
              </TouchableOpacity>
            </View>
          ))}
          <Button label={busy ? t('p2pdev.reading') : t('p2pdev.read')} color={theme.colors.accent.emerald} onPress={read} disabled={busy || !active || !mode} testID="p2p-verify-read" />
        </View>
      )}

      {result ? (
        <View style={{ marginTop: 10, gap: 4 }} testID="p2p-verify-result">
          <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('p2pdev.observed')}: {String(result.verdict.observed ?? '')}</Text>
          {entry?.amount ? <Text style={s.line}>{t('p2pdev.amount')}: {String(entry.amount)}</Text> : null}
          {entry?.txId ? <Text style={s.line}>{t('p2pdev.txId')}: {String(entry.txId)}</Text> : null}
          {entry?.remark ? <Text style={s.line}>{t('p2pdev.remark')}: {String(entry.remark)}</Text> : null}
          <Text style={{ color: result.check.ok ? theme.colors.positive : theme.colors.negative }}>
            {result.check.ok ? t('p2pdev.matched') : t('p2pdev.mismatch', { e: result.check.error ?? '' })}
          </Text>
          <Button label={t('p2pdev.submit')} color={theme.colors.accent.emerald} onPress={submit} disabled={busy} testID="p2p-verify-submit" />
        </View>
      ) : null}

      {busy ? <ActivityIndicator style={{ marginTop: 8 }} /> : null}
    </View>
  );
}

function Button({ label, color, onPress, disabled, testID }: {
  label: string; color: string; onPress: () => void; disabled?: boolean; testID?: string;
}) {
  return (
    <TouchableOpacity style={[s.btn, { borderColor: color }]} onPress={onPress} disabled={disabled} testID={testID}>
      <Text style={[s.btnText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

const s = StyleSheet.create((theme) => ({
  card: { borderWidth: 1, borderRadius: 12, padding: 14, marginBottom: 12, gap: 4 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 15, fontWeight: '700' },
  sub: { fontSize: 12 },
  policy: { fontSize: 11, marginTop: 2 },
  label: { fontSize: 12, fontWeight: '600' },
  line: { fontSize: 13, color: theme.colors.text.primary },
  mono: { fontSize: 11, flex: 1 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  btn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'flex-start' },
  btnText: { fontSize: 13, fontWeight: '600' },
}));
