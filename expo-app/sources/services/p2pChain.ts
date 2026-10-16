import { P2P_CHAIN_BOOK, P2P_ENGINE_PUBKEYS, P2P_SOCIAL_URL } from '@/constants/app';
import { chainOrderBook } from '@/lib/orderBook';
import { HttpSocialSource } from '@/lib/socialReader';
import type { P2pOrder } from '@/services/p2p';

/**
 * Chain-backed P2P order book (docs/p2p.md §26) — reads the open book straight
 * from L1-SOCIAL instead of the engine's `/public/orders`. Opt-in via
 * `EXPO_PUBLIC_P2P_CHAIN_BOOK=1`; requires `P2P_SOCIAL_URL`. Read-only, no
 * engine: it walks a bounded window of recent blocks and folds the
 * seller-anchored order records (`lib/orderBook.ts`).
 */

/** How many recent L1-SOCIAL blocks the book walk covers. */
const DEFAULT_MAX_BLOCKS = Number(process.env.EXPO_PUBLIC_P2P_CHAIN_BOOK_BLOCKS) || 300;

/** Whether the wallet should read the book from the chain (flag + social node). */
export function chainBookEnabled(): boolean {
  return P2P_CHAIN_BOOK && !!P2P_SOCIAL_URL;
}

/** Read + fold the book from the chain. Throws when no social node is set. */
export async function orderBookFromChain(maxBlocks: number = DEFAULT_MAX_BLOCKS): Promise<P2pOrder[]> {
  if (!P2P_SOCIAL_URL) throw new Error('p2p social chain not configured');
  const book = await chainOrderBook(new HttpSocialSource(P2P_SOCIAL_URL), { maxBlocks });
  // Hide orders pinned to an engine we do not trust (docs/p2p.md §27.4 #1) so
  // the buyer never matches an unmatchable / rug order. With no allowlist the
  // signing-time guard is still the enforcement point.
  if (!P2P_ENGINE_PUBKEYS.length) return book;
  return book.filter((o) => !o.enginePubkey || P2P_ENGINE_PUBKEYS.includes(o.enginePubkey));
}
