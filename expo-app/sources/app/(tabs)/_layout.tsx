import * as React from 'react';
import { Tabs } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

export default function TabsLayout() {
  const { theme } = useUnistyles();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.text.secondary,
        tabBarStyle: {
          backgroundColor: theme.colors.groupped.background,
          borderTopColor: theme.colors.border,
        },
        headerStyle: {
          backgroundColor: theme.colors.groupped.background,
        },
        headerTintColor: theme.colors.text.primary,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Transaction',
          tabBarLabel: 'Transaction',
        }}
      />
      <Tabs.Screen
        name="wallet"
        options={{
          title: 'Wallet',
          tabBarLabel: 'Wallet',
        }}
      />
      <Tabs.Screen
        name="market"
        options={{
          title: 'Market',
          tabBarLabel: 'Market',
        }}
      />
      <Tabs.Screen
        name="tokens"
        options={{
          title: 'Tokens',
          tabBarLabel: 'Tokens',
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarLabel: 'Settings',
        }}
      />
    </Tabs>
  );
}
