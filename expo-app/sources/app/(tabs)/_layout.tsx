import * as React from 'react';
import { TouchableOpacity, useWindowDimensions } from 'react-native';
import { Tabs } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { MenuIcon } from '@/components/Icons';
import { useSidebar } from '@/components/SidebarProvider';
import { useTranslation } from 'react-i18next';

const DESKTOP_BREAKPOINT = 768;

/**
 * The tab screens (order / predict / tokens / settings) are all reached from the
 * sidebar, so the bottom tab bar is hidden everywhere — navigation is uniform
 * (header hamburger → drawer on mobile, persistent sidebar on desktop). This
 * navigator still supplies the header for those routes.
 */
export default function TabsLayout() {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
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
        tabBarStyle: { display: 'none' },
        headerStyle: { backgroundColor: theme.colors.groupped.background },
        headerTintColor: theme.colors.text.primary,
        headerLeft: isDesktop ? undefined : headerLeft,
      }}
    >
      <Tabs.Screen name="buy" options={{ href: null, title: t('order.buy') }} />
      <Tabs.Screen name="sell" options={{ href: null, title: t('order.sell') }} />
      <Tabs.Screen name="order" options={{ title: t('order.myOrders') }} />
      <Tabs.Screen name="predict" options={{ title: t('predict.title') }} />
      <Tabs.Screen name="tokens" options={{ title: t('nav.tokens') }} />
      <Tabs.Screen name="settings" options={{ title: t('nav.settings') }} />
    </Tabs>
  );
}
