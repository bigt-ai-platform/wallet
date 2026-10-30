import * as React from 'react';
import {
  listOrders,
  listPayments,
  refreshPendingOrders,
  refreshPendingPayments,
} from '@/services/tracking';

const POLL_MS = 15000;

/**
 * App-wide chain lifecycle watcher. The Payments/Orders tabs have their own
 * fast polls while open; this one keeps watching after the user navigates away
 * so a finality event can raise a system message on any page.
 *
 * It only touches the network when a locally tracked payment or order is still
 * pending.
 */
export default function ChainEventWatcher() {
  React.useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const tick = async () => {
      if (disposed || inFlight) return;
      const pendingPayments = listPayments().some((p) => p.status === 'pending');
      const pendingOrders = listOrders().filter((o) => o.status === 'pending');
      if (!pendingPayments && pendingOrders.length === 0) return;

      inFlight = true;
      try {
        if (pendingPayments) await refreshPendingPayments();
        const orderAddress = pendingOrders[0]?.fromAddress;
        if (orderAddress) await refreshPendingOrders(orderAddress);
      } catch {
        // Best-effort; the next tick retries.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return null;
}
