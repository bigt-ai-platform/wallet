import * as React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useTranslation } from 'react-i18next';
import { ChartIcon, HomeIcon, MenuIcon, SendIcon } from '@/components/Icons';
import { useSidebar } from '@/components/SidebarProvider';

/**
 * Mobile bottom nav (drawer-only on desktop), mirroring `../dai`'s Shell bar:
 * `Menu · Pay · Spot · Home`, with Menu leftmost (under the thumb) opening the
 * drawer. The drawer keeps the full destination list — the bar is a shortcut —
 * and it owns the four most-used mobile actions so the market Home is one tap
 * away without opening the hamburger.
 */
export default function BottomNav() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { setOpen } = useSidebar();

  const at = (route: string) => (route === '/' ? pathname === '/' : !!pathname?.startsWith(route));

  const items = [
    { key: 'menu', testID: 'nav-menu', label: t('nav.menu'), icon: MenuIcon, active: false, onPress: () => setOpen(true) },
    { key: 'pay', testID: 'nav-pay', label: t('sidebar.payment'), icon: SendIcon, active: at('/home/payment'), onPress: () => router.push('/home/payment' as never) },
    { key: 'spot', testID: 'nav-spot', label: t('trade.title'), icon: ChartIcon, active: at('/trade'), onPress: () => router.push('/trade' as never) },
    { key: 'home', testID: 'nav-home', label: t('sidebar.home'), icon: HomeIcon, active: pathname === '/', onPress: () => router.push('/' as never) },
  ];

  return (
    <View style={[s.bar, { borderTopColor: theme.colors.border, paddingBottom: Math.max(insets.bottom, 6) }]}>
      {items.map((it) => {
        const Icon = it.icon;
        const color = it.active ? theme.colors.primary : theme.colors.text.secondary;
        return (
          <TouchableOpacity
            key={it.key}
            style={s.item}
            onPress={it.onPress}
            testID={it.testID}
            accessibilityRole="button"
            accessibilityLabel={it.label}
          >
            <Icon size={21} color={color} />
            <Text style={[s.label, { color }]} numberOfLines={1}>{it.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: theme.colors.groupped.surface,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  item: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 2 },
  label: { fontSize: 11 },
}));
