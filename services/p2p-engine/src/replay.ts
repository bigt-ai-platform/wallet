/**
 * L1-SOCIAL chain-scan projector (docs/p2p.md §14 — the rebuild watcher).
 *
 * The engine's Postgres store is a projection of two record types the chain
 * carries: seller-anchored `social.p2p-order` (intake) and engine-anchored
 * `social.p2p-swap` (settlement log). This module walks L1-SOCIAL blocks
 * (getTips → getBlockByHash by prev-hash), verifies each record's author
 * signature, and applies it to a SettlementStore idempotently — so a wiped
 * projection replays from the chain and `verify` reports drift.
 *
 * Conflict rule: chain inclusion order decides. The projector uses the same
 * conditional ACTIVE→MATCHED / ACTIVE→CANCELLED claims the API routes use, so
 * a cancel and a match that both landed resolve to whichever the chain ordered
 * first; the loser is reported as a conflict, never applied over the winner.
 *
 * Rebuilt swap events carry only what the anchored record carries — PII
 * (receiveAddress, profiles, receipts) is store-only
 * and deliberately not recoverable from the chain (docs/p2p.md §14).
 */
import { type NetworkParameters } from "bigtangle-ts";
import { verifyRecordSig, type AnchoredRecord } from "record-sig";
import {
  P2P_ORDER_TYPE,
  P2P_SWAP_TYPE,
  validateP2pOrderRecord,
  validateP2pSwapRecord,
  type P2pOrderRecord,
  type P2pSwapRecord,
} from "p2p-protocol";
import { settlementParams } from "./escrow.js";
import { MemSettlementStore, type Queryable } from "./store.js";
import type { P2pOrder, P2pSwapEvent } from "./types.js";

export interface WatchCursor {
  hash: string;
  height: number;
}

export interface CursorStore {
  get(): Promise<WatchCursor | null>;
  set(c: WatchCursor): Promise<void>;
}

export class MemCursorStore implements CursorStore {
  private cursor: WatchCursor | null = null;
  async get(): Promise<WatchCursor | null> {
    return this.cursor;
  }
  async set(c: WatchCursor): Promise<void> {
    this.cursor = { ...c };
  }
}

export function pgCursorStore(db: Queryable): CursorStore {
  return {
    async get(): Promise<WatchCursor | null> {
      const res = await db.query(`SELECT block_hash, height FROM p2p_watch_cursor WHERE id`);
      return res.rows[0] ? { hash: String(res.rows[0].block_hash), height: Number(res.rows[0].height) } : null;
    },
    async set(c: WatchCursor): Promise<void> {
      await db.query(
        `INSERT INTO p2p_watch_cursor (id, block_hash, height, updated_at)
         VALUES (true, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET block_hash = EXCLUDED.block_hash, height = EXCLUDED.height, updated_at = now()`,
        [c.hash, c.height],
      );
    },
  };
}

/** Idempotent DDL for stores that predate the watcher (additive columns/tables). */
export async function ensureWatchSchema(db: Queryable): Promise<void> {
  await db.query(`ALTER TABLE p2p_orders ADD COLUMN IF NOT EXISTS txid TEXT`);
  await db.query(`ALTER TABLE p2p_orders ADD COLUMN IF NOT EXISTS engine_pubkey TEXT`);
  await db.query(`ALTER TABLE p2p_payment_proofs ADD COLUMN IF NOT EXISTS receipt_ref TEXT`);
  await db.query(
    `CREATE TABLE IF NOT EXISTS p2p_watch_cursor (
       id         BOOLEAN PRIMARY KEY DEFAULT true,
       block_hash TEXT NOT NULL,
       height     BIGINT NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

export interface ChainRecord {
  txid: string;
  record: Record<string, unknown>;
}

export interface ChainBlockView {
  hash: string;
  height: number;
  prevHash: string;
  /** Social-record payloads carried by this block's transactions, in tx order. */
  records: ChainRecord[];
}

export interface SocialSource {
  head(): Promise<{ hash: string }>;
  blockByHash(hash: string): Promise<ChainBlockView | null>;
}

/** L1-SOCIAL read path: getTips + getBlockByHash (dataHex blocks). */
export class HttpSocialSource implements SocialSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly params: NetworkParameters = settlementParams(),
  ) {}

  private get base(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  private async post<T>(cmd: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${cmd}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${cmd} ${res.status}`);
    return (await res.json()) as T;
  }

  async head(): Promise<{ hash: string }> {
    // getTips answers GetStringResponse: { text: "<tips json>" }.
    const res = await this.post<{ text?: string; message?: string }>("getTips", {});
    const raw = res.text ?? res.message;
    if (!raw) throw new Error("getTips: empty payload");
    const tips = JSON.parse(raw) as { prevBlockHash?: string };
    if (!tips.prevBlockHash) throw new Error("getTips: no prevBlockHash");
    // The rolling prototype's prev IS the current head block.
    return { hash: tips.prevBlockHash };
  }

  async blockByHash(hash: string): Promise<ChainBlockView | null> {
    const res = await this.post<{ dataHex?: string }>("getBlockByHash", { hashHex: hash });
    if (!res.dataHex) return null;
    const block = this.params.getDefaultSerializer().makeBlock(Uint8Array.from(Buffer.from(res.dataHex, "hex")));
    const records: ChainRecord[] = [];
    for (const tx of block.getTransactions() ?? []) {
      if (tx.getDataClassName() !== "SocialRecord") continue;
      const data = tx.getData();
      if (!data || !data.length) continue;
      try {
        records.push({ txid: tx.getHash().toString(), record: JSON.parse(new TextDecoder().decode(data)) });
      } catch {
        // malformed JSON: applyBlock counts it as skipped
        records.push({ txid: tx.getHash().toString(), record: { type: "__garbage__" } });
      }
    }
    return {
      hash: block.getHash().toString(),
      height: block.getHeight(),
      prevHash: block.getPrevBlockHash().toString(),
      records,
    };
  }
}

