/**
 * Device-side payment verification (docs/p2p.md §12).
 *
 * A party authorizes an agent on their **own** device (mobile-mcp) to read the
 * matching entry in their own rail app — the buyer's sending record, the
 * seller's receiving record — and their wallet signs the extracted verdict with
 * their DID key. The verdict is evidence, never oracle truth: "the model never
 * supplies trusted evidence" (§14) still holds, so what a verdict may do is
 * bounded by policy:
 *
 *  · one-sided verdicts are dispute evidence only — either party could spoof
 *    their own device's UI;
 *  · the two verdicts agreeing on the same 流水号/交易号 — the correlation id
 *    both apps display — is two-sided verification;
 *  · a bank 电子回单 whose 回单 verification passes on the bank's **public**
 *    verification page is the one near-oracle signal (bank rail only).
 *
 * Pure decision functions only: no IO, no keys, no trust. Amounts are decimal
 * strings exactly as the rail displays them — no float rounding may make a
 * check pass or fail by accident.
 */

/** Whose ledger was read. Must equal the signing party's role in the swap. */
export const VERIFY_SIDES = ["buyer", "seller"] as const;
export type VerifySide = (typeof VERIFY_SIDES)[number];

/** What the device's ledger says happened to the money. */
export const VERIFY_OBSERVED = ["sent", "received", "none"] as const;
export type VerifyObserved = (typeof VERIFY_OBSERVED)[number];

/** How the entry was obtained. */
export const VERIFY_EVIDENCE_KINDS = ["device_read", "bank_ereceipt"] as const;
export type VerifyEvidenceKind = (typeof VERIFY_EVIDENCE_KINDS)[number];

export interface PaymentVerdict {
  /** Whose ledger was read — the engine derives this from the signer's role. */
  side: VerifySide;
  /** The rail entry's own transaction id (流水号 / 交易号) — both apps show it. */
  txId?: string;
  observed: VerifyObserved;
  /** Decimal string exactly as the rail displays it ("715.00"). sent/received only. */
  amount?: string;
  /** Account name/nickname the entry shows as the counterparty (PII: store-only). */
  counterpartyName?: string;
  /** The 备注/附言 the entry carries — must be the swap's remark code. */
  remark?: string;
  /** When the rail timestamps the entry (unix ms). */
  paidAt?: number;
  evidenceKind: VerifyEvidenceKind;
  /** bank_ereceipt only: the 回单 verification passed on the bank's public page. */
  receiptVerified?: boolean;
  /** sha256 of each capture the agent kept on the device (audit refs, not bytes). */
  captures?: string[];
}

/** The swap terms a verdict is checked against (engine-filled, worker-filled). */
export interface VerdictExpectation {
  /** Exact instruction amount (decimal string). */
  amount: string;
  /** The per-swap remark code, when the swap has one. */
  remark?: string;
  /** The buyer's claimed 流水号 — a difference is reported, never fatal. */
  claimedTxId?: string;
  /** Unix ms window: the swap's match time .. the claim/confirm time. */
  paidFrom: number;
  paidTo: number;
}

export interface VerdictCheck {
  ok: boolean;
  error?: string;
  /** The observed 流水号 differs from the buyer's claim — arbitration evidence. */
  claimMismatch?: { claimed: string; observed: string };
}

const TXID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** Numeric amount equality — "715" and "715.00" are the same money. */
export function sameAmount(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (!AMOUNT_RE.test(a) || !AMOUNT_RE.test(b)) return false;
  const [ai, af = ""] = a.split(".");
  const [bi, bf = ""] = b.split(".");
  return (
    BigInt(ai) === BigInt(bi) &&
    af.replace(/0+$/, "") === bf.replace(/0+$/, "")
  );
}

/**
 * Check one verdict against the swap terms. Strict where the protocol is
 * strict: amount exact, remark the swap's code, the entry inside the swap
 * window — a transfer that predates the match must not be replayed (§12).
 */
