/**
 * Non-custodial settlement verification.
 *
 * IDIF never holds funds: a payout/invoice/pledge is a signed `social.*` record
 * that carries a `txRef` to an on-chain transfer the payer already made. This
 * module is the pure decision function — given the UTXO-shaped outputs a chain
 * read returned, does one of them satisfy the expected {recipient, token,
 * amount}? Callers normalize their node's wire format into `SettlementOutput`
 * (see `services/feed-api` chain relay) and never credit an unverified ref.
 *
 * Amounts are decimal strings so no float rounding can make a check pass or
 * fail by accident; bigtangle amounts are integer token units.
 */

export interface SettlementOutput {
  /** recipient chain address (base58), as the node reports it */
  address: string;
  /** token id / symbol the output carries (bigtangle tokenid) */
  token: string;
  /** integer token units, decimal string to avoid float error */
  amount: string;
  /** true when the node still reports the output as unspent */
  spent?: boolean;
  /** true when the output is in a confirmed (chain-history) block */
  confirmed?: boolean;
}

export interface SettlementExpectation {
  toAddress: string;
  token: string;
  /** minimum amount that must be received */
  amount: string | number;
  /** require a confirmed output (default true) */
  requireConfirmed?: boolean;
  /** reject outputs the node reports as spent (default true) */
  requireUnspent?: boolean;
}

export interface SettlementResult {
  ok: boolean;
  /** outputs that matched recipient+token (confirmed/unspent per policy) */
  matched: SettlementOutput[];
  /** total matched amount (integer units, decimal string) */
  matchedAmount: string;
  error?: string;
}

function toUnits(v: string | number): bigint | null {
  const s = typeof v === "number" ? String(v) : v.trim();
  if (!/^\d+$/.test(s)) return null;
  return BigInt(s);
}

/**
 * True when at least `amount` of `token` reached `toAddress` in the supplied
 * outputs, honoring the confirmation/spent policy. Pure and total: malformed
 * amounts simply never match.
 */
export function verifySettlement(
  outputs: readonly SettlementOutput[],
  expected: SettlementExpectation,
): SettlementResult {
  const want = toUnits(expected.amount);
  if (want === null) return { ok: false, matched: [], matchedAmount: "0", error: "invalid expected amount" };

  const requireConfirmed = expected.requireConfirmed ?? true;
  const requireUnspent = expected.requireUnspent ?? true;

  const matched: SettlementOutput[] = [];
  let total = 0n;
  for (const o of outputs) {
    if (o.address !== expected.toAddress) continue;
    if (o.token !== expected.token) continue;
    if (requireConfirmed && o.confirmed !== true) continue;
    if (requireUnspent && o.spent === true) continue;
    const amount = toUnits(o.amount);
    if (amount === null) continue;
    matched.push(o);
    total += amount;
  }

  if (total < want) {
    return {
      ok: false,
      matched,
      matchedAmount: total.toString(),
      error: `insufficient: ${total.toString()} < ${want.toString()}`,
    };
  }
  return { ok: true, matched, matchedAmount: total.toString() };
}
