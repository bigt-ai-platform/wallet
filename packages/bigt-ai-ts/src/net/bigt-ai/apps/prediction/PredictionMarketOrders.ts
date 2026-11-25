/**
 * Client-side market-order sugar for prediction markets (docs/prediction-market.md
 * §6): given a one-sided snapshot of the L1 order book, compute the worst limit
 * price that fills an aggressive buy/sell, so the UI can offer "buy at 55¢"
 * without the user picking a limit. This is a pure planner — it performs no I/O
 * and submits nothing; the caller feeds the returned `price` to the normal L1
 * order flow (`Wallet.buyOrder`/`sellOrder` via `orderOnLayer1`).
 *
 * Prices and amounts are kept as raw `bigint` in the token's on-chain units; the
 * helper does not scale for display, so the result can be passed straight back
 * to the order API.
 */
export interface BookLevel {
  /** limit price of the resting order (raw units). */
  price: bigint;
  /** remaining size at this level (raw units). */
  amount: bigint;
}

export interface MarketOrderPlan {
  /** worst price the aggressive order must cross (0n when nothing fills). */
  price: bigint;
  /** size that can be filled immediately. */
  filled: bigint;
  /** total size available on the book side. */
  available: bigint;
  /** true when `filled >= amount` (the whole order crosses). */
  complete: boolean;
}

export class PredictionMarketOrders {
  /**
   * Plan an aggressive BUY of `amount` against the ask ladder (`asks`). Levels
   * are walked best (lowest price) first; the limit is the price of the deepest
   * level consumed, so the engine matches every level up to it.
   */
  static planBuy(asks: BookLevel[], amount: bigint): MarketOrderPlan {
    return PredictionMarketOrders.plan(asks, amount, (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /**
   * Plan an aggressive SELL of `amount` against the bid ladder (`bids`). Levels
   * are walked best (highest price) first.
   */
  static planSell(bids: BookLevel[], amount: bigint): MarketOrderPlan {
    return PredictionMarketOrders.plan(bids, amount, (a, b) => (a > b ? -1 : a < b ? 1 : 0));
  }

  private static plan(
    levels: BookLevel[],
    amount: bigint,
    compare: (a: bigint, b: bigint) => number
  ): MarketOrderPlan {
    const usable = levels
      .filter((l) => l.amount > 0n && l.price > 0n)
      .sort((x, y) => compare(x.price, y.price));
    let available = 0n;
    for (const level of usable) available += level.amount;

    if (amount <= 0n) {
      return { price: 0n, filled: 0n, available, complete: false };
    }

    let remaining = amount;
    let limit = 0n;
    for (const level of usable) {
      limit = level.price;
      if (remaining <= level.amount) {
        remaining = 0n;
        break;
      }
      remaining -= level.amount;
    }
    const filled = amount - remaining;
    return { price: limit, filled, available, complete: remaining <= 0n };
  }
}
