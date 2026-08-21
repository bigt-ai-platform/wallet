import * as React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

/**
 * Unified badge for displaying which chain layer something belongs to.
 * layer 0     → "L0" (settlement, blue)
 * layer 1..N  → "L1" (order chain, purple), optionally with the chain name.
 */
export default function ChainBadge({ layer, name, size = 'sm' }: {
  layer: number;
  name?: string;
  size?: 'sm' | 'md';
}) {
  const { theme } = useUnistyles();
  const isL0 = layer === 0;
  const bg = isL0 ? theme.colors.accent.blue : theme.colors.accent.purple;
  const pad = size === 'md' ? { paddingHorizontal: 8, paddingVertical: 3 } : { paddingHorizontal: 6, paddingVertical: 1 };
  const font = size === 'md' ? 12 : 10;
  return (
    <View style={[styles.badge, pad, { backgroundColor: bg }]} testID={`chain-badge-${isL0 ? 'l0' : 'l1'}`}>
      <Text style={[styles.text, { fontSize: font }]}>
        {isL0 ? 'L0' : `L1${name ? ` · ${name}` : ''}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { borderRadius: 6, alignSelf: 'flex-start' },
  text: { color: '#FFFFFF', fontWeight: '700', letterSpacing: 0.3 },
});
