import type { P2pOrder } from '@/services/p2p';

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