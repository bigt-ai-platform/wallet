import * as React from 'react';
import { TouchableOpacity, View, useWindowDimensions } from 'react-native';
import { Tabs } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import Sidebar from '@/components/Sidebar';
import { MenuIcon, WalletIcon, MarketIcon, TokensIcon, SettingsIcon } from '@/components/Icons';

const DESKTOP_BREAKPOINT = 768;

export default function TabsLayout() {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const isDesktop = width >= DESKTOP_BREAKPOINT;
  const [sidebarOpen, setSidebarOpen] = React.useState(false);

  const headerLeft = () => (
    <TouchableOpacity onPress={() => setSidebarOpen(true)} style={{ paddingLeft: 16, paddingRight: 8, paddingVertical: 4 }}>
      <MenuIcon size={22} color={theme.colors.text.primary} />
    </TouchableOpacity>
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}>
      <View style={{ flex: 1, maxWidth: isDesktop ? 820 : undefined, alignSelf: isDesktop ? 'center' : undefined, width: '100%' }}>
        <Tabs
          screenOptions={{
            tabBarActiveTintColor: theme.colors.primary,
            tabBarInactiveTintColor: theme.colors.text.secondary,
            tabBarStyle: {
              backgroundColor: theme.colors.groupped.surface,
              borderTopColor: theme.colors.border,
              maxWidth: isDesktop ? 820 : undefined,
              alignSelf: isDesktop ? 'center' : undefined,
            },
            headerStyle: { backgroundColor: theme.colors.groupped.background },
            headerTintColor: theme.colors.text.primary,
            headerLeft,
          }}
        >
          <Tabs.Screen name="index" options={{ title: 'Transaction', tabBarLabel: 'Transaction', tabBarIcon: ({ color, size }) => <WalletIcon size={size} color={color} /> }} />
          <Tabs.Screen name="wallet" options={{ title: 'Wallet', tabBarLabel: 'Wallet', tabBarIcon: ({ color, size }) => <WalletIcon size={size} color={color} /> }} />
          <Tabs.Screen name="market" options={{ title: 'Market', tabBarLabel: 'Market', tabBarIcon: ({ color, size }) => <MarketIcon size={size} color={color} /> }} />
          <Tabs.Screen name="tokens" options={{ title: 'Tokens', tabBarLabel: 'Tokens', tabBarIcon: ({ color, size }) => <TokensIcon size={size} color={color} /> }} />
          <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarLabel: 'Settings', tabBarIcon: ({ color, size }) => <SettingsIcon size={size} color={color} /> }} />
        </Tabs>
      </View>

      <Sidebar visible={sidebarOpen} onClose={() => setSidebarOpen(false)} />
    </View>
  );
}
