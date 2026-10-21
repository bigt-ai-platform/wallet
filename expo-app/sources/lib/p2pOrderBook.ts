import type { P2pOrder } from '@/services/p2p';

export type P2pFillCheck =
  | { ok: true; fill: string; fiat: string }
  | { ok: false; reason: 'amount'; limit: string }
  | { ok: false; reason: 'min' | 'max'; limit: string };

// Keep fiat rounding aligned with the engine's match endpoint.
export function checkP2pFill(order: P2pOrder, input: string): P2pFillCheck {
  const remaining = order.remainingGive ?? order.giveAmount;
  const fill = input.trim() || remaining;
  if (!/^\d+(\.\d+)?$/.test(fill) || !Number.isFinite(Number(fill)) || !Number.isFinite(Number(remaining)) || Number(fill) <= 0 || Number(fill) > Number(remaining)) {
    return { ok: false, reason: 'amount', limit: remaining };
  }
  const unitPrice = Number(order.wantAmount) / Number(order.giveAmount);
  const fiat = String(Number((Number(fill) * unitPrice).toFixed(8)));
  if (!Number.isFinite(Number(fiat)) || Number(fiat) <= 0) return { ok: false, reason: 'amount', limit: remaining };
  if (order.minOrder && Number(fiat) < Number(order.minOrder)) return { ok: false, reason: 'min', limit: order.minOrder };
  if (order.maxOrder && Number(fiat) > Number(order.maxOrder)) return { ok: false, reason: 'max', limit: order.maxOrder };
  return { ok: true, fill, fiat };
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