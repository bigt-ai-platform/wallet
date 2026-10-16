import * as React from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useUnistyles } from 'react-native-unistyles';
import type { BootPhase } from '@/storage';

/**
 * Branded startup screen with progress steps, shown while `initSecureStorage()`
 * reports its boot phases (mirrors `../dai`'s BootstrapGate). Without it the app
 * renders `null` until the Keystore cache is loaded, so a slow (or wedged)
 * plugin is a blank frame with no clue where it stopped.
 *
 * The native splash covers the pre-JS bundle load; this takes over as soon as
 * React mounts and the splash is hidden.
 */
const STEPS: Array<{ phase: BootPhase; key: string }> = [
  { phase: 'platform', key: 'boot.start' },
  { phase: 'storage', key: 'boot.storage' },
  { phase: 'ready', key: 'boot.ready' },
];

export default function BootScreen({ phase }: { phase: BootPhase }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const active = Math.max(0, STEPS.findIndex((s) => s.phase === phase));

  return (
    <View
      testID="boot-screen"
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 28,
        padding: 24,
        backgroundColor: theme.colors.groupped.background,
      }}
    >
      <Text style={{ fontSize: 28, fontWeight: '700', color: theme.colors.text.primary }}>
        {t('sidebar.bigt')}
      </Text>
      <View style={{ gap: 14, minWidth: 240 }}>
        {STEPS.map((s, i) => {
          const done = i < active;
          const current = i === active;
          return (
            <View
              key={s.phase}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 12, opacity: done || current ? 1 : 0.45 }}
            >
              <View style={{ width: 18, alignItems: 'center', justifyContent: 'center' }}>
                {done ? (
                  <Text style={{ color: theme.colors.primary, fontWeight: '700' }}>✓</Text>
                ) : current ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                  <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.divider }} />
                )}
              </View>
              <Text
                style={{
                  color: done ? theme.colors.text.secondary : theme.colors.text.primary,
                  fontWeight: current ? '600' : '400',
                  opacity: done ? 0.8 : 1,
                }}
              >
                {t(s.key)}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
