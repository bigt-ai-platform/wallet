import { describe, expect, it, vi } from 'vitest';
import { notifySystemMessage, subscribeSystemMessages } from '../systemMessages';

describe('system message bus', () => {
  it('delivers a message to every current subscriber', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeSystemMessages(a);
    const offB = subscribeSystemMessages(b);

    const msg = notifySystemMessage({
      tone: 'success',
      title: 'Payment finalized',
      body: '1 BIG reached chain finality.',
    });

    expect(a).toHaveBeenCalledWith(msg);
    expect(b).toHaveBeenCalledWith(msg);
    expect(msg.id).toMatch(/^sys_/);
    expect(msg.createdAt).toBeGreaterThan(0);

    offA();
    offB();
  });

  it('stops delivery after unsubscribe', () => {
    const listener = vi.fn();
    const off = subscribeSystemMessages(listener);
    off();

    notifySystemMessage({ tone: 'info', title: 'ignored' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps notifying other listeners when one throws', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const offBad = subscribeSystemMessages(bad);
    const offGood = subscribeSystemMessages(good);

    notifySystemMessage({ tone: 'error', title: 'Payment failed' });

    expect(good).toHaveBeenCalledTimes(1);
    offBad();
    offGood();
  });
});
