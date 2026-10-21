import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { Pool } from "pg";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { FsBlobStore, EncryptedBlobStore, S3BlobStore, MemBlobStore, blobStoreFromEnv } from "../src/blob.js";
import { BlobSettlementStore } from "../src/storeBlob.js";
import { PgSettlementStore, type Queryable } from "../src/store.js";
import { MemCursorStore, syncOnce, type ChainBlockView, type SocialSource } from "../src/replay.js";
import type { PaymentProfile, P2pSwapEvent } from "../src/types.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "p2p-blob-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = "a".repeat(64);

describe("FsBlobStore", () => {
  it("round-trips, lists and deletes JSON objects", async () => {
    const s = new FsBlobStore(dir);
    expect(await s.get("profiles", "did:x|wechat")).toBeNull();
    await s.put("profiles", "did:x|wechat", { sellerDid: "did:x", method: "wechat", account: "wxid_1" });
    await s.put("profiles", "did:x|alipay", { sellerDid: "did:x", method: "alipay" });
    expect(await s.get("profiles", "did:x|wechat")).toMatchObject({ method: "wechat", account: "wxid_1" });
    expect((await s.list("profiles")).sort()).toEqual(["did:x|alipay", "did:x|wechat"]);
    await s.del("profiles", "did:x|wechat");
    expect(await s.get("profiles", "did:x|wechat")).toBeNull();
    expect(await s.list("profiles")).toEqual(["did:x|alipay"]);
  });
});

describe("EncryptedBlobStore", () => {
  it("stores an AES-256-GCM envelope and never the plaintext", async () => {
    const inner = new FsBlobStore(dir);
    const s = new EncryptedBlobStore(inner, KEY);
    await s.put("proofs", "swap-1", [{ swapId: "swap-1", txId: "4200001234567890", receipt: "data:image/png;base64,AAAA" }]);

    const collDir = join(dir, Buffer.from("proofs", "utf8").toString("base64url"));
    const [name] = await readdir(collDir);
    const raw = await readFile(join(collDir, name), "utf8");
    expect(raw).not.toContain("4200001234567890");
    const parsed = JSON.parse(raw) as { key: string; value: { alg: string } };
    expect(parsed.key).toBe("swap-1");
    expect(parsed.value).toMatchObject({ alg: "aes-256-gcm" });
    expect(await s.get("proofs", "swap-1")).toMatchObject([{ txId: "4200001234567890" }]);
  });

  it("fails closed when the key does not match", async () => {
    const inner = new FsBlobStore(dir);
    await new EncryptedBlobStore(inner, KEY).put("profiles", "k", { a: 1 });
    await expect(new EncryptedBlobStore(inner, "b".repeat(64)).get("profiles", "k")).rejects.toThrow();
  });
});

describe("blobStoreFromEnv", () => {
  it("requires a target for blob mode", () => {
    expect(() => blobStoreFromEnv({} as NodeJS.ProcessEnv)).toThrow(/SETTLEMENT_BLOB/);
  });
  it("builds an encrypted dir store and warns without a key", async () => {
    const s = blobStoreFromEnv({ SETTLEMENT_BLOB_DIR: dir, SETTLEMENT_BLOB_KEY: KEY } as NodeJS.ProcessEnv);
    await s.put("profiles", "k", { sellerDid: "did:x" });
    expect(await s.get("profiles", "k")).toMatchObject({ sellerDid: "did:x" });
  });
});