/**
 * The record a specific tx landed in a confirmed block, or null. Used by the
 * intake gate to prove the chain actually carries the record the seller is
 * asking the engine to index (docs/p2p.md §11).
 */
export async function fetchRecordByTxid(
  src: SocialSource,
  blockHash: string,
  txid: string,
): Promise<Record<string, unknown> | null> {
  const block = await src.blockByHash(blockHash);
  return block?.records.find((r) => r.txid === txid)?.record ?? null;
}

export interface SyncResult {
  scannedBlocks: number;
  ordersOpened: number;
  ordersCancelled: number;
  swapsAppended: number;
  skipped: number;
  conflicts: string[];
  cursor: WatchCursor | null;
  error?: string;
}

function emptyResult(): Omit<SyncResult, "cursor"> {
  return { scannedBlocks: 0, ordersOpened: 0, ordersCancelled: 0, swapsAppended: 0, skipped: 0, conflicts: [] };
}

/** status → the eventType the API would have recorded (rebuild projection only). */
const EVENT_TYPE_FOR_STATUS: Record<string, P2pSwapEvent["eventType"]> = {
  MATCHED: "match",
  ESCROW_LOCKED: "escrow_lock",
  PAYMENT_PENDING: "instructions",
  PAYMENT_CLAIMED: "payment_proof",
  PAYMENT_VERIFIED: "payment_confirm",
  ESCROW_RELEASED: "release",
  COMPLETED: "complete",
  EXPIRED: "expire",
  ESCROW_REFUNDED: "refund",
  CANCELLED: "cancel",
};

