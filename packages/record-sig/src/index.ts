/**
 * Author signatures for `social.*` chain records (the wallet's L1-SOCIAL
 * anchor path).
 *
 * A record anchored through a relayer (the engine's anchor step) no longer
 * proves authorship through its transaction signer — the transaction is signed
 * by the engine's service key. So the author signs the record itself: `sig`
 * over the canonical record JSON, made with the key behind `record.from`
 * (ML-DSA-87 for PQ keys, secp256k1/Ed25519 for classic did:key).
 *
 * `social.p2p-swap` is a required-signature type; the wallet's rebuild watcher
 * verifies this signature before projecting the event.
 */
import { verifyChallengeWithPQDid, isValidPQDid } from "did/pq";
import { verifyChallengeWithDid } from "did";
import { sha256 } from "@noble/hashes/sha2.js";

export const RECORD_SIG_SCHEMES = ["mldsa", "secp256k1", "ed25519"] as const;
export type RecordSigScheme = (typeof RECORD_SIG_SCHEMES)[number];

/** Minimal shape of an anchored record; any `social.*` record fits. */
export interface AnchoredRecord {
  type: string;
  from: string;
  to: string;
  ts: number;
  sig?: string;
  sigScheme?: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical JSON: sorted keys at every level, `sig`/`sigScheme` stripped. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      if (k === "sig" || k === "sigScheme") continue;
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Canonical record JSON — the exact bytes that are digest-signed (sync, pure). */
export function canonicalRecordJson(record: AnchoredRecord): string {
  return JSON.stringify(canonicalize(record));
}

/** sha256 hex of the canonical record JSON — the exact bytes that are signed. */
export function recordDigest(record: AnchoredRecord): string {
  return toHex(sha256(new TextEncoder().encode(canonicalRecordJson(record))));
}

/** True only when `record.sig` verifies against `record.from`'s key. */
export function verifyRecordSig(record: AnchoredRecord): boolean {
  if (!record.sig || typeof record.sig !== "string") return false;
  let digest: string;
  try {
    digest = recordDigest(record);
  } catch {
    return false;
  }
  if (record.sigScheme !== undefined && !(RECORD_SIG_SCHEMES as readonly string[]).includes(record.sigScheme)) {
    return false;
  }
  try {
    if (isValidPQDid(record.from)) {
      if (record.sigScheme !== undefined && record.sigScheme !== "mldsa") return false;
      return verifyChallengeWithPQDid(record.from, digest, record.sig);
    }
    if (record.sigScheme !== undefined && record.sigScheme === "mldsa") return false;
    return verifyChallengeWithDid(record.from, digest, record.sig);
  } catch {
    return false;
  }
}
