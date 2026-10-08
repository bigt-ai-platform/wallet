import * as React from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useWallet } from '@/state/wallet';
import { WalletIcon } from '@/components/Icons';
import { showAlert } from '@/utils/alert';
import { MONO_FONT } from '@/constants/fonts';

interface WalletUnlockProps {
  /** Contextual subtitle; defaults to the generic "view assets and balance". */
  subtitle?: string;
  /** Fill the parent and center vertically (standalone pages). */
  fullScreen?: boolean;
  testID?: string;
}

/**
 * Shared "Wallet Locked" inline unlock block: address, password field and an
 * Unlock button, with a create/import fallback when no wallet exists. Used by
 * every screen that needs an unlocked wallet so the experience is identical.
 */
export default function WalletUnlock({ subtitle, fullScreen = true, testID }: WalletUnlockProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { theme } = useUnistyles();
  const { publicInfo, unlockWallet } = useWallet();
  const [unlockPwd, setUnlockPwd] = React.useState('');
  const [unlocking, setUnlocking] = React.useState(false);

  const handleUnlock = async () => {
    if (!unlockPwd || unlocking) return;
    setUnlocking(true);
    try {
      await unlockWallet(unlockPwd);
    } catch (e: any) {
      showAlert(t('transaction.error'), e?.message || t('keys.wrongPassword'));
    } finally {
      setUnlocking(false);
    }
  };

  const body = (
    <View style={fullScreen ? s.centered : s.centeredInline} testID={testID}>
      <WalletIcon size={48} color={theme.colors.text.secondary} />
      {publicInfo?.hasEncryptedWallet ? (
        <>
          <Text style={s.lockedTitle}>{t('wallet.locked')}</Text>
          <Text style={s.lockedSub}>{subtitle ?? t('wallet.lockedSub')}</Text>
          <Text style={s.walletLabel}>
            {t('transaction.walletLabel', { address: `${(publicInfo?.address ?? '').slice(0, 10)}...` })}
          </Text>
          <TextInput
            style={s.unlockInput}
            value={unlockPwd}
            onChangeText={setUnlockPwd}
            placeholder={t('wallet.passwordPlaceholder')}
            placeholderTextColor={s.placeholder.color}
            secureTextEntry
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={handleUnlock}
            testID="wallet-password-input"
          />
          <TouchableOpacity
            style={[s.primaryBtn, unlocking && s.btnDisabled]}
            onPress={handleUnlock}
            disabled={unlocking}
            testID="unlock-wallet-button"
          >
            <Text style={s.primaryBtnText}>{unlocking ? t('keys.unlocking') : t('keys.unlock')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={s.lockedTitle}>{t('wallet.noWalletFound')}</Text>
          <Text style={s.lockedSub}>{t('wallet.noWalletFoundSub')}</Text>
          <TouchableOpacity style={s.primaryBtn} onPress={() => router.push('/home/keys')} testID="wallet-unlock-create">
            <Text style={s.primaryBtnText}>{t('wallet.createWallet')}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.secondaryBtn} onPress={() => router.push('/home/keys')} testID="wallet-unlock-import">
            <Text style={s.secondaryBtnText}>{t('wallet.importExistingWallet')}</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );

  if (!fullScreen) return body;
  return <View style={s.container}>{body}</View>;
}

const s = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.groupped.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  centeredInline: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 24 },
  lockedTitle: { fontSize: 20, fontWeight: '700', color: theme.colors.text.primary, marginBottom: 8, marginTop: 12 },
  lockedSub: { fontSize: 14, color: theme.colors.text.secondary, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  walletLabel: { fontSize: 13, color: theme.colors.text.secondary, marginBottom: 12, fontFamily: MONO_FONT },
  unlockInput: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, backgroundColor: theme.colors.groupped.surface, color: theme.colors.text.primary, padding: 12, fontSize: 15, width: '100%', maxWidth: 280, marginBottom: 12 },
  placeholder: { color: theme.colors.text.secondary },
  primaryBtn: { backgroundColor: theme.colors.primary, borderRadius: 10, paddingVertical: 15, paddingHorizontal: 32, alignItems: 'center', marginTop: 8, width: '100%', maxWidth: 280 },
  primaryBtnText: { fontSize: 16, fontWeight: '600', color: '#FFFFFF' },
  secondaryBtn: { borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, paddingVertical: 14, paddingHorizontal: 32, alignItems: 'center', marginTop: 10, width: '100%', maxWidth: 280 },
  secondaryBtnText: { fontSize: 15, fontWeight: '600', color: theme.colors.text.secondary },
  btnDisabled: { opacity: 0.5 },
}));