function eventFromSwapRecord(rec: P2pSwapRecord, txid: string): P2pSwapEvent {
  return {
    swapId: rec.to,
    seq: rec.swapSeq,
    status: rec.status,
    // A verdict keeps the swap's status — the record's verify block is what
    // marks the event (§12).
    eventType: rec.verifySide !== undefined ? "payment_verify" : EVENT_TYPE_FOR_STATUS[rec.status] ?? "match",
    ...(rec.orderId !== undefined ? { orderId: rec.orderId } : {}),
    ...(rec.sellerDid !== undefined ? { sellerDid: rec.sellerDid } : {}),
    ...(rec.buyerDid !== undefined ? { buyerDid: rec.buyerDid } : {}),
    ...(rec.giveChain !== undefined ? { giveChain: rec.giveChain } : {}),
    ...(rec.giveToken !== undefined ? { giveToken: rec.giveToken } : {}),
    ...(rec.giveAmount !== undefined ? { giveAmount: rec.giveAmount } : {}),
    ...(rec.wantAmount !== undefined ? { wantAmount: rec.wantAmount } : {}),
    ...(rec.wantRail !== undefined ? { wantRail: rec.wantRail } : {}),
    ...(rec.wantCurrency !== undefined ? { wantCurrency: rec.wantCurrency } : {}),
    ...(rec.escrowAddress !== undefined ? { escrowAddress: rec.escrowAddress } : {}),
    ...(rec.escrowTxHash !== undefined ? { escrowTxHash: rec.escrowTxHash } : {}),
    ...(rec.releaseTxHash !== undefined ? { releaseTxHash: rec.releaseTxHash } : {}),
    ...(rec.refundTxHash !== undefined ? { refundTxHash: rec.refundTxHash } : {}),
    ...(rec.receiptSha256 !== undefined ? { receiptSha256: rec.receiptSha256 } : {}),
    ...(rec.verifySide !== undefined
      ? {
          verify: {
            side: rec.verifySide,
            observed: rec.verifyObserved ?? "none",
            evidenceKind: rec.verifyEvidence ?? "device_read",
            ...(rec.verifyTxId !== undefined ? { txId: rec.verifyTxId } : {}),
            ...(rec.verifyAmount !== undefined ? { amount: rec.verifyAmount } : {}),
            ...(rec.verifyRemark !== undefined ? { remark: rec.verifyRemark } : {}),
            ...(rec.verifyPaidAt !== undefined ? { paidAt: rec.verifyPaidAt } : {}),
            ...(rec.verifyReceipt !== undefined ? { receiptVerified: rec.verifyReceipt } : {}),
            ...(rec.verifyCaptures !== undefined ? { captures: rec.verifyCaptures.split(",") } : {}),
          },
        }
      : {}),
    // A confirm record carries only the provenance — restore it (§12).
    ...(rec.verifySide === undefined && rec.verifyEvidence !== undefined ? { verifySource: rec.verifyEvidence } : {}),
    at: rec.ts,
    txid,
  };
}

type OrderStore = Pick<
  import("./store.js").SettlementStore,
  "createOrder" | "getOrder" | "markOrderMatched" | "markOrderCancelled" | "appendEvent" | "events"
>;

async function applyRecord(
  raw: ChainRecord,
  store: OrderStore,
  result: Omit<SyncResult, "cursor">,
): Promise<void> {
  const type = raw.record?.type;
  if (type === P2P_ORDER_TYPE) {
    if (!validateP2pOrderRecord(raw.record as unknown as Partial<P2pOrderRecord>).ok || !verifyRecordSig(raw.record as unknown as AnchoredRecord)) {
      result.skipped++;
      return;
    }
    const rec = raw.record as unknown as P2pOrderRecord & { sig?: string };
    if (rec.status === "OPEN") {
      const existing = await store.getOrder(rec.to);
      if (existing) {
        if (existing.txid && existing.txid !== raw.txid) {
          result.conflicts.push(`order ${rec.to}: duplicate OPEN (${existing.txid} vs ${raw.txid})`);
        }
        return;
      }
      await store.createOrder({
        orderId: rec.to,
        type: "limit_sell",
        sellerDid: rec.from,
        giveToken: rec.giveToken ?? "",
        giveAmount: rec.giveAmount ?? "",
        giveChain: rec.giveChain ?? "",
        wantCurrency: rec.wantCurrency ?? "",
        wantAmount: rec.wantAmount ?? "",
        wantRail: rec.wantRail ?? "",
        validUntil: rec.validUntil ?? 0,
        status: "ACTIVE",
        signature: rec.sig ?? "",
        txid: raw.txid,
        ...(rec.enginePubkey ? { enginePubkey: rec.enginePubkey } : {}),
        createdAt: rec.ts,
      });
      result.ordersOpened++;
    } else {
      if (await store.markOrderCancelled(rec.to)) {
        result.ordersCancelled++;
      } else {
        const o = await store.getOrder(rec.to);
        if (!o) result.conflicts.push(`cancel for unknown order ${rec.to}`);
        else if (o.status !== "CANCELLED") result.conflicts.push(`cancel lost race for ${rec.to} (${o.status})`);
      }
    }
    return;
  }
  if (type === P2P_SWAP_TYPE) {
    if (!validateP2pSwapRecord(raw.record as unknown as Partial<P2pSwapRecord>).ok || !verifyRecordSig(raw.record as unknown as AnchoredRecord)) {
      result.skipped++;
      return;
    }
    const rec = raw.record as unknown as P2pSwapRecord;
    const event = eventFromSwapRecord(rec, raw.txid);
    const prior = await store.events(event.swapId);
    if (!prior.some((e) => e.seq === event.seq)) {
      await store.appendEvent(event);
      result.swapsAppended++;
    }
    if (event.status === "MATCHED" && event.orderId) {
      if (!(await store.markOrderMatched(event.orderId, event.swapId))) {
        const o = await store.getOrder(event.orderId);
        if (o && o.status === "CANCELLED") {
          result.conflicts.push(`match ${event.swapId}: order ${event.orderId} already cancelled`);
        }
      }
    }
    return;
  }
  result.skipped++;
}