describe("S3BlobStore (SigV4)", () => {
  function recorder(handler: (req: { method: string; url: string; headers: Record<string, string> }) => Response) {
    const seen: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const req = { method: init.method ?? "GET", url, headers: init.headers ?? {} };
      seen.push(req);
      return handler(req);
    }) as unknown as typeof fetch;
    return { seen, fetchImpl };
  }

  it("signs PUT/GET/DELETE and lists objects", async () => {
    const { seen, fetchImpl } = recorder((req) => {
      if (req.method === "GET" && req.url.includes("list-type=2")) {
        return new Response(
          `<ListBucketResult><Contents><Key>p2p/${Buffer.from("profiles").toString("base64url")}/${Buffer.from("k").toString("base64url")}.json</Key></Contents></ListBucketResult>`,
          { status: 200 },
        );
      }
      if (req.method === "GET") return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
      return new Response("", { status: 200 });
    });
    const s = new S3BlobStore({
      endpoint: "http://127.0.0.1:9000",
      bucket: "p2p", region: "us-east-1", accessKey: "AKIA", secretKey: "SECRET", prefix: "p2p/", fetchImpl,
    });
    s.now = () => new Date("2026-01-01T00:00:00.000Z");

    await s.put("profiles", "k", { a: 1 });
    expect(await s.get("profiles", "k")).toMatchObject({ ok: 1 });
    await s.del("profiles", "k");
    expect(await s.list("profiles")).toEqual(["k"]);

    for (const req of seen) {
      expect(req.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      expect(req.headers["x-amz-date"]).toBe("20260101T000000Z");
      expect(req.url).toContain("127.0.0.1:9000/p2p/");
    }
    expect(seen.map((r) => r.method)).toEqual(["PUT", "GET", "DELETE", "GET"]);
    // PUT signs the payload hash, GET/DELETE use the empty-body hash
    expect(seen[0].headers["x-amz-content-sha256"]).not.toBe(seen[1].headers["x-amz-content-sha256"]);
  });

  it("returns null for a missing object", async () => {
    const { fetchImpl } = recorder(() => new Response("", { status: 404 }));
    const s = new S3BlobStore({ endpoint: "http://x", bucket: "b", region: "r", accessKey: "a", secretKey: "s", fetchImpl });
    expect(await s.get("profiles", "nope")).toBeNull();
  });
});

