import { describe, it, expect } from 'vitest';
import type { P2pOrder } from '@/services/p2p';
import { filterP2pOrders } from '../p2pOrderBook';

const sell: P2pOrder = {
  orderId: 'sell', type: 'limit_sell', sellerDid: 'did:pq:alice',
  giveToken: 'USDT', giveAmount: '100', giveChain: 'L0',
  wantCurrency: 'CNY', wantAmount: '700', wantRail: 'wechat',
  status: 'ACTIVE', validUntil: 2000000000, createdAt: 1,
};
const buy: P2pOrder = { ...sell, orderId: 'buy', type: 'limit_buy' };

describe('filterP2pOrders', () => {
  it('shows sell ads to buyers and buy ads to sellers', () => {
    expect(filterP2pOrders([sell, buy], 'buy', '')).toEqual([sell]);
    expect(filterP2pOrders([sell, buy], 'sell', 'USDT')).toEqual([buy]);
  });

  it('ignores case and extra whitespace across multiple search fields', () => {
    expect(filterP2pOrders([sell], 'buy', '  usdt  CnY\nL0 alice ')).toEqual([sell]);
    expect(filterP2pOrders([sell], 'buy', 'USDT EUR')).toEqual([]);
  });

  it('uses all enabled rails and supports legacy single-rail ads', () => {
    const multiRail = { ...sell, wantRails: ['wechat', 'alipay'] };
    expect(filterP2pOrders([multiRail], 'buy', 'alipay')).toEqual([multiRail]);
    expect(filterP2pOrders([sell], 'buy', 'wechat')).toEqual([sell]);
    expect(filterP2pOrders([{ ...sell, wantRails: [] }], 'buy', 'wechat')).toHaveLength(1);
    expect(filterP2pOrders([sell], 'buy', 'alipay')).toEqual([]);
  });

  it('preserves source order and leaves the input untouched', () => {
    const second = { ...sell, orderId: 'second' };
    const orders = Object.freeze([second, sell, buy]);
    expect(filterP2pOrders(orders, 'buy', ' ')).toEqual([second, sell]);
    expect(orders).toEqual([second, sell, buy]);
  });
});