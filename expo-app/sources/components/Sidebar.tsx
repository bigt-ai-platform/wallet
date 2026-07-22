import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  Platform, StyleSheet, StatusBar,
} from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import {
  WalletIcon, MarketIcon, TokensIcon, SettingsIcon, CloseIcon,
} from './Icons';
import LanguageSwitcher from './LanguageSwitcher';

interface NavItem {
  label: string;
  icon: React.FC<{ size?: number; color?: string }>;
  route: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Transaction', icon: WalletIcon, route: '/' },
  { label: 'Wallet', icon: WalletIcon, route: '/wallet' },
  { label: 'Market', icon: MarketIcon, route: '/market' },
  { label: 'Tokens', icon: TokensIcon, route: '/tokens' },
  { label: 'Settings', icon: SettingsIcon, route: '/settings' },
];

interface SidebarProps {
  visible: boolean;
  onClose: () => void;
  persistent?: boolean;
}

const SIDEBAR_WIDTH = 260;

export default function Sidebar({ visible, onClose, persistent }: SidebarProps) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const pathname = usePathname();

  if (persistent) {
    return (
      <View style={[s.persistent, { backgroundColor: theme.colors.groupped.surface, borderRightColor: theme.colors.border }]}>
        <View style={[s.sidebarHeader, { borderBottomColor: theme.colors.border }]}>
          <Text style={[s.logoText, { color: theme.colors.text.primary }]}>bigT</Text>
        </View>
        <View style={s.langRow}><LanguageSwitcher /></View>
        <ScrollView style={s.navScroll}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.route, pathname);
            const Icon = item.icon;
            return (
              <TouchableOpacity key={item.route} style={[s.navItem, active && { backgroundColor: theme.colors.groupped.background }]}
                onPress={() => { router.push(item.route as any); }} activeOpacity={0.7}>
                <Icon size={20} color={active ? theme.colors.primary : theme.colors.text.secondary} />
                <Text style={[s.navLabel, { color: active ? theme.colors.text.primary : theme.colors.text.secondary }, active && { fontWeight: '600' }]}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        <View style={[s.footer, { borderTopColor: theme.colors.border }]}>
          <Text style={[s.footerText, { color: theme.colors.text.secondary }]}>bigT Wallet</Text>
        </View>
      </View>
    );
  }

  if (!visible) return null;

  return (
    <>
      <View style={s.overlay}><TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} /></View>
      <View style={[s.overlaySidebar, { backgroundColor: theme.colors.groupped.surface, borderRightColor: theme.colors.border }]}>
        <View style={[s.sidebarHeader, { borderBottomColor: theme.colors.border }]}>
          <Text style={[s.logoText, { color: theme.colors.text.primary }]}>bigT</Text>
          <TouchableOpacity onPress={onClose} style={s.closeBtn}><CloseIcon size={20} color={theme.colors.text.secondary} /></TouchableOpacity>
        </View>
        <View style={s.langRow}><LanguageSwitcher /></View>
        <ScrollView style={s.navScroll}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(item.route, pathname);
            const Icon = item.icon;
            return (
              <TouchableOpacity key={item.route} style={[s.navItem, active && { backgroundColor: theme.colors.groupped.background }]}
                onPress={() => { onClose(); router.push(item.route as any); }} activeOpacity={0.7}>
                <Icon size={20} color={active ? theme.colors.primary : theme.colors.text.secondary} />
                <Text style={[s.navLabel, { color: active ? theme.colors.text.primary : theme.colors.text.secondary }, active && { fontWeight: '600' }]}>{item.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </>
  );
}

function isActive(route: string, pathname: string | null): boolean {
  if (route === '/') return pathname === '/';
  return pathname?.startsWith(route) ?? false;
}

const s = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 998 },
  overlaySidebar: {
    position: 'absolute', top: 0, left: 0, bottom: 0, width: SIDEBAR_WIDTH, zIndex: 999,
    borderRightWidth: 1, paddingTop: Platform.OS === 'ios' ? 50 : (StatusBar.currentHeight || 24),
  },
  persistent: {
    width: SIDEBAR_WIDTH, borderRightWidth: 1,
    paddingTop: Platform.OS === 'ios' ? 50 : (StatusBar.currentHeight || 24),
  },
  sidebarHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1,
  },
  logoText: { fontSize: 20, fontWeight: '700' },
  closeBtn: { padding: 6 },
  langRow: { alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 8 },
  navScroll: { flex: 1, paddingVertical: 4 },
  navItem: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 11,
    marginHorizontal: 8, marginVertical: 1, borderRadius: 10, gap: 12,
  },
  navLabel: { fontSize: 14, fontWeight: '500' },
  footer: { borderTopWidth: 1, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  footerText: { fontSize: 11, fontWeight: '500' },
});
