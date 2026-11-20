import * as React from 'react';
import { AppState } from 'react-native';
import { useWallet } from '@/state/wallet';
import { isDistributorConfigured } from '@/services/distributor';
import { pollExternalOperations } from '@/services/externalOps';

const POLL_MS = 25000;

/**
 * App-wide watcher for external (distributor) operations.
 *
 * The asset screen shows the statement live; this only exists so an operation
 * submitted before the app was backgrounded still reports a terminal state. It
 * is inert (no network, no storage) unless a distributor is configured.
 */
export default function ExternalAssetWatcher() {
  const { publicInfo } = useWallet();
  const walletAddress = publicInfo?.address ?? '';

  React.useEffect(() => {
    if (!walletAddress || !isDistributorConfigured()) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        await pollExternalOperations();
      } catch {
        /* issuer unreachable: keep the operation pending and retry next tick */
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void tick();
    });

    return () => {
      cancelled = true;
      clearInterval(timer);
      subscription.remove();
    };
  }, [walletAddress]);

  return null;
}
