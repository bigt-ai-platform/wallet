import * as React from 'react';
import { View, Text, TouchableOpacity, type TextStyle, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUnistyles } from 'react-native-unistyles';
import { useTranslation } from 'react-i18next';
import {
  markSystemMessagesRead,
  subscribeSystemMessages,
  type SystemMessage,
} from '@/services/systemMessages';

/**
 * Page-level banner for chain/system notifications. Mounted once by the root
 * layout, so a payment-finality event is visible on any screen. Messages queue
 * and auto-dismiss; errors stay until dismissed.
 */
export default function SystemMessageHost() {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [queue, setQueue] = React.useState<SystemMessage[]>([]);
  const current = queue[0];

  React.useEffect(() => subscribeSystemMessages((message) => {
    setQueue((prev) => [...prev, message]);
  }), []);

  const dismiss = React.useCallback((id: string, markRead = false) => {
    if (markRead) markSystemMessagesRead([id]);
    setQueue((prev) => prev.filter((m) => m.id !== id));
  }, []);

  React.useEffect(() => {
    if (!current || current.tone === 'error') return undefined;
    const ttl = current.ttlMs ?? 8000;
    if (ttl <= 0) return undefined;
    const timer = setTimeout(() => dismiss(current.id), ttl);
    return () => clearTimeout(timer);
  }, [current, dismiss]);

  if (!current) return null;

  const accent = current.tone === 'success'
    ? theme.colors.positive
    : current.tone === 'error'
      ? theme.colors.negative
      : theme.colors.primary;

  return (
    <View
      pointerEvents="box-none"
      style={[hostStyle, { top: insets.top + 10 }]}
      testID="system-message-host"
    >
      <View
        style={[cardStyle, {
          borderLeftColor: accent,
          backgroundColor: theme.colors.card?.background ?? theme.colors.groupped.surface,
          borderColor: theme.colors.border,
        }]}
        testID="system-message"
      >
        <View style={[dotStyle, { backgroundColor: accent }]} />
        <View style={copyStyle}>
          <Text style={[titleStyle, { color: theme.colors.text.primary }]} testID="system-message-title">
            {current.title}
          </Text>
          {!!current.body && (
            <Text style={[bodyStyle, { color: theme.colors.text.secondary }]} testID="system-message-body">
              {current.body}
            </Text>
          )}
        </View>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t('system.dismiss')}
          onPress={() => dismiss(current.id, true)}
          style={closeStyle}
          testID="system-message-dismiss"
        >
          <Text style={[closeTextStyle, { color: theme.colors.text.secondary }]}>×</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const hostStyle: ViewStyle = {
  position: 'absolute',
  left: 16,
  right: 16,
  alignItems: 'center',
  zIndex: 10000,
};

const cardStyle: ViewStyle = {
  width: '100%',
  maxWidth: 560,
  flexDirection: 'row',
  alignItems: 'flex-start',
  gap: 10,
  borderWidth: 1,
  borderLeftWidth: 4,
  borderRadius: 10,
  paddingVertical: 12,
  paddingHorizontal: 14,
  shadowColor: '#000',
  shadowOpacity: 0.12,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 4 },
  elevation: 6,
};

const dotStyle: ViewStyle = { width: 8, height: 8, borderRadius: 4, marginTop: 5 };
const copyStyle: ViewStyle = { flex: 1, minWidth: 0 };
const titleStyle: TextStyle = { fontSize: 14, fontWeight: '700' };
const bodyStyle: TextStyle = { fontSize: 12, lineHeight: 17, marginTop: 3 };
const closeStyle: ViewStyle = { paddingHorizontal: 4, paddingVertical: 0 };
const closeTextStyle: TextStyle = { fontSize: 22, lineHeight: 22, fontWeight: '400' };
