function decimal(value: string): { units: bigint; scale: number } {
  if (value.length > 100 || !/^\d+(\.\d+)?$/.test(value)) throw new Error("invalid decimal amount");
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(whole + fraction), scale: fraction.length };
}

function format(units: bigint, scale: number): string {
  if (units < 0n) throw new Error("negative amount");
  const digits = units.toString().padStart(scale + 1, "0");
  if (!scale) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "");
}

function aligned(first: string, second: string) {
  const left = decimal(first);
  const right = decimal(second);
  const scale = Math.max(left.scale, right.scale);
  return {
    left: left.units * 10n ** BigInt(scale - left.scale),
    right: right.units * 10n ** BigInt(scale - right.scale),
    scale,
  };
}

export function compareAmounts(first: string, second: string): number {
  const { left, right } = aligned(first, second);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addAmounts(first: string, second: string): string {
  const { left, right, scale } = aligned(first, second);
  return format(left + right, scale);
}

export function subtractAmounts(first: string, second: string): string {
  const { left, right, scale } = aligned(first, second);
  return format(left - right, scale);
}

/**
 * The chain fee every BIG spend burns, in token units: `Coin.FEE_DEFAULT` is
 * 1000 raw units and BIG ("bc") has 6 decimals, so 0.001 BIG.
 *
 * An escrow spend releases `value − fee` (`Escrow.escrowSpendAmount`) because
 * the mempool requires `input >= output + FEE_DEFAULT`. The seller therefore has
 * to lock the advertised amount **plus** this fee, otherwise the buyer receives
 * `giveAmount − fee` — see {@link escrowDepositAmount}.
 */
export const P2P_BIG_FEE = "0.001";

/** True when a token name/symbol/id refers to the native BIG token ("bc"). */
export function isBigToken(token: string | null | undefined): boolean {
  const t = String(token ?? "").trim().toLowerCase();
  return t === "bc" || t === "big";
}

/**
 * The amount the seller must lock into escrow so the counterparty receives the
 * full advertised `amount`.
 *
 * On a BIG escrow the spend fee is taken out of the escrowed UTXO itself, so
 * the deposit is `amount + P2P_BIG_FEE`; a non-BIG escrow pays out in full and
 * needs no extra. Malformed/empty amounts pass through unchanged so a form can
 * call this while the user is still typing.
 */
export function escrowDepositAmount(amount: string, token: string | null | undefined): string {
  const text = String(amount ?? "").trim();
  if (!isBigToken(token)) return text;
  if (!/^\d+(\.\d+)?$/.test(text)) return text;
  return addAmounts(text, P2P_BIG_FEE);
}

/** The fee included in {@link escrowDepositAmount}: `P2P_BIG_FEE` for BIG, else "0". */
export function escrowDepositFee(token: string | null | undefined): string {
  return isBigToken(token) ? P2P_BIG_FEE : "0";
}

function quoteAmount(fill: string, total: string, fiat: string): string | null {
  const quantity = decimal(fill);
  const give = decimal(total);
  const want = decimal(fiat);
  const numerator = quantity.units * want.units * 10n ** BigInt(give.scale + 8);
  const denominator = give.units * 10n ** BigInt(quantity.scale + want.scale);
  if (denominator === 0n || numerator % denominator !== 0n) return null;
  return format(numerator / denominator, 8);
}

export type P2pFillCheck =
  | { ok: true; fill: string; fiat: string }
  | { ok: false; reason: "amount" | "min" | "max" | "remainder" | "precision"; limit: string };

export function checkP2pFill(order: {
  giveAmount: string; wantAmount: string; remainingGive?: string; minOrder?: string; maxOrder?: string;
}, input: string): P2pFillCheck {
  const remaining = order.remainingGive ?? order.giveAmount;
  const fill = input.trim() || remaining;
  try {
    if (compareAmounts(fill, "0") <= 0 || compareAmounts(fill, remaining) > 0 ||
        compareAmounts(remaining, order.giveAmount) > 0 || compareAmounts(order.wantAmount, "0") <= 0) {
      return { ok: false, reason: "amount", limit: remaining };
    }
    const fiat = quoteAmount(fill, order.giveAmount, order.wantAmount);
    if (fiat === null) return { ok: false, reason: "precision", limit: "8" };
    if (compareAmounts(fiat, "0") <= 0) return { ok: false, reason: "amount", limit: remaining };
    if (order.minOrder && compareAmounts(fiat, order.minOrder) < 0) return { ok: false, reason: "min", limit: order.minOrder };
    if (order.maxOrder && compareAmounts(fiat, order.maxOrder) > 0) return { ok: false, reason: "max", limit: order.maxOrder };
    const next = subtractAmounts(remaining, fill);
    if (next !== "0") {
      const leftover = quoteAmount(next, order.giveAmount, order.wantAmount);
      if (leftover === null) return { ok: false, reason: "precision", limit: "8" };
      if (order.minOrder && compareAmounts(leftover, order.minOrder) < 0) return { ok: false, reason: "remainder", limit: order.minOrder };
    }
    return { ok: true, fill, fiat };
  } catch {
    return { ok: false, reason: "amount", limit: remaining };
  }
}