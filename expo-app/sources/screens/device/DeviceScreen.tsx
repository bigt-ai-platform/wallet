import * as React from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Image, ActivityIndicator, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AndroidMcpClient, claimPairing, type MobileDevice, type UiElement } from 'mobile-control';
import { device as deviceStore } from '@/storage';
import { p2pPdfUrl, tzRegion } from '@/lib/docs';
import { useWallet } from '@/state/wallet';
import WalletUnlock from '@/components/WalletUnlock';

const K_ENDPOINT = ['device', 'mobileEndpoint'];
const K_TOKEN = ['device', 'mobileToken'];
const K_DEVICE = ['device', 'mobileDevice'];

/** The deployed on-phone app (android-remote-control-mcp, built as "Mobile
 *  Agent" by ../android-remote-control-mcp/deploy.apk.sh). Same URL the dai
 *  #mobile page links. */
const APK_URL = 'https://s3.bigt.ai/apps/android-remote-control-mcp/apk/MobileAgent.apk';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

/**
 * Device screen (docs/p2p.md §12): pair a **mobile-mcp** endpoint the user runs
 * beside their own phone and drive that device — launch apps, tap, type, swipe,
 * screenshot — through the shared `mobile-control` client. Consent is the
 * pairing: the user hands this app the endpoint URL + its MOBILEMCP_AUTH token,
 * and stopping the server (or clearing the pairing) revokes it. The engine is
 * never in the loop; this only ever talks to the endpoint the user paired.
 */
