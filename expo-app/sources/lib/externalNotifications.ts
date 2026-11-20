/**
 * Tracking for external (distributor) operations.
 *
 * Pure list logic: the watcher only needs to know which submitted operations are
 * still in flight, and when one reaches a terminal state exactly once — so a
 * restart or a repeated poll cannot notify twice.
 */

export type ExternalOperationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface TrackedExternalOp {
  id: string;
  assetId: string;
  symbol: string;
  /** Display amount, as submitted. */
  amount: string;
  status: ExternalOperationStatus;
  createdAt: number;
}

export const MAX_TRACKED = 50;

export function isTerminal(status: ExternalOperationStatus): boolean {
  return status === 'completed' || status === 'failed';
}

/** Add or replace an operation; newest first, capped. */
export function trackOperation(
  list: TrackedExternalOp[],
  op: TrackedExternalOp,
): TrackedExternalOp[] {
  const next = [op, ...list.filter((entry) => entry.id !== op.id)];
  return next.slice(0, MAX_TRACKED);
}

/**
 * Apply a polled status. Returns the new list and whether this transition should
 * raise exactly one notification: only the move **into** a terminal state.
 */
export function applyStatus(
  list: TrackedExternalOp[],
  id: string,
  status: ExternalOperationStatus,
): { list: TrackedExternalOp[]; notify: boolean } {
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) return { list, notify: false };
  const current = list[index];
  if (current.status === status) return { list, notify: false };
  const next = list.slice();
  next[index] = { ...current, status };
  return { list: next, notify: !isTerminal(current.status) && isTerminal(status) };
}

/** Operations the watcher still has to poll. */
export function inFlight(list: TrackedExternalOp[]): TrackedExternalOp[] {
  return list.filter((entry) => !isTerminal(entry.status));
}

/** Drop terminal operations older than `maxAgeMs` (default 7 days). */
export function prune(
  list: TrackedExternalOp[],
  now: number,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
): TrackedExternalOp[] {
  return list.filter((entry) => !isTerminal(entry.status) || now - entry.createdAt < maxAgeMs);
}
