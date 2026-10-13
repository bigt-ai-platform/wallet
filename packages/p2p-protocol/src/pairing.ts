/**
 * Device pairing grant (docs/p2p.md §12) — the DID authorization that lets the
 * p2p engine control a mobile-mcp endpoint a user paired.
 *
 * The user's wallet signs one grant per pairing: it names the endpoint, the
 * device, the (optional) single-swap scope and an expiry, and it carries the
 * endpoint's bearer capability so the engine never learns a token the user did
 * not hand it inside a signature. The engine verifies the whole-body DID
 * signature (its ordinary request auth), stores the grant, and reaches the
 * device only while the grant is unrevoked and unexpired.
 *
 * Pairings are consent records: store-only (the endpoint URL is a user's
 * machine address — it never anchors), while everything derived from a read
 * anchors per the "only large blobs stay off chain" rule.
 */
export interface PairingGrant {
  /** did:key of the device owner — the wallet key whose signature authorizes this. */
  did: string;
  /** The paired mobile-mcp endpoint (Streamable HTTP base URL). */
  endpoint: string;
  /** The device the user paired on that endpoint (mobile_list_available_devices id). */
  deviceId: string;
  /** The endpoint's `MOBILEMCP_AUTH` bearer capability — transport auth only. */
  token?: string;
  /** When set, only this one swap may use the pairing. */
  swapId?: string;
  /** unix ms */
  issuedAt: number;
  /** unix ms — after this the grant is dead, whatever else is true. */
  expiresAt: number;
  /** One grant, one id — revocation and idempotency key. (Not the request envelope nonce.) */
  pairingId: string;
}

const DID_RE = /^did:key:[A-Za-z0-9]+$/;
const PAIRING_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const SWAP_ID_RE = /^swap-[0-9a-f]{16}$/;

/** A grant may live at most 30 days — pairing is consent, not a subscription. */
export const MAX_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GrantCheck {
  ok: boolean;
  error?: string;
}

/** Structural checks. Freshness (`now` window) is the caller's to enforce against its own clock. */
export function validatePairingGrant(g: Partial<PairingGrant>, now: number = Date.now()): GrantCheck {
  if (typeof g.did !== "string" || !DID_RE.test(g.did) || g.did.length > 512) {
    return { ok: false, error: "invalid did (did:key…)" };
  }
  if (typeof g.endpoint !== "string" || !/^https?:\/\/[^\s]+$/.test(g.endpoint) || g.endpoint.length > 512) {
    return { ok: false, error: "invalid endpoint (http(s) URL)" };
  }
  if (typeof g.deviceId !== "string" || g.deviceId.length === 0 || g.deviceId.length > 128) {
    return { ok: false, error: "invalid deviceId (1..128)" };
  }
  if (g.token !== undefined && (typeof g.token !== "string" || g.token.length === 0 || g.token.length > 256)) {
    return { ok: false, error: "invalid token (1..256)" };
  }
  if (g.swapId !== undefined && (typeof g.swapId !== "string" || !SWAP_ID_RE.test(g.swapId))) {
    return { ok: false, error: "invalid swapId (swap-<16hex>)" };
  }
  if (typeof g.issuedAt !== "number" || !Number.isFinite(g.issuedAt) || g.issuedAt <= 0) {
    return { ok: false, error: "invalid issuedAt" };
  }
  if (typeof g.expiresAt !== "number" || !Number.isFinite(g.expiresAt) || g.expiresAt <= g.issuedAt) {
    return { ok: false, error: "invalid expiresAt (after issuedAt)" };
  }
  if (g.expiresAt - g.issuedAt > MAX_GRANT_TTL_MS) {
    return { ok: false, error: `grant ttl too long (max ${MAX_GRANT_TTL_MS / 86_400_000} days)` };
  }
  if (g.expiresAt <= now) {
    return { ok: false, error: "grant already expired" };
  }
  if (typeof g.pairingId !== "string" || !PAIRING_ID_RE.test(g.pairingId)) {
    return { ok: false, error: "invalid pairingId (8..64: alnum _ -)" };
  }
  return { ok: true };
}

/**
 * Is this grant usable for this swap right now? A scope-less grant serves any
 * swap of its owner; a scoped one only its own.
 */
export function grantAllows(grant: PairingGrant, swapId: string, now: number = Date.now()): boolean {
  return grant.expiresAt > now && (grant.swapId === undefined || grant.swapId === swapId);
}