export function validatePaymentVerdict(
  verdict: PaymentVerdict,
  expected: VerdictExpectation,
): VerdictCheck {
  const { side, observed, evidenceKind, txId, amount, remark, paidAt, captures } = verdict;
  if (!(VERIFY_SIDES as readonly string[]).includes(side)) return { ok: false, error: `invalid side (${VERIFY_SIDES.join("|")})` };
  if (!(VERIFY_OBSERVED as readonly string[]).includes(observed)) return { ok: false, error: `invalid observed (${VERIFY_OBSERVED.join("|")})` };
  if (!(VERIFY_EVIDENCE_KINDS as readonly string[]).includes(evidenceKind)) {
    return { ok: false, error: `invalid evidenceKind (${VERIFY_EVIDENCE_KINDS.join("|")})` };
  }
  if (evidenceKind === "bank_ereceipt" && observed !== "none" && verdict.receiptVerified !== true) {
    return { ok: false, error: "bank_ereceipt requires receiptVerified (run the bank's public 回单 verification)" };
  }
  if (captures !== undefined) {
    if (!Array.isArray(captures) || captures.some((c) => typeof c !== "string" || !SHA256_RE.test(c))) {
      return { ok: false, error: "captures must be sha256 hex digests" };
    }
  }

  if (observed === "none") {
    // "my ledger shows nothing in the window" — no entry fields to check, but
    // whatever is stated must still agree with the swap.
    if (txId !== undefined && !TXID_RE.test(txId)) return { ok: false, error: "invalid txId (1..64: alnum . _ -)" };
    if (amount !== undefined && !sameAmount(amount, expected.amount)) return { ok: false, error: "amount does not match the swap" };
    return {
      ok: true,
      ...(txId && expected.claimedTxId && txId !== expected.claimedTxId
        ? { claimMismatch: { claimed: expected.claimedTxId, observed: txId } }
        : {}),
    };
  }

  if (txId === undefined || !TXID_RE.test(txId)) return { ok: false, error: "invalid txId (1..64: alnum . _ -)" };
  if (amount === undefined || !AMOUNT_RE.test(amount)) return { ok: false, error: "invalid amount" };
  if (!sameAmount(amount, expected.amount)) return { ok: false, error: "amount does not match the swap" };
  if (expected.remark !== undefined && remark !== expected.remark) {
    return { ok: false, error: remark === undefined ? "remark missing from the entry" : "remark does not match the swap" };
  }
  if (paidAt !== undefined) {
    if (typeof paidAt !== "number" || !Number.isFinite(paidAt)) return { ok: false, error: "invalid paidAt" };
    if (paidAt < expected.paidFrom || paidAt > expected.paidTo) {
      return { ok: false, error: "entry is outside the swap window (old transfers must not be replayed)" };
    }
  }
  return {
    ok: true,
    ...(txId && expected.claimedTxId && txId !== expected.claimedTxId
      ? { claimMismatch: { claimed: expected.claimedTxId, observed: txId } }
      : {}),
  };
}

/**
 * Two-sided agreement: one buyer "sent" and one seller "received" describing
 * the *same* transfer — same 流水号, same money, same remark. Anything else is
 * two stories, not verification.
 */
export function verdictsAgree(a: PaymentVerdict, b: PaymentVerdict): boolean {
  if (a.side === b.side) return false;
  const buyer = a.side === "buyer" ? a : b;
  const seller = a.side === "buyer" ? b : a;
  if (buyer.observed !== "sent" || seller.observed !== "received") return false;
  if (buyer.txId === undefined || buyer.txId !== seller.txId) return false;
  return sameAmount(buyer.amount, seller.amount) && (buyer.remark ?? "") === (seller.remark ?? "");
}

/**
 * What counts as machine confirmation (docs/p2p.md §12, `SETTLEMENT_CNY_AUTO_RELEASE_ON`):
 *
 *  · `off` (default) — verdicts are dispute evidence only;
 *  · `seller_receipt` — the seller's own ledger says received (user-authorized
 *    read, seller-signed) stands in for the confirm tap;
 *  · `two_sided` — stricter: both ledgers must agree on one 流水号 first;
 *  · `verified_receipt` — a bank 电子回单 that passed the bank's public 回单
 *    verification settles it alone; the two-sided agreement also qualifies.
 *
 * Returns the verdict that acts as the confirmation (its signature is the
 * attestation), or null when the verdicts may change nothing.
 */
export function machineConfirm(
  policy: string | null | undefined,
  verdicts: readonly PaymentVerdict[],
): PaymentVerdict | null {
  const p = normalizeAutoReleasePolicy(policy);
  if (p === "off") return null;
  const sellerReceived = verdicts.find((v) => v.side === "seller" && v.observed === "received") ?? null;
  const buyerSent = verdicts.find((v) => v.side === "buyer" && v.observed === "sent") ?? null;
  const verifiedReceipt =
    verdicts.find((v) => v.evidenceKind === "bank_ereceipt" && v.receiptVerified === true && v.observed !== "none") ?? null;
  const twoSided = !!sellerReceived && !!buyerSent && verdictsAgree(sellerReceived, buyerSent);
  if (p === "seller_receipt") return sellerReceived;
  if (p === "two_sided") return twoSided ? sellerReceived : null;
  // verified_receipt
  if (verifiedReceipt) return verifiedReceipt;
  return twoSided ? sellerReceived : null;
}

export const AUTO_RELEASE_POLICIES = ["off", "seller_receipt", "two_sided", "verified_receipt"] as const;
export type AutoReleasePolicy = (typeof AUTO_RELEASE_POLICIES)[number];

/** Unknown or missing policy values disable the feature — never enable by typo. */
export function normalizeAutoReleasePolicy(policy: string | null | undefined): AutoReleasePolicy {
  const p = (policy ?? "").trim();
  return (AUTO_RELEASE_POLICIES as readonly string[]).includes(p) ? (p as AutoReleasePolicy) : "off";
}
