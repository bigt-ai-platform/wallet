import type { PredictionEvent, PredictionPosition, PredictionState } from '@/services/prediction';

export const PREDICTION_FILTERS = ['all', 'open', 'resolving', 'final', 'mine'] as const;
export type PredictionFilter = typeof PREDICTION_FILTERS[number];

export function hasPredictionPosition(event: PredictionEvent, position?: PredictionPosition): boolean {
  return !!position && (position.redeemable > 0n || event.outcomes.some((outcome) => (position.shares[outcome] ?? 0n) > 0n));
}

export function filterPredictionEvents(
  events: readonly PredictionEvent[],
  states: Readonly<Record<string, PredictionState | null>>,
  positions: Readonly<Record<string, PredictionPosition>>,
  filter: PredictionFilter,
  query: string,
): PredictionEvent[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return events.filter((event) => {
    const state = states[event.contractTokenid];
    const status = state?.initialized ? state.status : null;
    if (filter === 'open' && status !== 'OPEN') return false;
    if (filter === 'resolving' && status !== 'PENDING' && status !== 'VOTING') return false;
    if (filter === 'final' && status !== 'FINAL') return false;
    if (filter === 'mine' && !hasPredictionPosition(event, positions[event.contractTokenid])) return false;
    const text = [
      event.question, event.contractTokenid, event.collateralTokenid,
      event.collateralTokenid === 'bc' ? 'BIG' : '', ...event.outcomeNames,
    ].join(' ').toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}
