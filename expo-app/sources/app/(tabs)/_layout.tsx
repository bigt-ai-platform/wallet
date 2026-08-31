import * as React from 'react';
import { TouchableOpacity, useWindowDimensions, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { MenuIcon, MarketIcon, TokensIcon, SettingsIcon } from '@/components/Icons';
import { useSidebar } from '@/components/SidebarProvider';
import { useTranslation } from 'react-i18next';

const DESKTOP_BREAKPOINT = 768;

export default function TabsLayout() {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isDesktop = width >= DESKTOP_BREAKPOINT;
  const { setOpen } = useSidebar();
  const { t } = useTranslation();

  const headerLeft = () => (
    <TouchableOpacity onPress={() => setOpen(true)} style={{ paddingLeft: 16, paddingRight: 8, paddingVertical: 4 }}
      accessibilityRole="button" accessibilityLabel={t('sidebar.menu')}>
      <MenuIcon size={22} color={theme.colors.text.primary} />
    </TouchableOpacity>
  );

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.text.secondary,
        tabBarStyle: {
          backgroundColor: theme.colors.groupped.surface,
          borderTopColor: theme.colors.border,
          height: 56 + insets.bottom,
          paddingBottom: Math.max(insets.bottom, 6),
          paddingTop: 6,
          display: isDesktop ? 'none' : undefined,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          marginBottom: Platform.OS === 'android' ? 4 : 0,
        },
        headerStyle: { backgroundColor: theme.colors.groupped.background },
        headerTintColor: theme.colors.text.primary,
        headerLeft: isDesktop ? undefined : headerLeft,
      }}
    >
      <Tabs.Screen name="buy" options={{ href: null, title: t('order.buy'), tabBarLabel: t('order.buy') }} />
      <Tabs.Screen name="sell" options={{ href: null, title: t('order.sell'), tabBarLabel: t('order.sell') }} />
      <Tabs.Screen name="order" options={{ title: t('nav.order'), tabBarLabel: t('nav.order'), tabBarIcon: ({ color, size }) => <MarketIcon size={size} color={color} /> }} />
      <Tabs.Screen name="tokens" options={{ title: t('nav.tokens'), tabBarLabel: t('nav.tokens'), tabBarIcon: ({ color, size }) => <TokensIcon size={size} color={color} /> }} />
      <Tabs.Screen name="settings" options={{ title: t('nav.settings'), tabBarLabel: t('nav.settings'), tabBarIcon: ({ color, size }) => <SettingsIcon size={size} color={color} /> }} />
    </Tabs>
  );
}
