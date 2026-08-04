import * as React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

interface TabItem {
  key: string;
  label: string;
}

interface SegmentedTabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
}

export default function SegmentedTabs({ tabs, active, onChange }: SegmentedTabsProps) {
  return (
    <View style={s.tabRow}>
      {tabs.map((tab) => (
        <TouchableOpacity
          key={tab.key}
          style={[s.tab, active === tab.key && s.tabActive]}
          onPress={() => onChange(tab.key)}
          accessibilityRole="tab"
          accessibilityState={{ selected: active === tab.key }}
          accessibilityLabel={tab.label}
        >
          <Text style={[s.tabText, active === tab.key && s.tabTextActive]}>{tab.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const s = StyleSheet.create((theme) => ({
  tabRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 12, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: theme.colors.groupped.surface },
  tabActive: { backgroundColor: theme.colors.primary },
  tabText: { fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary },
  tabTextActive: { color: '#FFFFFF' },
}));
