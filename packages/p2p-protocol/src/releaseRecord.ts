/**
 * `social.p2p-release` — the cooperative-release signature carrier.
 *
 * The engine-free happy path (docs/p2p.md §6 "Engine as dispute-only
 * attestor"): the seller and buyer rebuild the identical deterministic escrow
 * spend skeleton and each signs the same sighash. To settle, one party needs
 * the other's signature. This record is how a **party** hands its signature to
 * the counterparty — an author-signed (`record-sig`) record anchored on
 * L1-SOCIAL, so the signature is public, self-contained and verifiable, and no
 * engine / server is in the path.
 *
 * The record is PII-free: `escrowTxHash` and `toAddress` are already public in
 * the spend it authorises, `from` is the author's did:key, and `sig` is a
 * signature over the escrow sighash (not a key). The record itself carries a
 * `sig`/`sigScheme` pair added by the anchor step (record-sig); the escrow
 * signature rides in `escrowSig` so the two are never confused.
 */
export const P2P_RELEASE_TYPE = "social.p2p-release";

/** A release sends to the buyer; a refund returns to the seller. */
export const P2P_RELEASE_KINDS = ["release", "refund"] as const;
export type P2pReleaseKind = (typeof P2P_RELEASE_KINDS)[number];

export interface P2pReleaseRecord {
  type: typeof P2P_RELEASE_TYPE;
  /** did:key of the author (the party contributing this escrow signature). */
  from: string;
  /** the opaque swapId. */
  to: string;
  ts: number;
  kind: P2pReleaseKind;
  /** The lock tx the escrow spend consumes (64-hex) — pins the outpoint. */
  escrowTxHash: string;
  /** The destination the spend pays (buyer receiveAddress / seller refund addr). */
  toAddress: string;
  /** Hex `SignatureBundle.serialize()` over the deterministic skeleton sighash. */
  escrowSig: string;
}

export interface P2pReleaseRecordInput extends Omit<P2pReleaseRecord, "type" | "ts"> {
  ts?: number;
}

export function p2pReleaseRecord(a: P2pReleaseRecordInput): P2pReleaseRecord {
  return {
    type: P2P_RELEASE_TYPE,
    from: a.from,
    to: a.to,
    ts: a.ts ?? Date.now(),
    kind: a.kind,
    escrowTxHash: a.escrowTxHash,
    toAddress: a.toAddress,
    escrowSig: a.escrowSig,
  };
}

const MAX_SKEW_MS = 5 * 60 * 1000;
const SWAP_ID_RE = /^swap-[0-9a-f]{16}$/;
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{26,64}$/;

/** Validate one decoded record. Field checks mirror the engine's own rules. */
export function validateP2pReleaseRecord(r: Partial<P2pReleaseRecord>): { ok: true } | { ok: false; error: string } {
  if (r.type !== P2P_RELEASE_TYPE) return { ok: false, error: `invalid type (${String(r.type)})` };
  if (typeof r.from !== "string" || r.from.length === 0) return { ok: false, error: "from required" };
  if (typeof r.to !== "string" || !SWAP_ID_RE.test(r.to)) return { ok: false, error: "invalid swapId (to)" };
  if (typeof r.kind !== "string" || !(P2P_RELEASE_KINDS as readonly string[]).includes(r.kind)) {
    return { ok: false, error: `invalid kind (${P2P_RELEASE_KINDS.join("|")})` };
  }
  if (typeof r.escrowTxHash !== "string" || !TX_HASH_RE.test(r.escrowTxHash)) {
    return { ok: false, error: "invalid escrowTxHash (64-hex)" };
  }
  if (typeof r.toAddress !== "string" || !BASE58_RE.test(r.toAddress)) {
    return { ok: false, error: "invalid toAddress (base58)" };
  }
  if (typeof r.escrowSig !== "string" || r.escrowSig.length === 0 || r.escrowSig.length > 20_000) {
    return { ok: false, error: "invalid escrowSig (1..20000)" };
  }
  if (typeof r.ts !== "number" || r.ts <= 0 || r.ts > Date.now() + MAX_SKEW_MS) {
    return { ok: false, error: "invalid ts" };
  }
  return { ok: true };
}
