import * as React from 'react';
import {
  View, Text, TouchableOpacity, ScrollView,
  StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, usePathname, useGlobalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import {
  WalletIcon, MarketIcon, TokensIcon, SettingsIcon, CloseIcon,
  ChartIcon, OrderIcon, DataIcon,
} from './Icons';
import LanguageSwitcher from './LanguageSwitcher';
import { useTranslation } from 'react-i18next';

interface NavItem {
  label: string;
  key: string;
  icon: React.FC<{ size?: number; color?: string }>;
  route: string;
  view?: string;
}

interface NavSection {
  titleKey: string;
  items: NavItem[];
}

interface SidebarProps {
  visible: boolean;
  onClose: () => void;
  persistent?: boolean;
}

const SIDEBAR_WIDTH = 260;

function NavItemRow({ item, onPress, isActive }: { item: NavItem; onPress: () => void; isActive: boolean }) {
  const { theme } = useUnistyles();
  const Icon = item.icon;
  return (
    <TouchableOpacity
      style={[s.navItem, isActive && { backgroundColor: theme.colors.primary + '15' }]}
      onPress={onPress}
      activeOpacity={0.6}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={item.label}
    >
      {isActive && <View style={[s.activeDot, { backgroundColor: theme.colors.primary }]} />}
      <Icon size={18} color={isActive ? theme.colors.primary : theme.colors.text.secondary} />
      <Text style={[s.navLabel, { color: isActive ? theme.colors.primary : theme.colors.text.secondary }, isActive && { fontWeight: '600' }]}>
        {item.label}
      </Text>
    </TouchableOpacity>
  );
}

export default function Sidebar({ visible, onClose, persistent }: SidebarProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();

  const navSections: NavSection[] = [
    {
      titleKey: 'sidebar.trade',
      items: [
        { label: t('sidebar.home'), key: 'transaction', icon: WalletIcon, route: '/' },
        { label: t('sidebar.exchange'), key: 'exchange', icon: MarketIcon, route: '/order', view: 'exchange' },
        { label: t('sidebar.chart'), key: 'chart', icon: ChartIcon, route: '/order', view: 'chart' },
      ],
    },
    {
      titleKey: 'sidebar.orders',
      items: [
        { label: t('sidebar.order'), key: 'order', icon: OrderIcon, route: '/order', view: 'orders' },
      ],
    },
    {
      titleKey: 'sidebar.market',
      items: [
        { label: t('sidebar.marketData'), key: 'marketData', icon: DataIcon, route: '/order', view: 'market' },
      ],
    },
    {
      titleKey: 'sidebar.portfolio',
      items: [
        { label: t('sidebar.wallet'), key: 'wallet', icon: WalletIcon, route: '/wallet' },
        { label: t('sidebar.tokens'), key: 'tokens', icon: TokensIcon, route: '/tokens' },
      ],
    },
  ];

  const { view } = useGlobalSearchParams<{ view?: string }>();

  const isActive = (route: string, itemView?: string) => {
    if (route === '/') return pathname === '/';
    if (itemView) return pathname === route && view === itemView;
    return pathname?.startsWith(route) ?? false;
  };

  const navigate = (route: string, itemView?: string) => {
    if (itemView) {
      router.navigate({ pathname: route as any, params: { view: itemView } } as any);
    } else {
      router.navigate(route as any);
    }
    if (!persistent) onClose();
  };

  const renderContent = () => (
    <>
      <View style={[s.sidebarHeader, { borderBottomColor: theme.colors.border }]}>
        <Text style={[s.logoText, { color: theme.colors.text.primary }]}>{t('sidebar.bigt')}</Text>
        {!persistent && (
          <TouchableOpacity onPress={onClose} style={s.closeBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="button" accessibilityLabel={t('common.cancel')}>
            <CloseIcon size={20} color={theme.colors.text.secondary} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView style={s.navScroll} showsVerticalScrollIndicator={false}>
        {navSections.map((section) => (
          <View key={section.titleKey} style={s.section}>
            <Text style={[s.sectionTitle, { color: theme.colors.text.secondary }]}>{t(section.titleKey)}</Text>
            {section.items.map((item) => (
              <NavItemRow
                key={item.key}
                item={item}
                isActive={isActive(item.route, item.view)}
                onPress={() => navigate(item.route, item.view)}
              />
            ))}
          </View>
        ))}
      </ScrollView>

      <View style={[s.quickActions, { borderTopColor: theme.colors.border }]}>
        <TouchableOpacity
          style={[s.buyBtn, { backgroundColor: theme.colors.accent?.emerald || '#0ECB81' }]}
          onPress={() => navigate('/order', 'exchange')}
          activeOpacity={0.8}
        >
          <Text style={s.actionBtnText}>{t('sidebar.buy')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[s.sellBtn, { backgroundColor: theme.colors.accent?.red || '#F6465D' }]}
          onPress={() => navigate('/order', 'exchange')}
          activeOpacity={0.8}
        >
          <Text style={s.actionBtnText}>{t('sidebar.sell')}</Text>
        </TouchableOpacity>
      </View>

      <View style={[s.footer, { borderTopColor: theme.colors.border }]}>
        <View style={s.langRow}><LanguageSwitcher /></View>
        <TouchableOpacity
          style={s.settingsRow}
          onPress={() => navigate('/settings')}
          activeOpacity={0.6}
        >
          <SettingsIcon size={16} color={theme.colors.text.secondary} />
          <Text style={[s.settingsText, { color: theme.colors.text.secondary }]}>{t('sidebar.settings')}</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  if (persistent) {
    return (
      <View style={[s.persistent, { backgroundColor: theme.colors.groupped.surface, borderRightColor: theme.colors.border, paddingTop: insets.top }]}>
        {renderContent()}
      </View>
    );
  }

  if (!visible) return null;

  return (
    <>
      <View style={s.overlay}>
        <TouchableOpacity style={StyleSheet.absoluteFill} onPress={onClose} activeOpacity={1} />
      </View>
      <View style={[s.overlaySidebar, { backgroundColor: theme.colors.groupped.surface, borderRightColor: theme.colors.border, paddingTop: insets.top }]}>
        {renderContent()}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', zIndex: 998 },
  overlaySidebar: {
    position: 'absolute', top: 0, left: 0, bottom: 0, width: SIDEBAR_WIDTH, zIndex: 999,
    borderRightWidth: 1,
  },
  persistent: {
    width: SIDEBAR_WIDTH, borderRightWidth: 1,
  },
  sidebarHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1,
  },
  logoText: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  closeBtn: { padding: 6 },
  navScroll: { flex: 1, paddingVertical: 8 },
  section: { marginBottom: 4 },
  sectionTitle: {
    fontSize: 11, fontWeight: '700', letterSpacing: 0.8,
    paddingHorizontal: 20, paddingVertical: 10, paddingTop: 14,
    textTransform: 'uppercase',
  },
  navItem: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 10, marginHorizontal: 8,
    marginVertical: 1, borderRadius: 8, gap: 12, overflow: 'hidden',
  },
  activeDot: {
    position: 'absolute', left: 0, top: 4, bottom: 4, width: 3,
    borderTopRightRadius: 2, borderBottomRightRadius: 2,
  },
  navLabel: { fontSize: 14, fontWeight: '500' },
  quickActions: {
    flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12, borderTopWidth: 1,
  },
  buyBtn: {
    flex: 1, borderRadius: 6, paddingVertical: 10, alignItems: 'center',
  },
  sellBtn: {
    flex: 1, borderRadius: 6, paddingVertical: 10, alignItems: 'center',
  },
  actionBtnText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600' },
  footer: {
    borderTopWidth: 1, paddingVertical: 10, paddingHorizontal: 16,
  },
  langRow: { marginBottom: 6 },
  settingsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 6, paddingHorizontal: 4,
  },
  settingsText: { fontSize: 13, fontWeight: '500' },
});
