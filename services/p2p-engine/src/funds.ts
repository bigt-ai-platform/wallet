/**
 * Advisory proof-of-balance for an order's token giver (docs/p2p.md §11).
 *
 * An order is an advertisement: the chain enforces the asset only at
 * `escrow_lock` (the seller must fund the 2-of-3 vault before the buyer sees
 * payment instructions). This check is an early, best-effort quality gate so
 * an unfunded ad does not sit in the public book looking spendable. It is
 * **never** the settlement boundary:
 *
 *   - unknown / unreachable / token-metadata-missing → `checked: false`,
 *     callers must not reject on it;
 *   - a positive read below the advertised amount → `checked: true,
 *     sufficient: false`, which can be rejected/flagged;
 *   - the balance is a snapshot (the funds can move immediately after), so the
 *     definitive check remains the confirmed escrow lock.
 *
 * The balance key is the same one the wallet's `getBalances` uses:
 * `RIPEMD160(SHA256(prefixedPubKey))` for a PQ ML-DSA-87 DID, and the classic
 * h160 for an Ed25519/secp256k1 DID.
 */
import { Utils } from "bigtangle-ts";
import { pubFromDid, pubKeyHashFromPub } from "did";
import { pqPubFromDid } from "did/pq";
import { compareAmounts } from "p2p-protocol";
import type { ChainClient } from "./chain.js";

/** A positive balance snapshot, or an explicit "could not check". */
export interface FundsSnapshot {
  /** false when the chain/token did not give a usable answer */
  checked: boolean;
  /** only meaningful when checked */
  sufficient: boolean;
  /** human-readable available amount (decimal, token units) */
  available: string;
  /** the token row that matched (symbol/id), when known */
  token?: string;
  /** why the check was inconclusive */
  reason?: string;
}

/** `getBalances` / `getOutputs` query key for a DID's key. */
export function didPubKeyHashHex(did: string): string | null {
  try {
    const pub = pqPubFromDid(did);
    return Utils.HEX.encode(Utils.sha256hash160(pub));
  } catch {
    // Not an ML-DSA did: fall back to the classic did:key codecs.
  }
  try {
    const { pubBytes } = pubFromDid(did);
    return Utils.HEX.encode(pubKeyHashFromPub(pubBytes));
  } catch {
    return null;
  }
}

/** Raw integer units → decimal string at `decimals`, trailing zeros trimmed. */
export function rawToDecimal(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) return "0";
  const d = Math.max(0, Math.floor(decimals));
  if (d === 0) return raw.replace(/^0+(?=\d)/, "");
  const digits = raw.replace(/^0+(?=\d)/, "").padStart(d + 1, "0");
  return `${digits.slice(0, -d)}.${digits.slice(-d)}`.replace(/\.?0+$/, "");
}

function sameToken(row: { token: string; tokenId?: string; symbol?: string; name?: string }, want: string): boolean {
  const w = want.trim().toLowerCase();
  return [row.token, row.tokenId, row.symbol, row.name]
    .some((v) => typeof v === "string" && v.trim().toLowerCase() === w);
}

function decimalsForRow(row: { tokenId?: string; decimals?: number }): number | null {
  if (typeof row.decimals === "number" && row.decimals >= 0) return row.decimals;
  // BIG is the only token whose decimals are fixed by the chain params.
  if ((row.tokenId ?? "").toLowerCase() === "bc") return 8;
  return null;
}

/**
 * Best-effort balance of `token` held by `did` on the L0 chain.
 *
 * `amount` is the advertised decimal amount; `sufficient` is true only when a
 * positive balance read is at least that amount. A chain error, an unsupported
 * DID or missing token decimals yields `checked: false` (callers keep the
 * order, the escrow lock still protects the buyer).
 */
export async function checkDidTokenFunds(
  chain: ChainClient,
  opts: { did: string; token: string; amount: string },
): Promise<FundsSnapshot> {
  const hash = didPubKeyHashHex(opts.did);
  if (!hash) {
    return { checked: false, sufficient: false, available: "0", reason: "unsupported did" };
  }
  let outs;
  try {
    outs = await chain.balances(hash);
  } catch {
    return { checked: false, sufficient: false, available: "0", reason: "L0 balance unavailable" };
  }
  const rows = outs.filter(
    (o) => o.spent !== true && o.confirmed !== false && sameToken(o, opts.token),
  );
  if (rows.length === 0) {
    // A positive zero read still proves the advertised amount is not there.
    return { checked: true, sufficient: false, available: "0", token: opts.token, reason: "no balance" };
  }
  const decimals = decimalsForRow(rows[0]);
  if (decimals === null) {
    return {
      checked: false,
      sufficient: false,
      available: "0",
      token: rows[0].token,
      reason: "token decimals unavailable",
    };
  }
  let total = 0n;
  for (const row of rows) {
    if (!/^\d+$/.test(row.amount)) continue;
    total += BigInt(row.amount);
  }
  const available = rawToDecimal(total.toString(), decimals);
  return {
    checked: true,
    sufficient: compareAmounts(available, opts.amount) >= 0,
    available,
    token: rows[0].symbol ?? rows[0].token,
  };
}
