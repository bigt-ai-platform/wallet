import { describe, expect, it } from 'vitest';
import {
  applyStatus,
  inFlight,
  isTerminal,
  prune,
  trackOperation,
  type TrackedExternalOp,
} from '../externalNotifications';

const op = (over: Partial<TrackedExternalOp> = {}): TrackedExternalOp => ({
  id: 'op1',
  assetId: 'hkd',
  symbol: 'HKD',
  amount: '10',
  status: 'pending',
  createdAt: 1000,
  ...over,
});

describe('tracking list', () => {
  it('prepends and de-duplicates by id', () => {
    const first = trackOperation([], op());
    const second = trackOperation(first, op({ status: 'processing' }));
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe('processing');
  });

  it('caps the list', () => {
    let list: TrackedExternalOp[] = [];
    for (let i = 0; i < 60; i += 1) list = trackOperation(list, op({ id: `op${i}` }));
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe('op59');
  });
});

describe('status transitions', () => {
  it('notifies only on the move into a terminal state', () => {
    const pending = [op()];
    const processing = applyStatus(pending, 'op1', 'processing');
    expect(processing.notify).toBe(false);
    const done = applyStatus(processing.list, 'op1', 'completed');
    expect(done.notify).toBe(true);
    expect(done.list[0].status).toBe('completed');
  });

  it('never notifies twice for the same terminal state', () => {
    const done = [{ ...op(), status: 'completed' as const }];
    expect(applyStatus(done, 'op1', 'completed').notify).toBe(false);
    // a terminal state cannot flip to another terminal state
    expect(applyStatus(done, 'op1', 'failed').notify).toBe(false);
  });

  it('treats failed as a notifiable terminal state', () => {
    expect(applyStatus([op()], 'op1', 'failed').notify).toBe(true);
  });

  it('ignores an unknown id', () => {
    const result = applyStatus([op()], 'nope', 'completed');
    expect(result.notify).toBe(false);
    expect(result.list).toHaveLength(1);
  });
});

describe('terminal and pruning', () => {
  it('classifies terminal states', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('processing')).toBe(false);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });

  it('returns only in-flight operations to poll', () => {
    const list = [op({ id: 'a' }), op({ id: 'b', status: 'completed' }), op({ id: 'c', status: 'processing' })];
    expect(inFlight(list).map((o) => o.id)).toEqual(['a', 'c']);
  });

  it('prunes old terminal rows but keeps in-flight ones', () => {
    const day = 24 * 60 * 60 * 1000;
    const list = [
      op({ id: 'old-done', status: 'completed', createdAt: 0 }),
      op({ id: 'new-done', status: 'completed', createdAt: 6 * day }),
      op({ id: 'stuck', status: 'pending', createdAt: 0 }),
    ];
    const kept = prune(list, 7 * day);
    expect(kept.map((o) => o.id)).toEqual(['new-done', 'stuck']);
  });
});
