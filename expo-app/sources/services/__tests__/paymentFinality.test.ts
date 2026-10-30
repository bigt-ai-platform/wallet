import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    getTransactionStatus: vi.fn(),
    getTransactionStatusOnChain: vi.fn(),
    getOrdersByAddress: vi.fn(),
    notifySystemMessage: vi.fn(),
  };
});

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

vi.mock('../http', () => ({
  httpService: {
    getTransactionStatus: mocks.getTransactionStatus,
    getTransactionStatusOnChain: mocks.getTransactionStatusOnChain,
    getOrdersByAddress: mocks.getOrdersByAddress,
  },
}));

vi.mock('../systemMessages', () => ({
  notifySystemMessage: mocks.notifySystemMessage,
}));

vi.mock('@/lib/i18n', () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  },
}));

import { recordOrder, recordPayment, refreshPendingOrders, refreshPendingPayments } from '../tracking';

describe('payment finality notifications', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.notifySystemMessage.mockClear();
    mocks.getTransactionStatus.mockReset();
    mocks.getOrdersByAddress.mockResolvedValue({ success: true, data: [] });
  });

  it('notifies once when a pending payment reaches CONFIRMED', async () => {
    recordPayment({
      txHash: 'a'.repeat(64),
      tokenId: 'bc',
      tokenName: 'BIG',
      amount: '1',
      decimals: 6,
      fromAddress: 'from',
      toAddress: 'to',
      layer: 0,
    });
    mocks.getTransactionStatus.mockResolvedValue({
      success: true,
      data: { status: 'CONFIRMED' },
    });

    await refreshPendingPayments();
    await refreshPendingPayments();

    expect(mocks.notifySystemMessage).toHaveBeenCalledTimes(1);
    expect(mocks.notifySystemMessage).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'success',
      title: expect.stringContaining('system.paymentFinalizedTitle'),
      body: expect.stringContaining('system.paymentFinalizedBody'),
    }));
  });

  it('raises an error message when the chain drops a payment', async () => {
    recordPayment({
      txHash: 'b'.repeat(64),
      tokenId: 'bc',
      tokenName: 'BIG',
      amount: '2',
      decimals: 6,
      fromAddress: 'from',
      toAddress: 'to',
      layer: 0,
    });
    mocks.getTransactionStatus.mockResolvedValue({
      success: true,
      data: { status: 'DROPPED' },
    });

    await refreshPendingPayments();

    expect(mocks.notifySystemMessage).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'error',
      title: expect.stringContaining('system.paymentFailedTitle'),
    }));
  });

  it('notifies when a tracked order is no longer in the open book', async () => {
    recordOrder({
      side: 'buy',
      tokenId: 'nvidia',
      tokenName: 'Nvidia',
      baseToken: 'usdt',
      price: '234.75',
      amount: '1',
      decimals: 6,
      fromAddress: 'from',
    });
    mocks.getOrdersByAddress.mockResolvedValue({ success: true, data: [] });

    await refreshPendingOrders('from');

    expect(mocks.notifySystemMessage).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'success',
      title: expect.stringContaining('system.orderFilledTitle'),
      body: expect.stringContaining('system.orderFilledBody'),
    }));
  });
});
