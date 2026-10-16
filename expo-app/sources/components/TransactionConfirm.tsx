import * as React from 'react';
import { Modal, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTranslation } from 'react-i18next';
import { useWallet } from '@/state/wallet';
import { confirmWithDeviceUnlock, isDeviceUnlockSupported } from '@/services/deviceAuth';
import { confirmWithPlatformAuthenticator } from '@/services/webAuthn';

/**
 * Confirmation gate for important transactions (pay / buy / sell).
 *
 * On the Android app the OS unlock (fingerprint/face or device PIN) is shown via
 * the native `DeviceAuth` plugin. When that is unavailable — a plain browser, or
 * a phone with no credential set — the gate falls back to re-entering the wallet
 * password. Rendered once at the app root so any screen can await `confirm()`.
 */
export interface TransactionConfirmOptions {
  /** short headline, defaults to the standard "Confirm Transaction" */
  title?: string;
  /** action line, e.g. "Sell 10 BIG" */
  subtitle?: string;
  /** extra context shown by the native prompt */
  reason?: string;
}

type ConfirmFn = (opts?: TransactionConfirmOptions) => Promise<boolean>;

const Ctx = React.createContext<ConfirmFn>(async () => true);

/** Await this before signing an important transaction; false = user declined. */
export function useTransactionConfirm(): ConfirmFn {
  return React.useContext(Ctx);
}

interface Pending extends TransactionConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function TransactionConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { getPassword } = useWallet();
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [pwd, setPwd] = React.useState('');
  const [wrong, setWrong] = React.useState(false);

  const close = (ok: boolean) => {
    setPending((p) => {
      p?.resolve(ok);
      return null;
    });
    setPwd('');
    setWrong(false);
  };

  const confirm = React.useCallback<ConfirmFn>(
    async (opts) => {
      const title = opts?.title ?? t('transaction.confirmTitle');
      if (isDeviceUnlockSupported()) {
        // Android app: the OS unlock (fingerprint/face or device PIN).
        const res = await confirmWithDeviceUnlock({ title, subtitle: opts?.subtitle, reason: opts?.reason });
        if (res === 'ok') return true;
        if (res === 'denied') return false;
        // unavailable (no plugin / no credential) → wallet-password fallback
      } else {
        // Browser: the platform authenticator (Hello/Touch ID/fingerprint).
        const res = await confirmWithPlatformAuthenticator();
        if (res === 'ok') return true;
        if (res === 'denied') return false;
        // unavailable (insecure origin / no authenticator) → wallet-password fallback
      }
      // An unencrypted wallet has no password to re-check — nothing to confirm.
      if (!getPassword()) return true;
      return await new Promise<boolean>((resolve) => {
        setPwd('');
        setWrong(false);
        setPending({ ...opts, title, resolve });
      });
    },
    [getPassword, t],
  );

  const submit = () => {
    if (!pending) return;
    if (pwd && pwd === getPassword()) close(true);
    else setWrong(true);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Modal visible={!!pending} transparent animationType="fade" onRequestClose={() => close(false)}>
        <View style={s.overlay}>
          <View style={s.sheet} testID="confirm-transaction">
            <Text style={s.title}>{pending?.title}</Text>
            {pending?.subtitle ? <Text style={s.subtitle}>{pending.subtitle}</Text> : null}
            <TextInput
              style={s.input}
              value={pwd}
              onChangeText={(v) => {
                setPwd(v);
                setWrong(false);
              }}
              placeholder={t('wallet.passwordPlaceholder')}
              placeholderTextColor={theme.colors.text.secondary}
              secureTextEntry
              autoFocus
              onSubmitEditing={submit}
              testID="confirm-password"
            />
            {wrong ? <Text style={s.error}>{t('wallet.wrongPassword')}</Text> : null}
            <View style={s.row}>
              <TouchableOpacity style={[s.btn, s.cancel]} onPress={() => close(false)} testID="confirm-cancel">
                <Text style={s.cancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.ok]} onPress={submit} testID="confirm-ok">
                <Text style={s.okText}>{t('common.ok')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </Ctx.Provider>
  );
}

const s = StyleSheet.create((theme) => ({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  sheet: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: theme.colors.groupped.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 18,
  },
  title: { fontSize: 17, fontWeight: '700', color: theme.colors.text.primary },
  subtitle: { fontSize: 13, color: theme.colors.text.secondary, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    backgroundColor: theme.colors.groupped.background,
    color: theme.colors.text.primary,
    padding: 12,
    fontSize: 15,
    marginTop: 14,
  },
  error: { color: theme.colors.error, fontSize: 12, marginTop: 8 },
  row: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  cancel: { backgroundColor: theme.colors.surfacePressed },
  ok: { backgroundColor: theme.colors.primary },
  cancelText: { color: theme.colors.text.primary, fontSize: 15, fontWeight: '600' },
  okText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
}));
