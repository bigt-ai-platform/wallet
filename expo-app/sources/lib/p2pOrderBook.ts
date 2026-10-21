import type { P2pOrder, P2pSwap } from '@/services/p2p';

export { checkP2pFill, type P2pFillCheck } from 'p2p-protocol';

const AMOUNT = /^\d+(\.\d+)?$/;
const ORDER_STATUSES = new Set(['ACTIVE', 'MATCHED', 'CANCELLED']);
const SWAP_STATUSES = new Set([
  'MATCHED', 'ESCROW_LOCKED', 'PAYMENT_PENDING', 'PAYMENT_CLAIMED', 'PAYMENT_VERIFIED',
  'ESCROW_RELEASED', 'COMPLETED', 'EXPIRED', 'ESCROW_REFUNDED', 'CANCELLED',
]);

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const amount = (v: unknown) => typeof v === 'string' && v.length <= 100 && AMOUNT.test(v);

function isOrder(o: unknown): o is P2pOrder {
  return record(o) && text(o.orderId) && (o.type === 'limit_sell' || o.type === 'limit_buy') &&
    text(o.sellerDid) && text(o.giveToken) && text(o.giveChain) && text(o.wantCurrency) && text(o.wantRail) &&
    amount(o.giveAmount) && amount(o.wantAmount) && Number.isFinite(o.validUntil) &&
    typeof o.status === 'string' && ORDER_STATUSES.has(o.status) &&
    (o.remainingGive === undefined || amount(o.remainingGive)) &&
    (o.minOrder === undefined || amount(o.minOrder)) && (o.maxOrder === undefined || amount(o.maxOrder));
}

function isSwap(s: unknown): s is P2pSwap {
  return record(s) && text(s.swapId) && Number.isInteger(s.seq) && typeof s.status === 'string' && SWAP_STATUSES.has(s.status);
}

/** Engine order book: drop malformed entries instead of rendering untrusted shapes. */
export function parseP2pOrders(data: unknown): P2pOrder[] {
  if (!record(data) || !Array.isArray(data.orders)) throw new Error('invalid p2p engine response');
  return data.orders.filter(isOrder);
}

export function parseP2pSwaps(data: unknown): P2pSwap[] {
  if (!record(data) || !Array.isArray(data.swaps) || !data.swaps.every(isSwap)) throw new Error('invalid p2p engine response');
  return data.swaps;
}

export function parseP2pSwap(data: unknown, swapId: string): P2pSwap {
  if (!record(data) || !isSwap(data.swap) || data.swap.swapId !== swapId) throw new Error('invalid p2p engine response');
  return data.swap;
}

export function parseP2pMatch(data: unknown): { swapId: string; status: string; escrowAddress: string | null } {
  if (!record(data) || !text(data.swapId) || typeof data.status !== 'string' || !SWAP_STATUSES.has(data.status) ||
    (data.escrowAddress !== null && !text(data.escrowAddress))) {
    throw new Error('invalid p2p engine response');
  }
  return { swapId: data.swapId, status: data.status, escrowAddress: data.escrowAddress };
}

export function filterP2pOrders(
  orders: readonly P2pOrder[],
  side: 'buy' | 'sell',
  query: string,
): P2pOrder[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const type = side === 'buy' ? 'limit_sell' : 'limit_buy';
  return orders.filter((order) => {
    if (order.type !== type) return false;
    const fields = [
      order.giveToken, order.wantCurrency, order.giveChain, order.sellerDid,
      ...(order.wantRails?.length ? order.wantRails : [order.wantRail]),
    ].map((value) => value.toLowerCase());
    return terms.every((term) => fields.some((value) => value.includes(term)));
  });
}