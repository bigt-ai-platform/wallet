import * as React from 'react';
import {
  listSystemMessages,
  subscribeSystemMessageChanges,
  unreadSystemMessageCount,
} from '@/services/systemMessages';

/** Stored notification history + unread count, refreshed on any change. */
export function useSystemNotifications() {
  const [state, setState] = React.useState(() => ({
    messages: listSystemMessages(),
    unread: unreadSystemMessageCount(),
  }));

  React.useEffect(() => subscribeSystemMessageChanges(() => {
    setState({
      messages: listSystemMessages(),
      unread: unreadSystemMessageCount(),
    });
  }), []);

  return state;
}
