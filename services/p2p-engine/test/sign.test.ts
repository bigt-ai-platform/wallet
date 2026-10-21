import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { PQKey } from "bigtangle-ts";
import { Ed25519Key, didFromEd25519Key } from "did";
import { didFromPQKey, signChallengePQ } from "did/pq";
import { ReplayGuard, canonicalJson, signPayload, validateSignedRequest, verifySignature } from "../src/sign.js";

const key = Ed25519Key.createNewKey();
const did = didFromEd25519Key(key);
const priv = key.getPrivHex()!;

function signed(body: Record<string, unknown>, nonce = "n".repeat(16), timestamp = 1_000_000) {
  const payload = { ...body, nonce, timestamp };
  return { ...payload, signature: signPayload(payload, priv) };
}

describe("p2p signed requests", () => {
  it("binds requests to the method, operation, and resource before consuming the nonce", () => {
    const guard = new ReplayGuard(() => 1_000_000);
    const body = signed({ did, requestMethod: "POST", requestPath: "/swaps/mine" });
    expect(validateSignedRequest(body, did, guard, "write", "/swaps/swap-0000000000000001/confirm").ok).toBe(false);
    expect(validateSignedRequest(body, did, guard, "read", "/swaps/mine").ok).toBe(true);
    const confirm = signed({ did, requestMethod: "POST", requestPath: "/swaps/swap-0000000000000001/confirm" }, "c".repeat(16));
    expect(validateSignedRequest(confirm, did, guard, "write", "/swaps/swap-0000000000000002/confirm").ok).toBe(false);
    expect(validateSignedRequest({ ...confirm, requestPath: "/swaps/swap-0000000000000002/confirm" }, did, guard, "write", "/swaps/swap-0000000000000002/confirm").ok).toBe(false);
    expect(validateSignedRequest(confirm, did, guard, "write", "/swaps/swap-0000000000000001/confirm").ok).toBe(true);
    expect(validateSignedRequest(signed({ did }), did, guard, "read", "/swaps/mine").ok).toBe(false);
  });

  it("canonicalizes with sorted top-level keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("round-trips a signature", () => {
    const payload = { sellerDid: did, amount: "100" };
    const sig = signPayload(payload, priv);
    expect(verifySignature(payload, did, sig)).toBe(true);
    expect(verifySignature({ ...payload, amount: "1" }, did, sig)).toBe(false);
  });

  it("accepts a fresh signed request and records the nonce", () => {
    const guard = new ReplayGuard(() => 1_000_000);
    const body = signed({ sellerDid: did });
    expect(validateSignedRequest(body, did, guard)).toEqual({ ok: true });
  });

  it("rejects a replayed nonce", () => {
    const guard = new ReplayGuard(() => 1_000_000);
    const body = signed({ sellerDid: did });
    expect(validateSignedRequest(body, did, guard).ok).toBe(true);
    const replay = validateSignedRequest(body, did, guard);
    expect(replay.ok).toBe(false);
    expect(replay.status).toBe(400);
  });

  it("rejects a stale timestamp and a wrong signer", () => {
    const guard = new ReplayGuard(() => 1_000_000);
    const stale = signed({ sellerDid: did }, "n".repeat(16), 1_000_000 - 10 * 60 * 1000);
    expect(validateSignedRequest(stale, did, guard).ok).toBe(false);
    const other = Ed25519Key.createNewKey();
    expect(validateSignedRequest(signed({ a: 1 }), didFromEd25519Key(other), guard).ok).toBe(false);
  });

  it("verifies PQ (mldsa) signed requests over the canonical digest", () => {
    const pq = PQKey.fromMLDSA(new Uint8Array(32).fill(3));
    const pqDid = didFromPQKey(pq);
    const payload = { sellerDid: pqDid, amount: "100" };
    const digest = createHash("sha256").update(new TextEncoder().encode(canonicalJson(payload))).digest("hex");
    const sig = signChallengePQ(pq, digest);
    expect(verifySignature(payload, pqDid, sig)).toBe(true);
    expect(verifySignature({ ...payload, amount: "1" }, pqDid, sig)).toBe(false);
  });

  it("rate-limits per did", () => {
    const guard = new ReplayGuard(() => 1_000_000);
    let last = { ok: true } as { ok: boolean; status?: number };
    for (let i = 0; i < 11; i++) {
      last = validateSignedRequest(signed({ sellerDid: did }, "n".repeat(12) + i.toString(16).padStart(4, "0")), did, guard);
    }
    expect(last.ok).toBe(false);
    expect(last.status).toBe(429);
  });

  it("honours custom write/read limits and keeps the buckets independent", () => {
    const guard = new ReplayGuard(() => 1_000_000, { read: 2, write: 1 });
    // The single write slot is consumed by the first write...
    expect(validateSignedRequest(signed({ sellerDid: did }, "m".repeat(12) + "0001"), did, guard).ok).toBe(true);
    expect(validateSignedRequest(signed({ sellerDid: did }, "m".repeat(12) + "0002"), did, guard).status).toBe(429);
    // ...and the reads have their own bucket, untouched by the write cap.
    expect(validateSignedRequest(signed({ sellerDid: did }, "m".repeat(12) + "0003"), did, guard, "read").ok).toBe(true);
    expect(validateSignedRequest(signed({ sellerDid: did }, "m".repeat(12) + "0004"), did, guard, "read").ok).toBe(true);
    expect(validateSignedRequest(signed({ sellerDid: did }, "m".repeat(12) + "0005"), did, guard, "read").status).toBe(429);
  });

  it("persists accepted nonces and rejects a replay after a restart", async () => {
    const persisted: Array<{ nonce: string; exp: number }> = [];
    const store = {
      load: async () => persisted.slice(),
      add: async (nonce: string, exp: number) => {
        persisted.push({ nonce, exp });
      },
      prune: async () => {},
    };
    const req = signed({ sellerDid: did }, "r".repeat(16), 1_000_000);
    const first = new ReplayGuard(() => 1_000_000, { read: 5, write: 5 }, store);
    expect(validateSignedRequest(req, did, first).ok).toBe(true);
    expect(persisted).toHaveLength(1);

    // A fresh guard (a restart) hydrates from the store and rejects the replay.
    const restarted = new ReplayGuard(() => 1_000_000, { read: 5, write: 5 }, store);
    restarted.hydrate(await store.load());
    expect(validateSignedRequest(req, did, restarted).status).toBe(400);
  });
});
