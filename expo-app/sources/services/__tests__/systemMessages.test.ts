import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

import {
  clearSystemMessages,
  listSystemMessages,
  markSystemMessagesRead,
  notifySystemMessage,
  subscribeSystemMessages,
  unreadSystemMessageCount,
} from '../systemMessages';

describe('system message bus', () => {
  beforeEach(() => {
    clearSystemMessages();
  });

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

  it('persists the newest message and tracks unread state', () => {
    notifySystemMessage({ tone: 'success', title: 'Order filled' });
    expect(listSystemMessages()).toHaveLength(1);
    expect(unreadSystemMessageCount()).toBe(1);

    const [message] = listSystemMessages();
    markSystemMessagesRead([message.id]);
    expect(unreadSystemMessageCount()).toBe(0);
    expect(listSystemMessages()[0].read).toBe(true);
  });

  it('clears the persisted centre', () => {
    notifySystemMessage({ tone: 'info', title: 'One' });
    notifySystemMessage({ tone: 'info', title: 'Two' });
    expect(listSystemMessages()).toHaveLength(2);

    clearSystemMessages();
    expect(listSystemMessages()).toHaveLength(0);
    expect(unreadSystemMessageCount()).toBe(0);
  });
});