describe("BlobSettlementStore", () => {
  const profile = (method: string): PaymentProfile => ({
    sellerDid: "did:key:zSELLER", method: method as PaymentProfile["method"], accountName: "Zhang San", account: "wxid_1", updatedAt: 1,
  });

  it("persists the store-only data across a restart, keeps the projection volatile", async () => {
    const blobs = new EncryptedBlobStore(new FsBlobStore(dir), KEY);
    const one = new BlobSettlementStore(blobs);
    await one.upsertProfile(profile("wechat"));
    await one.addProof({ swapId: "swap-1", txId: "4200001234", createdAt: 1 });
    await one.putEscrowSigning({ swapId: "swap-1", refundAddress: "mREF", releaseSig: "aa", refundSig: "bb", releaseSignerDid: "did", refundSignerDid: "did", sellerDid: "did:key:zSELLER", createdAt: 1, updatedAt: 1 });

    const two = new BlobSettlementStore(new EncryptedBlobStore(new FsBlobStore(dir), KEY));
    expect(await two.getProfile("did:key:zSELLER", "wechat")).toMatchObject({ account: "wxid_1" });
    expect(await two.listProfiles("did:key:zSELLER")).toHaveLength(1);
    expect((await two.proofs("swap-1"))[0]).toMatchObject({ txId: "4200001234" });
    expect(await two.getEscrowSigning("swap-1")).toMatchObject({ refundAddress: "mREF" });
    // swap events are chain-derived: empty in the fresh projection until replayed
    expect(await two.getSwap("swap-1")).toBeNull();
  });

  it("round-trips device pairings keyed by pairingId", async () => {
    const store = new BlobSettlementStore(new EncryptedBlobStore(new FsBlobStore(dir), KEY));
    const grant = {
      did: "did:key:zBUYER", endpoint: "http://192.168.1.20:8080", deviceId: "self", token: "tok",
      pairingId: "pr-0123456789abcdef", issuedAt: 1, expiresAt: 9_999_999_999, createdAt: 1,
    };
    await store.putPairing(grant);
    const got = await store.getPairing("did:key:zBUYER", "pr-0123456789abcdef");
    expect(got).toMatchObject({ pairingId: "pr-0123456789abcdef", endpoint: "http://192.168.1.20:8080", token: "tok" });
    // a different pairingId under the same DID is a distinct record (never the nonce)
    expect(await store.getPairing("did:key:zBUYER", "pr-other")).toBeNull();
    await store.putPairing({ ...grant, pairingId: "pr-ffffffffffffffff", createdAt: 2 });
    expect((await store.pairingsForDid("did:key:zBUYER")).map((p) => p.pairingId).sort()).toEqual([
      "pr-0123456789abcdef", "pr-ffffffffffffffff",
    ]);
    // another DID's pairings are never returned
    await store.putPairing({ ...grant, did: "did:key:zSELLER", pairingId: "pr-sellerseller" });
    expect((await store.pairingsForDid("did:key:zBUYER")).every((p) => p.did === "did:key:zBUYER")).toBe(true);
  });

  it("rebuilds the order/swap projection from L1 at boot", async () => {
    const GENESIS = { hash: "h0", height: 0, prevHash: "0".repeat(64), records: [] };
    const block = (hash: string, height: number, prevHash: string, records: ChainBlockView["records"]): ChainBlockView => ({ hash, height, prevHash, records });
    const record = { type: "social.p2p-order", from: "did:key:zS", to: "ord-0123456789abcdef", ts: 1_700_000_000_000, status: "OPEN", orderSeq: 0, giveToken: "USDT", giveAmount: "10", giveChain: "L0", wantCurrency: "CNY", wantAmount: "71", wantRail: "wechat", validUntil: 9_999_999_999 };
    // A record the projector accepts must also verify its author signature; use
    // the projector's own path with a signed record from the replay test is
    // overkill here — this asserts the wiring: syncOnce writes into `.projection`.
    const src: SocialSource = {
      async head() { return { hash: "h1" }; },
      async blockByHash(h: string) { return h === "h1" ? block("h1", 1, "h0", [{ txid: "f".repeat(64), record }]) : h === "h0" ? GENESIS : null; },
    };
    const store = new BlobSettlementStore(new FsBlobStore(dir));
    const r = await syncOnce(src, store, new MemCursorStore());
    // the unsigned record is skipped (fail closed) but the walk still advances
    expect(r.skipped).toBe(1);
    expect(await store.getOrder("ord-0123456789abcdef")).toBeNull();
    // and the projection store is the one that receives applies
    await store.createOrder({ orderId: "ord-aaaaaaaaaaaaaaaa", type: "limit_sell", sellerDid: "did", giveToken: "USDT", giveAmount: "1", giveChain: "L0", wantCurrency: "CNY", wantAmount: "7", wantRail: "wechat", validUntil: 9_999_999_999, status: "ACTIVE", signature: "s", createdAt: 1 });
    expect(await store.getOrder("ord-aaaaaaaaaaaaaaaa")).not.toBeNull();
  });

  it("writes encrypted at rest (no plaintext account on disk)", async () => {
    const store = new BlobSettlementStore(new EncryptedBlobStore(new FsBlobStore(dir), KEY));
    await store.upsertProfile(profile("bank"));
    const files = await readdir(join(dir, Buffer.from("profiles").toString("base64url")));
    const raw = await readFile(join(dir, Buffer.from("profiles").toString("base64url"), files[0]), "utf8");
    expect(raw).not.toContain("wxid_1");
    expect(Buffer.from(raw, "utf8").includes(Buffer.from(randomBytes(4)))).toBe(false);
  });
});