export default function DeviceScreen() {
  const { t, i18n } = useTranslation();
  const { theme } = useUnistyles();
  const { isUnlocked } = useWallet();

  const clientRef = React.useRef<AndroidMcpClient | null>(null);
  const inFlight = React.useRef(false);
  const [endpoint, setEndpoint] = React.useState(() => deviceStore.get(K_ENDPOINT) ?? '');
  const [token, setToken] = React.useState(() => deviceStore.get(K_TOKEN) ?? '');
  const [deviceId, setDeviceId] = React.useState(() => deviceStore.get(K_DEVICE) ?? '');
  const [code, setCode] = React.useState('');
  const [connected, setConnected] = React.useState(false);
  const [devices, setDevices] = React.useState<MobileDevice[]>([]);
  const [foreground, setForeground] = React.useState('');
  const [elements, setElements] = React.useState<UiElement[]>([]);
  const [shot, setShot] = React.useState<string | null>(null);
  const [pkg, setPkg] = React.useState('');
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<{ ok: boolean; text: string } | null>(null);

  const flash = React.useCallback((ok: boolean, text: string) => setNotice({ ok, text }), []);

  React.useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  const connect = React.useCallback(
    async (silent = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const base = endpoint.trim();
      if (!base) {
        if (!silent) flash(false, t('device.needPair'));
        inFlight.current = false;
        return;
      }
      setBusy(true);
      try {
        const opts = { baseUrl: base, ...(token.trim() ? { token: token.trim() } : {}) };
        const client = await AndroidMcpClient.connect({ device: deviceId.trim() || 'list', ...opts });
        const list = await client.listDevices();
        const chosen = deviceId.trim() || list[0]?.id || '';
        if (chosen && chosen !== (deviceId.trim() || 'list')) {
          client.close();
          clientRef.current = await AndroidMcpClient.connect({ device: chosen, ...opts });
        } else {
          clientRef.current = client;
        }
        setDevices(list);
        setDeviceId(chosen);
        setConnected(true);
        deviceStore.set(K_ENDPOINT, base);
        deviceStore.set(K_TOKEN, token.trim());
        deviceStore.set(K_DEVICE, chosen);
        if (!silent) flash(true, t('device.paired'));
      } catch (e) {
        setConnected(false);
        if (!silent) flash(false, t('device.pairFailed', { e: msg(e) }));
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [endpoint, token, deviceId, t, flash],
  );

  // Auto-reconnect a previously saved pairing on open.
  React.useEffect(() => {
    if (isUnlocked && endpoint.trim() && token.trim()) void connect(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUnlocked]);

  /**
   * Pair with the short single-use code the on-phone app shows on its Server
   * screen (docs/p2p.md §12): spend it at `/pair/claim` for a per-device token,
   * then connect with that token — no long bearer to copy.
   */
  const pairWithCode = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const base = endpoint.trim();
    const c = code.trim();
    if (!base || !c) {
      flash(false, t('device.needPair'));
      inFlight.current = false;
      return;
    }
    setBusy(true);
    try {
      const claimed = await claimPairing(base, c, { name: 'wallet' });
      // Verify the new token actually reaches the endpoint BEFORE persisting it: the code is
      // single-use, so a failed connect must not leave a saved (but working-nowhere) pairing.
      const client = await AndroidMcpClient.connect({ device: 'list', baseUrl: claimed.baseUrl, token: claimed.token });
      const list = await client.listDevices();
      const chosen = list[0]?.id || 'self';
      client.close();
      clientRef.current = await AndroidMcpClient.connect({ device: chosen, baseUrl: claimed.baseUrl, token: claimed.token });
      setEndpoint(claimed.baseUrl);
      setToken(claimed.token);
      setCode('');
      setDevices(list);
      setDeviceId(chosen);
      setConnected(true);
      deviceStore.set(K_ENDPOINT, claimed.baseUrl);
      deviceStore.set(K_TOKEN, claimed.token);
      deviceStore.set(K_DEVICE, chosen);
      flash(true, t('device.pairedCode'));
    } catch (e) {
      setConnected(false);
      flash(false, t('device.pairCodeFailed', { e: msg(e) }));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }, [endpoint, code, t, flash]);

  /** Clear the local pairing (token + endpoint). Revoking on the phone is separate. */
  const unpair = React.useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    deviceStore.remove(K_ENDPOINT);
    deviceStore.remove(K_TOKEN);
    deviceStore.remove(K_DEVICE);
    setEndpoint('');
    setToken('');
    setDeviceId('');
    setDevices([]);
    setElements([]);
    setForeground('');
    setShot(null);
    setConnected(false);
    flash(true, t('device.unpaired', { defaultValue: 'Unpaired — revoke it on the phone too if needed.' }));
  }, [t, flash]);

  async function run(fn: (c: AndroidMcpClient) => Promise<unknown>, ok: string) {
    const c = clientRef.current;
    if (!c) {
      flash(false, t('device.needPair'));
      return;
    }
    setBusy(true);
    try {
      await fn(c);
      flash(true, ok);
    } catch (e) {
      flash(false, msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    const c = clientRef.current;
    if (!c) {
      flash(false, t('device.needPair'));
      return;
    }
    setBusy(true);
    try {
      const list = await c.listDevices();
      setDevices(list);
      setForeground(await c.foregroundApp());
      flash(true, t('device.checkOk', { n: list.length }));
    } catch (e) {
      flash(false, t('device.checkFailed', { e: msg(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function readScreen() {
    const c = clientRef.current;
    if (!c) {
      flash(false, t('device.needPair'));
      return;
    }
    setBusy(true);
    try {
      const els = await c.listElements();
      setElements(els);
      flash(true, t('device.elements', { n: els.length }));
    } catch (e) {
      flash(false, msg(e));
    } finally {
      setBusy(false);
    }
  }

  async function takeScreenshot() {
    const c = clientRef.current;
    if (!c) {
      flash(false, t('device.needPair'));
      return;
    }
    setBusy(true);
    try {
      setShot(await c.screenshotDataUri());
    } catch (e) {
      flash(false, msg(e));
    } finally {
      setBusy(false);
    }
  }

  if (!isUnlocked) {
    return <WalletUnlock fullScreen={false} subtitle={t('transaction.lockedSub')} testID="device-need-unlock" />;
  }

  const card = { backgroundColor: theme.colors.card.background, borderColor: theme.colors.card.border };
  const inputStyle = [s.input, { color: theme.colors.text.primary, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }];
  const btn = (color: string) => [s.btn, { backgroundColor: color }];

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={s.container} testID="device-screen">
      <View style={[s.card, card]} testID="device-status">
        <View style={s.rowBetween}>
          <Text style={[s.cardTitle, { color: connected ? theme.colors.positive : theme.colors.text.primary }]}>
            {connected ? t('device.connected') : t('device.setupTitle')}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity style={btn(theme.colors.accent.blue)} onPress={() => void connect()} disabled={busy} testID="device-pair">
              <Text style={s.btnText}>{t('device.pair')}</Text>
            </TouchableOpacity>
            {(!!endpoint.trim() || !!token.trim()) && (
              <TouchableOpacity
                style={btn(theme.colors.accent.red)}
                onPress={unpair}
                disabled={busy}
                testID="device-unpair"
              >
                <Text style={s.btnText}>{t('device.unpair', { defaultValue: 'Unpair' })}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
        <TouchableOpacity
          onPress={() => void Linking.openURL(p2pPdfUrl(i18n.language, tzRegion())).catch(() => {})}
          testID="device-guide"
          accessibilityRole="link"
        >
          <Text style={[s.hint, { color: theme.colors.text.link }]}>{t('device.guide')}</Text>
        </TouchableOpacity>
        <Text style={[s.hint, { color: theme.colors.text.secondary }]}>{t('device.notConfigured')}</Text>

        {/* how-to (mirrors the dai #mobile page): install the on-phone app,
            grant Accessibility, start its server, then pair it here. */}
        <View style={{ marginTop: 8, gap: 4 }}>
          <Text style={[s.label, { color: theme.colors.text.primary }]}>{t('device.step1Title')}</Text>
          <Text style={[s.hint, { color: theme.colors.text.secondary }]}>{t('device.step1Desc')}</Text>
          <TouchableOpacity
            style={[s.btn, { backgroundColor: theme.colors.groupped.surface, borderWidth: 1, borderColor: theme.colors.border }]}
            onPress={() => void Linking.openURL(APK_URL)}
            testID="device-apk-download"
          >
            <Text style={[s.btnText, { color: theme.colors.text.link }]}>⬇ {t('device.downloadApp')}</Text>
          </TouchableOpacity>
          <Text style={[s.mono, { color: theme.colors.text.secondary }]}>{APK_URL}</Text>

          <Text style={[s.label, { color: theme.colors.text.primary, marginTop: 6 }]}>{t('device.step2Title')}</Text>
          <Text style={[s.hint, { color: theme.colors.text.secondary }]}>{t('device.step2Desc')}</Text>

          <Text style={[s.label, { color: theme.colors.text.primary, marginTop: 6 }]}>{t('device.step3Title')}</Text>
          <Text style={[s.hint, { color: theme.colors.text.secondary }]}>{t('device.step3Desc')}</Text>
        </View>

        <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('device.endpoint')}</Text>
        <TextInput
          style={inputStyle}
          value={endpoint}
          onChangeText={setEndpoint}
          placeholder={t('device.endpointHint')}
          placeholderTextColor={theme.colors.text.secondary}
          autoCapitalize="none"
          testID="device-endpoint"
        />
        <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('device.pairCode')}</Text>
        <View style={s.rowWrap}>
          <TextInput
            style={[inputStyle, s.flex]}
            value={code}
            onChangeText={setCode}
            placeholder={t('device.pairCodeHint')}
            placeholderTextColor={theme.colors.text.secondary}
            autoCapitalize="characters"
            autoCorrect={false}
            testID="device-pair-code"
          />
          <TouchableOpacity
            style={btn(theme.colors.accent.emerald)}
            onPress={() => void pairWithCode()}
            disabled={busy || !code.trim()}
            testID="device-pair-code-btn"
          >
            <Text style={s.btnText}>{t('device.pairWithCode')}</Text>
          </TouchableOpacity>
        </View>
        <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('device.token')}</Text>
        <TextInput
          style={inputStyle}
          value={token}
          onChangeText={setToken}
          placeholder={t('device.tokenHint')}
          placeholderTextColor={theme.colors.text.secondary}
          autoCapitalize="none"
          secureTextEntry
          testID="device-token"
        />
        <Text style={[s.label, { color: theme.colors.text.secondary }]}>{t('device.deviceId')}</Text>
        <TextInput
          style={inputStyle}
          value={deviceId}
          onChangeText={setDeviceId}
          placeholder={t('device.deviceIdHint')}
          placeholderTextColor={theme.colors.text.secondary}
          autoCapitalize="none"
          testID="device-id"
        />

        <View style={s.rowWrap}>
          <TouchableOpacity style={btn(theme.colors.accent.emerald)} onPress={() => void check()} disabled={busy} testID="device-check">
            <Text style={s.btnText}>{busy ? t('device.checking') : t('device.check')}</Text>
          </TouchableOpacity>
        </View>

        <Text style={[s.meta, { color: theme.colors.text.secondary }]}>
          {t('device.devices')}: {devices.length ? devices.map((d) => d.id).join(', ') : t('device.noDevice')}
        </Text>
        {!!foreground && (
          <Text style={[s.meta, { color: theme.colors.text.secondary }]}>
            {t('device.foreground')}: {foreground}
          </Text>
        )}
      </View>

      {connected && (
        <View style={[s.card, card]} testID="device-control">
          <Text style={[s.cardTitle, { color: theme.colors.text.primary }]}>{t('device.controlTitle')}</Text>

          <View style={s.rowWrap}>
            <TextInput
              style={[inputStyle, s.flex]}
              value={pkg}
              onChangeText={setPkg}
              placeholder={t('device.packageHint')}
              placeholderTextColor={theme.colors.text.secondary}
              autoCapitalize="none"
              testID="device-package"
            />
            <TouchableOpacity style={btn(theme.colors.accent.emerald)} disabled={busy || !pkg.trim()} onPress={() => void run((c) => c.launchApp(pkg.trim()), t('device.launch'))} testID="device-launch">
              <Text style={s.btnText}>{t('device.launch')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={btn(theme.colors.accent.red)} disabled={busy || !pkg.trim()} onPress={() => void run((c) => c.terminateApp(pkg.trim()), t('device.terminate'))} testID="device-terminate">
              <Text style={s.btnText}>{t('device.terminate')}</Text>
            </TouchableOpacity>
          </View>

          <View style={s.rowWrap}>
            <TextInput
              style={[inputStyle, s.flex]}
              value={text}
              onChangeText={setText}
              placeholder={t('device.typeHint')}
              placeholderTextColor={theme.colors.text.secondary}
              testID="device-type-text"
            />
            <TouchableOpacity style={btn(theme.colors.accent.blue)} disabled={busy || !text} onPress={() => void run((c) => c.typeKeys(text), t('device.type'))} testID="device-type">
              <Text style={s.btnText}>{t('device.type')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={btn(theme.colors.accent.blue)} disabled={busy || !text} onPress={() => void run((c) => c.typeKeys(text, true), t('device.submit'))} testID="device-submit">
              <Text style={s.btnText}>⏎</Text>
            </TouchableOpacity>
          </View>

          <View style={s.rowWrap}>
            <TouchableOpacity style={btn(theme.colors.accent.purple)} onPress={() => void readScreen()} disabled={busy} testID="device-screen-read">
              <Text style={s.btnText}>{t('device.screen')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={btn(theme.colors.accent.purple)} onPress={() => void run((c) => c.swipe('up'), t('device.swipeUp'))} disabled={busy} testID="device-swipe">
              <Text style={s.btnText}>{t('device.swipeUp')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={btn(theme.colors.accent.amber)} onPress={() => void run((c) => c.pressButton('HOME'), t('device.home'))} disabled={busy} testID="device-home">
              <Text style={s.btnText}>{t('device.home')}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={btn(theme.colors.accent.amber)} onPress={() => void takeScreenshot()} disabled={busy} testID="device-screenshot">
              <Text style={s.btnText}>{t('device.screenshot')}</Text>
            </TouchableOpacity>
          </View>

          {busy && <ActivityIndicator style={{ marginTop: 8 }} />}
        </View>
      )}

      {!!elements.length && (
        <View style={[s.card, card]} testID="device-elements">
          <Text style={[s.cardTitle, { color: theme.colors.text.primary }]}>{t('device.screenTitle')}</Text>
          {elements.slice(0, 40).map((el, i) => (
            <Text key={i} style={[s.meta, { color: theme.colors.text.secondary }]} numberOfLines={1}>
              {el.ref ? `${el.ref} ` : ''}
              {el.text ?? el.label ?? el.value ?? ''}
            </Text>
          ))}
        </View>
      )}

      {!!shot && (
        <View style={[s.card, card]} testID="device-shot">
          <Text style={[s.cardTitle, { color: theme.colors.text.primary }]}>{t('device.screenshot')}</Text>
          <Image source={{ uri: shot }} style={s.shot} resizeMode="contain" />
        </View>
      )}

      {notice && (
        <Text style={[s.notice, { color: notice.ok ? theme.colors.positive : theme.colors.negative }]} testID="device-notice">
          {notice.text}
        </Text>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: 12, gap: 12 },
  card: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 },
  flex: { flex: 1, minWidth: 140 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  hint: { fontSize: 12 },
  label: { fontSize: 12, marginTop: 6 },
  meta: { fontSize: 12 },
  mono: { fontSize: 11 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13 },
  btn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  btnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  shot: { width: '100%', height: 320, borderRadius: 8 },
  notice: { fontSize: 13, paddingHorizontal: 4 },
});
