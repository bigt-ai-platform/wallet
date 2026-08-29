import * as React from 'react';
import { TouchableOpacity, View, useWindowDimensions, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import Sidebar from '@/components/Sidebar';
import { MenuIcon, WalletIcon, MarketIcon, TokensIcon, SettingsIcon, SendIcon } from '@/components/Icons';
import { useTranslation } from 'react-i18next';

const DESKTOP_BREAKPOINT = 768;

export default function TabsLayout() {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isDesktop = width >= DESKTOP_BREAKPOINT;
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const { t } = useTranslation();

  const headerLeft = () => (
    <TouchableOpacity onPress={() => setSidebarOpen(true)} style={{ paddingLeft: 16, paddingRight: 8, paddingVertical: 4 }}
      accessibilityRole="button" accessibilityLabel={t('sidebar.menu')}>
      <MenuIcon size={22} color={theme.colors.text.primary} />
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.groupped.background }}>
      {isDesktop && (
        <Sidebar visible onClose={() => setSidebarOpen(false)} persistent />
      )}
      <View style={{ flex: 1, alignItems: isDesktop ? 'center' : undefined }}>
        <View style={{ flex: 1, width: '100%', maxWidth: isDesktop ? 820 : undefined }}>
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
            <Tabs.Screen name="index" options={{ title: t('nav.transaction'), tabBarLabel: t('nav.transaction'), tabBarIcon: ({ color, size }) => <SendIcon size={size} color={color} /> }} />
            <Tabs.Screen name="buy" options={{ href: null, title: t('order.buy'), tabBarLabel: t('order.buy') }} />
            <Tabs.Screen name="sell" options={{ href: null, title: t('order.sell'), tabBarLabel: t('order.sell') }} />
            <Tabs.Screen name="wallet" options={{ title: t('nav.wallet'), tabBarLabel: t('nav.wallet'), tabBarIcon: ({ color, size }) => <WalletIcon size={size} color={color} /> }} />
            <Tabs.Screen name="order" options={{ title: t('nav.order'), tabBarLabel: t('nav.order'), tabBarIcon: ({ color, size }) => <MarketIcon size={size} color={color} /> }} />
            <Tabs.Screen name="tokens" options={{ title: t('nav.tokens'), tabBarLabel: t('nav.tokens'), tabBarIcon: ({ color, size }) => <TokensIcon size={size} color={color} /> }} />
            <Tabs.Screen name="settings" options={{ title: t('nav.settings'), tabBarLabel: t('nav.settings'), tabBarIcon: ({ color, size }) => <SettingsIcon size={size} color={color} /> }} />
          </Tabs>
        </View>
      </View>

      {!isDesktop && <Sidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} />}
    </View>
  );
}
