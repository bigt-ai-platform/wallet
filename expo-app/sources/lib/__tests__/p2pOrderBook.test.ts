import { describe, it, expect } from 'vitest';
import type { P2pOrder } from '@/services/p2p';
import { checkP2pFill, filterP2pOrders } from '../p2pOrderBook';

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

describe('checkP2pFill', () => {
  const partial = { ...sell, remainingGive: '25', minOrder: '70', maxOrder: '140' };

  it('defaults a blank fill to the remaining amount and prices it pro rata', () => {
    expect(checkP2pFill(sell, ' ')).toEqual({ ok: true, fill: '100', fiat: '700' });
    expect(checkP2pFill({ ...sell, remainingGive: '25' }, '')).toEqual({ ok: true, fill: '25', fiat: '175' });
    expect(checkP2pFill(partial, '12.5')).toEqual({ ok: true, fill: '12.5', fiat: '87.5' });
  });

  it('rejects malformed, zero and over-remaining amounts', () => {
    for (const bad of ['abc', '-1', '1e2', '0', '25.01']) {
      expect(checkP2pFill(partial, bad)).toEqual({ ok: false, reason: 'amount', limit: '25' });
    }
    expect(checkP2pFill(partial, '').ok).toBe(false);
  });

  it('enforces fiat minimum and maximum inclusively', () => {
    expect(checkP2pFill(partial, '9.99')).toEqual({ ok: false, reason: 'min', limit: '70' });
    expect(checkP2pFill(partial, '10').ok).toBe(true);
    expect(checkP2pFill(partial, '20').ok).toBe(true);
    expect(checkP2pFill({ ...partial, remainingGive: '50' }, '20.01')).toEqual({ ok: false, reason: 'max', limit: '140' });
  });

  it('uses the same eight-decimal fiat rounding for bids and sell ads', () => {
    const fractional = { ...sell, giveAmount: '3', wantAmount: '1' };
    expect(checkP2pFill(fractional, ' 1 ')).toEqual({ ok: true, fill: '1', fiat: '0.33333333' });
    expect(checkP2pFill({ ...fractional, type: 'limit_buy' }, '1')).toEqual(checkP2pFill(fractional, '1'));
  });

  it('rejects exhausted orders, non-finite calculations and rounded zero totals', () => {
    expect(checkP2pFill({ ...sell, remainingGive: '0' }, '').ok).toBe(false);
    expect(checkP2pFill({ ...sell, remainingGive: '9'.repeat(400) }, '9'.repeat(400)).ok).toBe(false);
    expect(checkP2pFill({ ...sell, wantAmount: '9'.repeat(400) }, '1').ok).toBe(false);
    expect(checkP2pFill(sell, '0.00000000001').ok).toBe(false);
  });
});