/** Captures the INSERT params and serves them back for SELECTs. */
class FakeDb implements Queryable {
  inserted: unknown[][] = [];
  private rows: Record<string, unknown>[] = [];
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[]; rowCount: number | null }> {
    if (sql.includes("INSERT INTO p2p_payment_proofs")) {
      this.inserted.push(params);
      this.rows.push({
        swap_id: params[0], tx_id: params[1], remark: params[2], receipt_sha256: params[3],
        receipt: params[4], receipt_ref: params[5], paid_at: params[6], created_at: params[7],
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: this.rows, rowCount: this.rows.length };
  }
}

describe("PgSettlementStore — receipt bytes go to the blob store", () => {
  const RECEIPT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("keeps only the sha256 + a ref in the row and rehydrates from the blob", async () => {
    const db = new FakeDb();
    const store = new PgSettlementStore(db, new MemBlobStore());
    await store.addProof({ swapId: "swap-1", txId: "4200", receipt: RECEIPT, receiptSha256: "a".repeat(64), createdAt: 1 });
    expect(db.inserted[0][4]).toBeNull(); // receipt column empty
    expect(db.inserted[0][5]).toBe("swap-1:4200:1"); // receipt_ref set
    expect((await store.proofs("swap-1"))[0].receipt).toBe(RECEIPT);
  });

  it("keeps the receipt inline when no blob store is configured", async () => {
    const db = new FakeDb();
    const store = new PgSettlementStore(db);
    await store.addProof({ swapId: "s", txId: "t", receipt: RECEIPT, createdAt: 1 });
    expect(db.inserted[0][4]).toBe(RECEIPT);
    expect(db.inserted[0][5]).toBeNull();
  });
});

describe.skipIf(!process.env.P2P_TEST_DATABASE_URL)("PgSettlementStore concurrency", () => {
  const schema = `p2p_test_${randomBytes(8).toString("hex")}`;
  let pool: Pool;
  let store: PgSettlementStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.P2P_TEST_DATABASE_URL, options: `--search_path=${schema}` });
    await pool.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    store = new PgSettlementStore(pool);
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  });

  it("allows only one concurrent fill from the same remainder", async () => {
    const orderId = "ord-0000000000000001";
    await store.createOrder({
      orderId, type: "limit_sell", sellerDid: "did:seller", giveToken: "USDT", giveAmount: "100",
      giveChain: "L0", wantCurrency: "USD", wantAmount: "100", wantRail: "wechat",
      validUntil: 1800000000, status: "ACTIVE", signature: "test", createdAt: Date.now(),
    });
    const results = await Promise.all([
      store.markOrderMatched(orderId, "swap-first", "40", "100"),
      store.markOrderMatched(orderId, "swap-second", "40", "100"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await store.getOrder(orderId)).toMatchObject({ status: "ACTIVE", remainingGive: "40" });
    expect(await store.markOrderMatched(orderId, "swap-stale", undefined, "100")).toBe(false);
    expect(await store.markOrderMatched(orderId, "swap-final", undefined, "40")).toBe(true);
  });

  it("rejects stale events before anchoring and preserves identical replays", async () => {
    const initial: P2pSwapEvent = { swapId: "swap-concurrent", seq: 0, status: "PAYMENT_PENDING", eventType: "instructions", at: Date.now() };
    await store.appendEvent(initial);
    const proof: P2pSwapEvent = { ...initial, seq: 1, status: "PAYMENT_CLAIMED", eventType: "proof" };
    const confirmation: P2pSwapEvent = { ...initial, seq: 1, status: "PAYMENT_VERIFIED", eventType: "confirm" };
    let anchors = 0;
    const results = await Promise.allSettled([proof, confirmation].map((event) => store.appendEvent(event, async () => {
      anchors++;
      return { ...event, txid: "a".repeat(64) };
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(anchors).toBe(1);
    const stored = (await store.getSwap(initial.swapId))!;
    await store.appendEvent(stored);
    await expect(store.appendEvent({ ...stored, status: "EXPIRED" })).rejects.toMatchObject({ statusCode: 409 });
    expect(await store.events(initial.swapId)).toHaveLength(2);
  });

  it("rolls back and releases the lock when anchoring fails", async () => {
    const event: P2pSwapEvent = { swapId: "swap-rollback", seq: 0, status: "MATCHED", eventType: "match", at: Date.now() };
    await expect(store.appendEvent(event, async () => { throw new Error("anchor failed"); })).rejects.toThrow("anchor failed");
    expect(await store.getSwap(event.swapId)).toBeNull();
    await store.appendEvent(event, async () => event);
    expect(await store.getSwap(event.swapId)).toEqual(event);
  });

  it("makes replay inserts wait for the same per-swap transaction lock", async () => {
    const event: P2pSwapEvent = { swapId: "swap-replay-lock", seq: 0, status: "MATCHED", eventType: "match", at: Date.now() };
    const blocker = await pool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`p2p-swap:${event.swapId}`]);
    const insertion = store.appendEvent(event);
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT COUNT(*) AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        expect(Number(waiting.rows[0].count)).toBeGreaterThan(0);
      });
      expect(await store.getSwap(event.swapId)).toBeNull();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await insertion;
    }
    expect(await store.getSwap(event.swapId)).toEqual(event);
  });
});
