/**
 * DID-signed, nonce-protected request authentication (docs/p2p.md).
 *
 * The engine only advances on a request whose author proves key possession:
 * the request body (everything except `signature`) is serialized with sorted
 * top-level keys — the same canonical form bigtai's engine and dai's client use
 * — and signed with the did's key. The whole body is bound, so no field can be
 * altered in flight (unlike the old bigtai route, which signed a subset).
 *
 * Nonces and the rate limit are process-local by design here (the doc flags
 * this): with more than one instance they belong in a shared store.
 */
import { createHash } from "node:crypto";
import { Ed25519Key, ECKey, pubFromDid, hexToBytes, bytesToHex } from "did";
import { isValidPQDid, verifyChallengeWithPQDid } from "did/pq";

export const NONCE_MAX_SKEW_MS = 5 * 60 * 1000;
export const NONCE_TTL_MS = 6 * 60 * 1000;
export const RATE_LIMIT = 10;
export const RATE_WINDOW_MS = 60 * 1000;

/** Sorted top-level keys, matching bigtai's `canonicalJson`. */
export function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/** Sign a payload as `did` would (used by tests and CLI helpers). */
export function signPayload(payload: Record<string, unknown>, privHex: string): string {
  const key = Ed25519Key.fromPrivateBytes(hexToBytes(privHex));
  return bytesToHex(key.sign(new TextEncoder().encode(canonicalJson(payload))));
}

/**
 * True only when `sigHex` verifies over the canonical payload against `did`.
 * PQ (ML-DSA-87) dids sign the sha256 digest of the canonical JSON as a
 * SignatureBundle; classic dids sign the raw bytes (Ed25519) or their hash
 * (secp256k1).
 */
export function verifySignature(payload: Record<string, unknown>, did: string, sigHex: string): boolean {
  if (!sigHex || typeof sigHex !== "string") return false;
  const msg = new TextEncoder().encode(canonicalJson(payload));
  try {
    if (isValidPQDid(did)) {
      const digest = bytesToHex(createHash("sha256").update(msg).digest());
      return verifyChallengeWithPQDid(did, digest, sigHex);
    }
  } catch {
    return false;
  }
  let pub: { pubBytes: Uint8Array; codec: number };
  try {
    pub = pubFromDid(did);
  } catch {
    return false;
  }
  let sig: Uint8Array;
  try {
    sig = hexToBytes(sigHex);
  } catch {
    return false;
  }
  try {
    if (pub.codec === 0xed) return Ed25519Key.fromPublicBytes(pub.pubBytes).verify(msg, sig);
    return ECKey.fromPublicBytes(pub.pubBytes).verify(createHash("sha256").update(msg).digest(), sig);
  } catch {
    return false;
  }
}

export interface SignedRequestResult {
  ok: boolean;
  error?: string;
  status?: number;
}

/** Nonce replay + rate-limit guard (process-local; inject a clock in tests). */
export class ReplayGuard {
  private readonly used = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns an error string when the nonce is invalid/replayed, else records it. */
  checkNonce(nonce: unknown, timestamp: unknown): string | null {
    if (typeof nonce !== "string" || nonce.length < 16) return "nonce required (>=16 chars)";
    const ts = typeof timestamp === "number" ? timestamp : NaN;
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > NONCE_MAX_SKEW_MS) {
      return "request timestamp out of window";
    }
    const now = this.now();
    this.prune(now);
    if (this.used.has(nonce)) return "nonce already used (replay detected)";
    this.used.set(nonce, now + NONCE_TTL_MS);
    return null;
  }

  /** Sliding-window rate limit per DID. Returns an error string when exceeded. */
  checkRate(did: string): string | null {
    const now = this.now();
    const hits = (this.hits.get(did) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (hits.length >= RATE_LIMIT) return "rate limit exceeded";
    hits.push(now);
    this.hits.set(did, hits);
    return null;
  }

  private prune(now: number): void {
    for (const [nonce, exp] of this.used) if (exp <= now) this.used.delete(nonce);
  }
}

/**
 * Validate a signed request body. `expectedDid` is the party whose key must
 * have produced the signature (seller on order create, buyer on match, the
 * acting party on a transition). The signed payload is the body minus
 * `signature`; `nonce`/`timestamp` are part of it and must be present.
 */
export function validateSignedRequest(
  body: Record<string, unknown>,
  expectedDid: string,
  guard: ReplayGuard,
): SignedRequestResult {
  const { signature, ...payload } = body;
  if (typeof signature !== "string" || !signature) return { ok: false, error: "signature required", status: 400 };
  if (!verifySignature(payload, expectedDid, signature)) return { ok: false, error: "invalid signature", status: 400 };
  const nonceError = guard.checkNonce(body.nonce, body.timestamp);
  if (nonceError) return { ok: false, error: nonceError, status: 400 };
  const rateError = guard.checkRate(expectedDid);
  if (rateError) return { ok: false, error: rateError, status: 429 };
  return { ok: true };
}
