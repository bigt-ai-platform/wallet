/**
 * Polls in-flight external operations and raises one system message per
 * terminal transition.
 *
 * The distributor screen already shows the statement; this exists so a transfer
 * submitted before the user locked the phone still reports back. State is in the
 * device KV, so a restart resumes rather than re-notifying.
 */

import { device } from '@/storage';
import i18n from '@/lib/i18n';
import {
  applyStatus,
  inFlight,
  prune,
  trackOperation,
  type ExternalOperationStatus,
  type TrackedExternalOp,
} from '@/lib/externalNotifications';
import { getExternalOperation } from './distributor';
import { notifySystemMessage } from './systemMessages';

const STORAGE_KEY: string[] = ['external', 'ops'];
/** At most this many notices per tick; the rest just update state. */
const MAX_NOTICES = 3;

export function listTrackedExternalOps(): TrackedExternalOp[] {
  const raw = device.get(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is TrackedExternalOp => {
      const row = entry as Partial<TrackedExternalOp> | null;
      return !!row && typeof row.id === 'string' && typeof row.amount === 'string'
        && typeof row.symbol === 'string' && typeof row.createdAt === 'number'
        && (row.status === 'pending' || row.status === 'processing'
          || row.status === 'completed' || row.status === 'failed');
    });
  } catch {
    return [];
  }
}

function write(ops: TrackedExternalOp[]): void {
  device.set(STORAGE_KEY, JSON.stringify(ops.slice(0, 50)));
}

/** Record a just-submitted operation so the watcher follows it. */
export function trackExternalOperation(input: {
  id: string;
  assetId: string;
  symbol: string;
  amount: string;
  status?: ExternalOperationStatus;
  now?: number;
}): void {
  const op: TrackedExternalOp = {
    id: input.id,
    assetId: input.assetId,
    symbol: input.symbol,
    amount: input.amount,
    status: input.status ?? 'pending',
    createdAt: input.now ?? Date.now(),
  };
  write(trackOperation(listTrackedExternalOps(), op));
}

/**
 * One poll pass. Returns the number of notifications raised. A failed lookup
 * (issuer down, 404) leaves the operation pending rather than inventing a state.
 */
export async function pollExternalOperations(
  now: () => number = () => Date.now(),
  notify: typeof notifySystemMessage = notifySystemMessage,
): Promise<number> {
  let ops = listTrackedExternalOps();
  if (ops.length === 0) return 0;

  let notices = 0;
  for (const op of inFlight(ops)) {
    let status: ExternalOperationStatus;
    try {
      status = (await getExternalOperation(op.id)).status;
    } catch {
      continue;
    }
    const applied = applyStatus(ops, op.id, status);
    ops = applied.list;
    if (applied.notify && notices < MAX_NOTICES) {
      notices += 1;
      const completed = status === 'completed';
      notify({
        tone: completed ? 'success' : 'error',
        title: i18n.t(completed ? 'system.externalCompletedTitle' : 'system.externalFailedTitle'),
        body: i18n.t(completed ? 'system.externalCompletedBody' : 'system.externalFailedBody', {
          amount: op.amount,
          symbol: op.symbol,
          id: op.id,
        }),
      });
    }
  }

  write(prune(ops, now()));
  return notices;
}
