import * as React from 'react';
import { useWallet } from '@/state/wallet';
import { pqDidFromKey, pqKeyFromPrivateHex } from '@/lib/p2pIdentity';
import { mySwaps, p2pConfigured, type P2pIdentity, type P2pSwapStatus } from '@/services/p2p';
import { notifySystemMessage } from '@/services/systemMessages';
import i18n from '@/lib/i18n';

const POLL_MS = 30000;
const seen = new Map<string, P2pSwapStatus>();

function toneFor(status: P2pSwapStatus): 'info' | 'success' | 'error' {
  if (status === 'COMPLETED' || status === 'ESCROW_RELEASED' || status === 'PAYMENT_VERIFIED') return 'success';
  if (status === 'EXPIRED' || status === 'ESCROW_REFUNDED' || status === 'CANCELLED') return 'error';
  return 'info';
}

/**
 * Polls the party-scoped P2P swap list while the wallet is unlocked and raises
 * a page message whenever a swap advances (matched, paid, verified, released,
 * completed, refunded …). The first poll only seeds the baseline.
 */
export default function P2pEventWatcher() {
  const { isUnlocked, getUnlockedWallet } = useWallet();
  const keyHex = isUnlocked ? getUnlockedWallet()?.wallet.privateKey : undefined;
  const keyType = getUnlockedWallet()?.wallet.keyType;

  const identity = React.useMemo<P2pIdentity | null>(() => {
    if (!keyHex || keyType === 'EC') return null;
    try {
      const key = pqKeyFromPrivateHex(keyHex);
      return { key, did: pqDidFromKey(key) };
    } catch {
      return null;
    }
  }, [keyHex, keyType]);

  React.useEffect(() => {
    if (!identity || !p2pConfigured()) return undefined;
    let disposed = false;
    let inFlight = false;
    let seeded = false;

    const tick = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const swaps = await mySwaps(identity);
        if (disposed) return;
        for (const swap of swaps) {
          const previous = seen.get(swap.swapId);
          seen.set(swap.swapId, swap.status);
          if (!seeded || previous === undefined || previous === swap.status) continue;
          notifySystemMessage({
            tone: toneFor(swap.status),
            title: i18n.t('system.p2pUpdateTitle'),
            body: i18n.t('system.p2pUpdateBody', {
              id: swap.swapId.slice(0, 12),
              status: swap.status,
            }),
          });
        }
        seeded = true;
      } catch {
        // Engine unreachable; keep the previous baseline and retry.
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
  }, [identity]);

  return null;
}
