import * as React from 'react';
import { useWallet } from '@/state/wallet';
import { p2pIdentityFromWallet } from '@/lib/p2pIdentity';
import { mySwaps, p2pConfigured, type P2pIdentity, type P2pSwapStatus } from '@/services/p2p';
import { notifySystemMessage } from '@/services/systemMessages';
import { railLabel } from '@/lib/p2pRails';
import i18n from '@/lib/i18n';

const POLL_MS = 30000;
const seen = new Map<string, P2pSwapStatus>();
/** Matched swaps already surfaced as "fund the escrow" this session. */
const matchNotified = new Set<string>();

function toneFor(status: P2pSwapStatus): 'info' | 'success' | 'error' {
  if (status === 'COMPLETED' || status === 'ESCROW_RELEASED' || status === 'PAYMENT_VERIFIED') return 'success';
  if (status === 'EXPIRED' || status === 'ESCROW_REFUNDED' || status === 'CANCELLED') return 'error';
  return 'info';
}

/**
 * Polls the party-scoped P2P swap list while the wallet is unlocked and raises
 * a page message whenever a swap advances (matched, paid, verified, released,
 * completed, refunded …). The first poll only seeds the baseline.
 *
 * A match is special for the seller: the token giver must fund the escrow
 * before the buyer sees payment instructions, so an unfunded MATCHED swap the
 * wallet sells into gets an explicit, actionable notice — even on the first
 * poll, so a match that happened while the app was closed is not missed.
 * Legacy EC wallets are supported (their P2P identity is derived from the
 * same secret, exactly like the P2P screen).
 */
export default function P2pEventWatcher() {
  const { isUnlocked, getUnlockedWallet } = useWallet();
  const keyHex = isUnlocked ? getUnlockedWallet()?.wallet.privateKey : undefined;
  const keyType = getUnlockedWallet()?.wallet.keyType;

  const identity = React.useMemo<P2pIdentity | null>(
    () => (keyHex ? p2pIdentityFromWallet(keyHex, keyType) : null),
    [keyHex, keyType],
  );

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
          // Seller's actionable match: fund the escrow, whatever the baseline.
          if (
            swap.status === 'MATCHED' &&
            swap.sellerDid === identity.did &&
            !matchNotified.has(swap.swapId)
          ) {
            matchNotified.add(swap.swapId);
            notifySystemMessage({
              tone: 'info',
              title: i18n.t('system.p2pFundEscrowTitle'),
              body: i18n.t('system.p2pFundEscrowBody', {
                amount: swap.giveAmount ?? '',
                token: swap.giveToken ?? '',
              }),
            });
            continue;
          }
          if (!seeded || previous === undefined || previous === swap.status) continue;
          // The seller already got the action-specific notice above.
          if (swap.status === 'MATCHED' && swap.sellerDid === identity.did) continue;
          // Buyer marked "I have paid": the seller must check the rail and
          // confirm — a generic "status changed" is not actionable enough.
          if (swap.status === 'PAYMENT_CLAIMED' && swap.sellerDid === identity.did) {
            notifySystemMessage({
              tone: 'info',
              title: i18n.t('system.p2pPaidTitle'),
              body: i18n.t('system.p2pPaidBody', {
                id: swap.swapId.slice(0, 12),
                amount: swap.wantAmount ?? '',
                currency: swap.wantCurrency ?? '',
                rail: railLabel(i18n.t, swap.wantRail ?? ''),
              }),
            });
            continue;
          }
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
