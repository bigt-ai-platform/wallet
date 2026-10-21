import { subtractAmounts, validateP2pOrderRecord, validateP2pSwapRecord, type P2pOrderRecord, type P2pSwapRecord } from 'p2p-protocol';
import { collectSocialRecords, type SocialRecordEntry, type SocialSource } from '@/lib/socialReader';
import type { P2pOrder } from '@/services/p2p';

/**
 * Fold L1-SOCIAL social records into the public order book — the wallet-side
 * replacement for the engine's `GET /public/orders` (docs/p2p.md §26).
 *
 * The book is derived, not stored: it replays the seller-anchored
 * `social.p2p-order` records (OPEN → ACTIVE, CANCELLED withdraws), drops any
 * order a `social.p2p-swap` event has already claimed (`MATCHED` is never
 * seller-asserted, §9/§14), drops expired and unverified records, and keeps the
 * highest `orderSeq` per order. PII-free by construction — it only ever sees
 * what the chain carries.
 *
 * Reputation (§25) is *not* derivable from the order records alone; the chain
 * book leaves `sellerReputation` unset.
 */

export interface FoldOrderBookOptions {
  /** Milliseconds; injectable for tests. Defaults to `Date.now()`. */
  now?: number;
}

/** Fold already-extracted social entries into the ACTIVE order book. */
export function foldOrderBook(
  entries: readonly SocialRecordEntry[],
  opts: FoldOrderBookOptions = {},
): P2pOrder[] {
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);

  const blocked = new Set<string>();
  const swaps = new Map<string, P2pSwapRecord>();
  for (const e of entries) {
    if (e.kind !== 'swap' || !e.verified) continue;
    const swap = e.record as Partial<P2pSwapRecord>;
    if (typeof swap.orderId !== 'string') continue;
    if (!validateP2pSwapRecord(swap).ok || !swap.giveAmount) {
      blocked.add(swap.orderId);
      continue;
    }
    const previous = swaps.get(swap.to!);
    if (!previous || swap.swapSeq! > previous.swapSeq) swaps.set(swap.to!, swap as P2pSwapRecord);
  }

  const latest = new Map<string, { record: P2pOrderRecord; txid: string }>();
  for (const e of entries) {
    if (e.kind !== 'order' || !e.verified) continue;
    const r = e.record as Partial<P2pOrderRecord>;
    if (!validateP2pOrderRecord(r).ok) continue;
    const orderId = r.to as string;
    const prev = latest.get(orderId);
    if (prev && (r.orderSeq as number) <= prev.record.orderSeq) continue;
    latest.set(orderId, { record: r as P2pOrderRecord, txid: e.txid });
  }

  const out: P2pOrder[] = [];
  for (const [orderId, { record: r, txid }] of latest) {
    if (r.status !== 'OPEN') continue;
    if (blocked.has(orderId)) continue;
    if (typeof r.validUntil !== 'number' || r.validUntil <= nowSec) continue;
    let remainingGive = r.giveAmount as string;
    try {
      for (const swap of swaps.values()) {
        if (swap.orderId !== orderId) continue;
        const returned = (swap.status === 'ESCROW_REFUNDED' && !!swap.refundTxHash) ||
          ((swap.status === 'CANCELLED' || swap.status === 'EXPIRED') && !swap.escrowTxHash);
        if (!returned) remainingGive = subtractAmounts(remainingGive, swap.giveAmount!);
      }
    } catch {
      continue;
    }
    if (remainingGive === '0') continue;
    out.push({
      orderId,
      type: r.side === 'buy' ? 'limit_buy' : 'limit_sell',
      sellerDid: r.from,
      giveToken: r.giveToken as string,
      giveAmount: r.giveAmount as string,
      remainingGive,
      giveChain: r.giveChain as string,
      wantCurrency: r.wantCurrency as string,
      wantAmount: r.wantAmount as string,
      wantRail: r.wantRail as string,
      validUntil: r.validUntil,
      status: 'ACTIVE',
      txid,
      createdAt: r.ts,
      ...(r.enginePubkey ? { enginePubkey: r.enginePubkey } : {}),
      ...(r.minOrder ? { minOrder: r.minOrder } : {}),
      ...(r.maxOrder ? { maxOrder: r.maxOrder } : {}),
      ...(r.timeLimit !== undefined ? { timeLimit: r.timeLimit } : {}),
      ...(r.remarks ? { remarks: r.remarks } : {}),
      ...(r.wantRails ? { wantRails: r.wantRails } : {}),
    });
  }
  // Newest orders first (the engine's book is newest-first too).
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/** Read a recent window of L1-SOCIAL and fold it into the order book. */
export async function chainOrderBook(
  src: SocialSource,
  opts: { maxBlocks: number } & FoldOrderBookOptions,
): Promise<P2pOrder[]> {
  return foldOrderBook(await collectSocialRecords(src, { maxBlocks: opts.maxBlocks }), opts);
}