/**
 * One incremental pass: walk back from the head to the cursor (or genesis on a
 * fresh store), apply blocks oldest-first, advance the cursor. Fails closed —
 * an unservable head never advances the cursor, and a truncated walk applies
 * nothing.
 */
export async function syncOnce(
  src: SocialSource,
  store: OrderStore,
  cursors: CursorStore,
  opts: { maxWalk?: number } = {},
): Promise<SyncResult> {
  const maxWalk = opts.maxWalk ?? 2000;
  const cursor = await cursors.get();
  const head = await src.head();
  const collected: ChainBlockView[] = [];
  let hash = head.hash;
  let reachedAnchor = false;
  while (collected.length < maxWalk) {
    if (cursor && hash === cursor.hash) {
      reachedAnchor = true;
      break;
    }
    const b = await src.blockByHash(hash);
    if (!b) {
      const res = { ...emptyResult(), cursor, error: `unservable block ${hash}` };
      return res;
    }
    collected.push(b);
    if (b.height <= 0) {
      reachedAnchor = true;
      break;
    }
    hash = b.prevHash;
  }
  if (!reachedAnchor) {
    const res = { ...emptyResult(), cursor, error: `walk truncated at ${maxWalk} blocks (raise maxWalk)` };
    return res;
  }
  collected.reverse(); // ascending height

  const result = emptyResult();
  let last: ChainBlockView | null = null;
  for (const b of collected) {
    if (cursor && b.hash === cursor.hash) {
      last = b;
      continue;
    }
    for (const raw of b.records) await applyRecord(raw, store, result);
    result.scannedBlocks++;
    last = b;
  }
  if (last && last.hash !== cursor?.hash) {
    await cursors.set({ hash: last.hash, height: last.height });
  }
  // `last` is null only when the walk began at the cursor (nothing new).
  return { ...result, cursor: last ? { hash: last.hash, height: last.height } : cursor };
}

export interface VerifyReport {
  ok: boolean;
  missing: string[];
  extra: string[];
  scanned: number;
}

/**
 * Replay the whole chain into a scratch store and diff it against `store`.
 * `missing` = on chain but absent/different in the store (drift — the
 * projection lost data the chain still has). `extra` = store rows the chain
 * does not carry (expected for legacy engine-intake orders and for store-only
 * PII; informational, not fatal).
 */
export async function replayVerify(
  src: SocialSource,
  store: Pick<OrderStore, "getOrder" | "events"> & {
    listOrders(): Promise<P2pOrder[]>;
    listSwaps(limit?: number): Promise<P2pSwapEvent[]>;
  },
  opts: { maxWalk?: number } = {},
): Promise<VerifyReport> {
  const mem = new MemSettlementStore();
  const sync = await syncOnce(src, mem, new MemCursorStore(), { maxWalk: opts.maxWalk ?? 50_000 });
  if (sync.error) return { ok: false, missing: [sync.error], extra: [], scanned: sync.scannedBlocks };
  const missing: string[] = [];
  for (const o of mem.orders.values()) {
    const live = await store.getOrder(o.orderId);
    if (!live) missing.push(`order ${o.orderId} (chain ${o.status})`);
    else if (o.status !== "ACTIVE" && live.status !== o.status) {
      missing.push(`order ${o.orderId} status chain=${o.status} store=${live.status}`);
    }
  }
  for (const [swapId, list] of mem.swapEvents) {
    const liveEvents = await store.events(swapId);
    for (const e of list) {
      const le = liveEvents.find((x) => x.seq === e.seq);
      if (!le) missing.push(`swap ${swapId} seq ${e.seq} (${e.status})`);
      else if (le.status !== e.status) missing.push(`swap ${swapId} seq ${e.seq} status chain=${e.status} store=${le.status}`);
    }
  }
  const extra: string[] = [];
  for (const o of await store.listOrders()) {
    if (!mem.orders.has(o.orderId)) extra.push(`order ${o.orderId} (store-only, not on chain)`);
  }
  for (const s of await store.listSwaps(1000)) {
    if (!mem.swapEvents.has(s.swapId)) extra.push(`swap ${s.swapId} (store-only, not on chain)`);
  }
  return { ok: missing.length === 0, missing, extra, scanned: sync.scannedBlocks };
}
