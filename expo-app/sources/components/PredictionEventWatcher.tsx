import * as React from 'react';
import { useWallet } from '@/state/wallet';
import { getPositions, type PredictionPosition } from '@/services/prediction';
import { notifySystemMessage } from '@/services/systemMessages';
import i18n from '@/lib/i18n';

const POLL_MS = 60000;
const seen = new Map<string, string>();

function outcomeLabel(pos: PredictionPosition): string {
  const state = pos.state;
  if (!state?.outcome) return '';
  if (state.outcome === 'invalid') return 'invalid';
  const idx = pos.event.outcomes.indexOf(state.outcome);
  return pos.event.outcomeNames[idx] || state.outcome;
}

function hasPosition(pos: PredictionPosition): boolean {
  return Object.values(pos.shares).some((amount) => amount > 0n);
}

/**
 * Watches prediction markets the unlocked wallet holds a position in. A market
 * moving to PENDING / VOTING / FINAL raises the same page message used for
 * payment finality; the first poll only seeds the baseline.
 */
export default function PredictionEventWatcher() {
  const { isUnlocked, getUnlockedWallet } = useWallet();
  const wallet = isUnlocked ? getUnlockedWallet() : undefined;
  const privateKey = wallet?.wallet.privateKey;
  const keyType = wallet?.wallet.keyType;

  React.useEffect(() => {
    if (!privateKey) return undefined;
    let disposed = false;
    let inFlight = false;
    let seeded = false;

    const tick = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const positions = await getPositions(privateKey, keyType);
        if (disposed) return;
        for (const pos of positions) {
          if (!hasPosition(pos)) continue;
          const status = pos.state?.status;
          if (!status) continue;
          const key = pos.event.contractTokenid;
          const previous = seen.get(key);
          seen.set(key, status);
          if (!seeded || previous === undefined || previous === status) continue;

          if (status === 'FINAL') {
            notifySystemMessage({
              tone: 'success',
              title: i18n.t('system.predictionFinalTitle'),
              body: i18n.t('system.predictionFinalBody', {
                question: pos.event.question,
                outcome: outcomeLabel(pos),
              }),
            });
          } else {
            notifySystemMessage({
              tone: 'info',
              title: i18n.t('system.predictionUpdateTitle'),
              body: i18n.t('system.predictionUpdateBody', {
                question: pos.event.question,
                status,
              }),
            });
          }
        }
        seeded = true;
      } catch {
        // Prediction chain unavailable; retry on the next tick.
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
  }, [privateKey, keyType]);

  return null;
}
