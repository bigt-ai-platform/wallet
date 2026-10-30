import * as React from 'react';
import { listPayments, refreshPendingPayments } from '@/services/tracking';

const POLL_MS = 15000;

/**
 * App-wide payment lifecycle watcher. The Payments tab has its own fast poll
 * while it is open; this one keeps watching after the user navigates away so a
 * chain-finality event can raise a system message on any page.
 *
 * It only touches the network when a locally tracked payment is still pending.
 */
export default function PaymentFinalityWatcher() {
  React.useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const tick = async () => {
      if (disposed || inFlight) return;
      if (!listPayments().some((p) => p.status === 'pending')) return;
      inFlight = true;
      try {
        await refreshPendingPayments();
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
