import * as React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useUnistyles } from 'react-native-unistyles';
import { BellIcon } from '@/components/Icons';
import { useSystemNotifications } from '@/lib/useSystemNotifications';
import { clearSystemMessages, markSystemMessagesRead } from '@/services/systemMessages';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Full persisted notification history. Opening it clears the unread badge. */
export default function NotificationsScreen() {
  const { t } = useTranslation();
  const { theme } = useUnistyles();
  const { messages } = useSystemNotifications();

  React.useEffect(() => {
    markSystemMessagesRead();
  }, []);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.groupped.background }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      testID="notifications-screen"
    >
      {messages.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: 64, gap: 10 }} testID="notifications-empty">
          <BellIcon size={34} color={theme.colors.text.secondary} />
          <Text style={{ fontSize: 14, fontWeight: '600', color: theme.colors.text.secondary }}>
            {t('notifications.empty')}
          </Text>
        </View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ fontSize: 13, color: theme.colors.text.secondary }}>
              {t('notifications.count', { count: messages.length })}
            </Text>
            <TouchableOpacity
              onPress={() => clearSystemMessages()}
              accessibilityRole="button"
              testID="notifications-clear"
            >
              <Text style={{ fontSize: 12, fontWeight: '600', color: theme.colors.accent.red }}>
                {t('notifications.clearAll')}
              </Text>
            </TouchableOpacity>
          </View>

          {messages.map((message) => {
            const tone = message.tone === 'success'
              ? theme.colors.positive
              : message.tone === 'error'
                ? theme.colors.negative
                : theme.colors.primary;
            return (
              <View
                key={message.id}
                style={{
                  backgroundColor: theme.colors.groupped.surface,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  borderLeftWidth: 4,
                  borderLeftColor: tone,
                  borderRadius: 10,
                  padding: 13,
                  marginBottom: 10,
                }}
                testID={`notification-row-${message.id}`}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 10 }}>
                  <Text style={{ flex: 1, fontSize: 14, fontWeight: message.read ? '600' : '700', color: theme.colors.text.primary }}>
                    {message.title}
                  </Text>
                  <Text style={{ fontSize: 10, color: theme.colors.text.secondary, marginTop: 2 }}>
                    {fmtTime(message.createdAt)}
                  </Text>
                </View>
                {!!message.body && (
                  <Text style={{ fontSize: 12, lineHeight: 17, marginTop: 4, color: theme.colors.text.secondary }}>
                    {message.body}
                  </Text>
                )}
              </View>
            );
          })}
        </>
      )}
    </ScrollView>
  );
}
