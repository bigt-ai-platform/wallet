/**
 * P2P settlement engine (docs/p2p.md).
 *
 *   POST /orders                              seller posts a signed limit order
 *                                             (optional orderId+txid: the order
 *                                              was anchored on L1-SOCIAL by the
 *                                              seller — docs/p2p.md §11)
 *   POST /orders/:orderId/cancel              seller withdraws an ACTIVE order
 *                                             (optional txid, same chain path)
 *   GET  /orders                              admin: list open orders
 *   GET  /public/orders                       wallet: list open orders (no PII, no sig)
 *   POST /orders/:orderId/match               buyer matches (derives escrow)
 *   POST /swaps/:swapId/transitions           signed state transition
 *   POST /swaps/mine                          wallet: party-scoped swap list
 *   POST /swaps/get                           wallet: one party-scoped swap
 *   POST /swaps/:swapId/payment-instructions  buyer: reveal the seller's payment profile (docs/p2p.md §11)
 *   POST /swaps/:swapId/proof                 buyer: claim payment → PAYMENT_CLAIMED
 *   POST /swaps/:swapId/confirm               seller: confirm receipt → PAYMENT_VERIFIED
 *   POST /swaps/:swapId/dispute               party: freeze the swap
 *   POST /swaps/:swapId/dispute/resolve       admin: arbitration (release | refund)
 *   POST /swaps/:swapId/escrow/context        party: escrow signing context (receiveAddress, presigned)
 *   POST /swaps/:swapId/escrow/presign        seller: pre-sign both spend skeletons (settlement closure)
 *   POST /swaps/:swapId/escrow/cosign         party: co-sign a spend → engine broadcasts + settles
 *   POST /profiles                            seller: upsert a CNY collection profile
 *   POST /profiles/mine                       seller: list own profiles
 *   GET  /swaps/:swapId                       admin: swap view (PII redacted)
 *   GET  /swaps?limit=                        admin: latest state per swap
 *
 * Only the engine (or the seller for lock/expire/refund) can advance a swap;
 * the state machine is append-only and every durable transition is anchored as
 * a `social.p2p-swap` record through the injected `anchor` hook — anchor
 * failure fails the transition (the chain record is the durable seed).
 *
 * Fiat rails (docs/p2p.md §7): the buyer pays the seller directly and the
 * seller's own confirmation is the fiat signal — same shape on every rail
 * (WeChat, Alipay, bank); they differ only in conflict evidence (§4).
 * The engine never touches fiat; it enforces instructions → proof → confirm,
 * freezes on dispute, and releases tokens only after the seller (or an
 * arbitration outcome) has confirmed payment.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { hexToBytes } from "did";
import { pqPubFromDid } from "did/pq";
import { PQKey, Utils } from "bigtangle-ts";
import type { Escrow } from "bigtangle-ts";
import { P2P_ORDER_ID_RE, validateP2pOrderRecord, type P2pOrderRecord } from "p2p-protocol";
import { verifyRecordSig } from "record-sig";
import { ACTION_STATUS, DEDICATED_ACTIONS, canTransition, statusForAction } from "./state.js";
import {
  reputationDetail,
  reputationForDid,
  reputationFromEvents,
  type ReputationReport,
} from "./reputation.js";
import { ReplayGuard, validateSignedRequest } from "./sign.js";
import { escrowAddress, settlementParams } from "./escrow.js";
import {
  assembleSpend,
  awaitConfirmed,
  broadcastSpend,
  buildSkeleton,
  destAddress,
  engineSigner,
  keyFromDid,
  verifyParticipantSig,
  vaultFor,
  type EscrowKind,
} from "./escrowSpend.js";
import { HttpChainClient, verifyChainLock, verifyChainPayment, type ChainClient } from "./chain.js";
import {
  CNY_RAILS,
  isCnyRail,
  type CnyRail,
  type EscrowSigning,
  type PaymentProfile,
  type P2pOrder,
  type P2pSwapEvent,
  type P2pSwapView,
  type SwapAction,
} from "./types.js";
import type { SettlementStore } from "./store.js";

export interface OrderTxCheck {
  txid: string;
  sellerDid: string;
  orderId: string;
  status: "OPEN" | "CANCELLED";
  /** OPEN only: the terms the seller anchored must equal the request's. */
  terms?: {
    giveToken: string;
    giveAmount: string;
    giveChain: string;
    wantCurrency: string;
    wantAmount: string;
    wantRail: string;
    validUntil: number;
  };
}

export interface SettlementDeps {
  store: SettlementStore;
  env?: NodeJS.ProcessEnv;
  guard?: ReplayGuard;
  chain?: ChainClient | null;
  now?: () => number;
  log?: boolean;
  /** Anchor a swap event on chain (returns the txid). Default: no-op. */
  anchor?: (event: P2pSwapEvent) => Promise<{ txid?: string } | void>;
  /**
   * Confirm a seller-anchored order/cancel txid on L1-SOCIAL. When present,
   * POST /orders and /orders/:id/cancel require the txid to land before the
   * index advances (docs/p2p.md §11). Default: no check (mock mode).
   */
  verifyTx?: (txid: string) => Promise<boolean>;
  /**
   * Stronger intake gate: confirm the txid AND prove the confirmed block
   * carries the exact `social.p2p-order` record the request claims (author =
   * seller, orderId, status, terms). Preferred over `verifyTx` when present.
   */
  verifyOrderTx?: (check: OrderTxCheck) => Promise<{ ok: boolean; error?: string }>;
  /** Bounded polls for verifyTx before 409 (default 4; tests set 1). */
  orderTxTries?: number;
  /** Mutable watch-loop state surfaced by /capabilities (replay.ts sync). */
  watchState?: { height: number | null; hash: string | null; lastRunAt: number | null; lastError: string | null };
}

const ORDER_ID_RE = P2P_ORDER_ID_RE;
const SWAP_ID_RE = /^swap-[0-9a-f]{16}$/;
const TXID_RE = /^[0-9a-f]{64}$/i;
/** Receipt/QR cap as data-URL characters (≈512 KiB binary image). */
const MAX_RECEIPT_CHARS = 700_000;

/**
 * Decode a `data:image/…;base64,…` receipt to its bytes, or null when the
 * payload is not base64. The anchored hash is taken over these bytes — not
 * over the data-URL string — so `sha256 <the image file>` reproduces it
 * (docs/p2p.md §14).
 */
function receiptBytes(receipt: string): Buffer | null {
  const comma = receipt.indexOf(",");
  if (comma < 0 || !receipt.slice(0, comma).endsWith(";base64")) return null;
  const payload = receipt.slice(comma + 1).replace(/\s+/g, "");
  if (!payload) return null;
  const bytes = Buffer.from(payload, "base64");
  if (!bytes.length) return null;
  // Buffer.from is lenient — round-trip to reject payloads that were not
  // actually base64 (URL-safe alphabets, truncated padding, garbage).
  if (bytes.toString("base64").replace(/=+$/, "") !== payload.replace(/=+$/, "")) return null;
  return bytes;
}

function redact(swap: P2pSwapEvent): P2pSwapView {
  const { receiveAddress: _r, ...view } = swap;
  return view;
}

/** A PQ (ML-DSA-87) escrow key from a did:key, or null (classic/Ed25519 unsupported here). */
function escrowKeyFromDid(did: string | undefined): PQKey | null {
  if (!did) return null;
  try {
    return PQKey.fromPrefixedPublicKey(pqPubFromDid(did));
  } catch {
    return null;
  }
}

export async function buildApp(deps: SettlementDeps): Promise<FastifyInstance> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const guard = deps.guard ?? new ReplayGuard(now);
  const app = Fastify({ logger: deps.log ?? env.SETTLEMENT_LOG === "1" });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  const corsOrigins = new Set(
    (env.CORS_ORIGIN ?? "http://localhost:3000,http://127.0.0.1:3000,http://localhost,http://127.0.0.1")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (!origin || !(corsOrigins.has(origin) || /^https:\/\/([a-z0-9-]+\.)*bigt\.ai$/.test(origin))) return;
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "origin");
    if (req.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET,HEAD,POST,OPTIONS");
      reply.header("access-control-allow-headers", String(req.headers["access-control-request-headers"] ?? "*"));
      reply.header("access-control-max-age", "600");
      return reply.code(204).send();
    }
  });

  const engineDid = () => env.SETTLEMENT_ENGINE_DID?.trim() || "";
  const adminToken = () => env.SETTLEMENT_ADMIN_TOKEN?.trim() || "";

  /**
   * Enabled CNY collection methods (docs/p2p.md §11). Unset or empty → all
   * three (an env file that forgets the line must not silently kill the
   * rails); `SETTLEMENT_CNY_RAILS=wechat,bank` restricts.
   */
  function cnyRails(): string[] {
    const raw = env.SETTLEMENT_CNY_RAILS;
    if (raw === undefined || !raw.trim()) return [...CNY_RAILS];
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => (CNY_RAILS as readonly string[]).includes(s));
  }

  /** Buyer-facing payment instructions for a CNY swap (PII: party-scoped only). */
  function instructionsView(swap: P2pSwapEvent, profile: PaymentProfile, remark: string) {
    const ttl = Number(env.SETTLEMENT_CNY_REMARK_TTL ?? "900");
    return {
      method: profile.method,
      rail: swap.wantRail,
      accountName: profile.accountName,
      account: profile.account,
      ...(profile.bankName ? { bankName: profile.bankName } : {}),
      ...(profile.qr ? { qr: profile.qr } : {}),
      amount: swap.wantAmount,
      currency: swap.wantCurrency,
      remark,
      payBy: Math.floor(now() / 1000) + (Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 900),
    };
  }

  function escrowFor(sellerDid?: string, buyerDid?: string): string | undefined {
    const seller = escrowKeyFromDid(sellerDid);
    const buyer = escrowKeyFromDid(buyerDid);
    const engineHex = env.SETTLEMENT_ENGINE_PUBKEY?.trim();
    if (!seller || !buyer || !engineHex) return undefined;
    try {
      const engine = PQKey.fromPrefixedPublicKey(hexToBytes(engineHex));
      return escrowAddress([seller, buyer, engine], 2);
    } catch {
      return undefined;
    }
  }

  async function persist(event: P2pSwapEvent): Promise<P2pSwapEvent> {
    let txid: string | undefined;
    if (deps.anchor) {
      const res = await deps.anchor(event);
      txid = res?.txid;
    }
    const stored = txid ? { ...event, txid } : event;
    await deps.store.appendEvent(stored);
    return stored;
  }

  //────────── escrow settlement closure (docs/p2p.md) ────────────────────────
  // The wallet pre-signs the two deterministic spend skeletons at lock; the
  // engine holds the second signature (its key is the 2-of-3's engine
  // participant), broadcasts the assembled transaction, and moves the state
  // machine only after CONFIRMED. Everything fails closed before a broadcast.

  const enginePubkeyHex = () => env.SETTLEMENT_ENGINE_PUBKEY?.trim() || "";

  /** Confirmation wait for one spend (SETTLEMENT_ESCROW_POLL_MS, default 25s). */
  function escrowPollOpts(): { pollMs: number; intervalMs: number } {
    const raw = Number(env.SETTLEMENT_ESCROW_POLL_MS ?? "");
    const pollMs = Number.isFinite(raw) && raw >= 0 ? raw : 25_000;
    return { pollMs, intervalMs: 2_000 };
  }

  type EscrowContext = { vault: Escrow; engineKey: PQKey };
  type SettleResult =
    | { ok: true; status: string; txHash: string | null; pending: boolean }
    | { ok: false; code: number; reason: string };

  /**
   * Rebuild this swap's vault and check it against the lock: the engine's own
   * key must be a participant and the derived address must be the one the
   * seller funded — anything else is a key/config mismatch, never a spend.
   */
  function escrowContext(swap: P2pSwapEvent): EscrowContext | { code: number; reason: string } {
    const pubHex = enginePubkeyHex();
    if (!pubHex || !env.SETTLEMENT_ENGINE_KEY?.trim()) {
      return { code: 503, reason: "engine escrow key not configured" };
    }
    const vault = vaultFor(swap.sellerDid, swap.buyerDid, pubHex);
    if (!vault) return { code: 409, reason: "swap has no escrow vault (non-PQ party key)" };
    let engineKey: PQKey;
    try {
      engineKey = engineSigner(env);
    } catch (e) {
      return { code: 503, reason: (e as Error).message };
    }
    if (vault.indexOf(engineKey) < 0) {
      return { code: 503, reason: "engine key is not an escrow participant" };
    }
    if (!swap.escrowAddress || vault.address(settlementParams(env)).toBase58() !== swap.escrowAddress) {
      return { code: 409, reason: "escrow address does not match the vault keys" };
    }
    return { vault, engineKey };
  }

  /** Persist the spend's tx hash (and the signature that made it) before waiting —
   *  the restart path: a crash after broadcast must still find the transaction. */
  async function rememberSpend(swap: P2pSwapEvent, fields: Partial<EscrowSigning>): Promise<void> {
    const existing = await deps.store.getEscrowSigning(swap.swapId);
    await deps.store.putEscrowSigning({
      swapId: swap.swapId,
      refundAddress: fields.refundAddress || existing?.refundAddress || "",
      releaseSig: fields.releaseSig || existing?.releaseSig || "",
      refundSig: fields.refundSig || existing?.refundSig || "",
      releaseSignerDid: fields.releaseSignerDid || existing?.releaseSignerDid || "",
      refundSignerDid: fields.refundSignerDid || existing?.refundSignerDid || "",
      sellerDid: existing?.sellerDid || swap.sellerDid || "",
      releaseTxHash: fields.releaseTxHash !== undefined ? fields.releaseTxHash : (existing?.releaseTxHash ?? null),
      refundTxHash: fields.refundTxHash !== undefined ? fields.refundTxHash : (existing?.refundTxHash ?? null),
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    });
  }

  /** CONFIRMED → move the state machine (release then completes CNY swaps). */
  async function finishSettle(
    swap: P2pSwapEvent,
    kind: EscrowKind,
    txHash: string,
    actorDid: string,
  ): Promise<SettleResult> {
    const target = kind === "release" ? "ESCROW_RELEASED" : "ESCROW_REFUNDED";
    const latest = (await deps.store.getSwap(swap.swapId)) ?? swap;
    if (latest.status !== target && !canTransition(latest.status, target)) {
      if (latest.status === "ESCROW_REFUNDED" || latest.status === "COMPLETED") {
        // Already settled by a previous attempt — idempotent success.
        return { ok: true, status: latest.status, txHash, pending: false };
      }
      return { ok: false, code: 409, reason: `cannot ${latest.status} → ${target}` };
    }
    if (latest.status === target) return { ok: true, status: latest.status, txHash, pending: false };
    const evidence: Partial<P2pSwapEvent> =
      kind === "release" ? { releaseTxHash: txHash } : { refundTxHash: txHash };
    let stored = await persist({
      ...latest,
      ...evidence,
      seq: latest.seq + 1,
      status: target,
      eventType: kind === "release" ? "release" : "refund",
      actorDid,
      at: now(),
    });
    // CNY rails have no fiat payout step — the seller already got the CNY,
    // so `complete` closes the loop while the engine is the acting signer.
    if (kind === "release" && isCnyRail(stored.wantRail) && canTransition(stored.status, "COMPLETED")) {
      stored = await persist({
        ...stored,
        seq: stored.seq + 1,
        status: "COMPLETED",
        eventType: "complete",
        actorDid,
        at: now(),
      });
    }
    return { ok: true, status: stored.status, txHash, pending: false };
  }

  /**
   * The settlement closure: rebuild the agreed spend, verify the caller's (or
   * the stored presigned) signature over the exact bytes, add the engine's,
   * broadcast, and only move the state machine once CONFIRMED. With no chain
   * client wired (mem/test mode) it falls back to the plain unproved
   * transition — the same behavior `escrow_lock` has there.
   */
  async function settleEscrow(opts: {
    swap: P2pSwapEvent;
    kind: EscrowKind;
    /** Caller's signature over the skeleton; null → the stored presign. */
    sigHex: string | null;
    /** Whose signature `sigHex` is (recorded so the hook can re-verify later). */
    signerDid: string;
    signerKey: PQKey | null;
    refundAddress?: string;
    actorDid: string;
  }): Promise<SettleResult> {
    const { swap, kind } = opts;
    const target = kind === "release" ? "ESCROW_RELEASED" : "ESCROW_REFUNDED";
    const row = await deps.store.getEscrowSigning(swap.swapId);
    const priorTx = kind === "release" ? row?.releaseTxHash ?? null : row?.refundTxHash ?? null;
    if (!canTransition(swap.status, target)) {
      // A retry after a finished spend (client lost the response, hook raced a
      // cosign): report the stored outcome instead of a spurious conflict.
      const settled =
        (kind === "release" &&
          (swap.status === "ESCROW_RELEASED" || swap.status === "COMPLETED")) ||
        (kind === "refund" && swap.status === "ESCROW_REFUNDED");
      if (settled) return { ok: true, status: swap.status, txHash: priorTx, pending: false };
      return { ok: false, code: 409, reason: `cannot ${swap.status} → ${target}` };
    }
    if (kind === "release") {
      const reason = frozen(swap);
      if (reason) return { ok: false, code: 422, reason: `swap frozen: ${reason}` };
    }
    if (!deps.chain) {
      const stored = await persist({
        ...swap,
        seq: swap.seq + 1,
        status: target,
        eventType: kind === "release" ? "release" : "refund",
        actorDid: opts.actorDid,
        at: now(),
      });
      return { ok: true, status: stored.status, txHash: null, pending: false };
    }

    const ctx = escrowContext(swap);
    if ("code" in ctx) return { ok: false, code: ctx.code, reason: ctx.reason };
    if (!swap.escrowTxHash || !swap.escrowAddress) {
      return { ok: false, code: 409, reason: "swap has no locked escrow" };
    }
    const toBase58 = kind === "release" ? swap.receiveAddress ?? "" : opts.refundAddress ?? "";
    const to = toBase58 ? destAddress(toBase58) : null;
    if (!to) {
      return {
        ok: false,
        code: kind === "release" ? 409 : 400,
        reason: kind === "release" ? "swap has no receive address" : "refundAddress required",
      };
    }

    const submitted = kind === "release" ? row?.releaseTxHash : row?.refundTxHash;
    const sigHex = opts.sigHex ?? (kind === "release" ? row?.releaseSig || null : row?.refundSig || null);

    // A transaction we already broadcast: wait on it instead of rebuilding —
    // the same skeleton would produce the same bytes anyway (idempotent).
    if (submitted) {
      const out = await awaitConfirmed(deps.chain, submitted, to, escrowPollOpts());
      if (out.confirmed) return finishSettle(swap, kind, out.txHash, opts.actorDid);
      if (out.status !== "DROPPED") {
        return { ok: true, status: swap.status, txHash: out.txHash, pending: true };
      }
      // Dropped (reorg/conflict): rebuild below and resubmit the same bytes.
    }

    if (!sigHex) return { ok: false, code: 409, reason: `no stored ${kind} signature` };
    let signerKey = opts.signerKey;
    for (const did of [opts.signerDid, swap.sellerDid ?? ""]) {
      if (signerKey || !did) break;
      try {
        signerKey = keyFromDid(did);
      } catch {
        // classic/Ed25519 did — cannot hold an escrow key; keep looking
      }
    }
    if (!signerKey) return { ok: false, code: 409, reason: "no escrow signer" };
    const signerIdx = ctx.vault.indexOf(signerKey);
    const engineIdx = ctx.vault.indexOf(ctx.engineKey);
    if (signerIdx < 0 || signerIdx === engineIdx) {
      return { ok: false, code: 409, reason: "signer is not an escrow participant" };
    }

    const skeleton = await buildSkeleton({
      chain: deps.chain,
      vault: ctx.vault,
      escrowAddress: swap.escrowAddress,
      escrowTxHash: swap.escrowTxHash,
      to,
    });
    if (!skeleton) {
      return { ok: false, code: 409, reason: "escrow output not found (lock unconfirmed or already spent)" };
    }
    if (!verifyParticipantSig(skeleton.sighash, sigHex, signerKey)) {
      return { ok: false, code: 422, reason: `${kind} signature does not verify` };
    }
    const engineSig = Utils.HEX.encode(ctx.engineKey.sign(skeleton.sighash).serialize());
    assembleSpend(ctx.vault, skeleton.tx, new Map([[signerIdx, sigHex], [engineIdx, engineSig]]));
    const txHash = skeleton.tx.getHash().toString();
    try {
      await broadcastSpend(deps.chain, skeleton.tx);
    } catch (e) {
      return { ok: false, code: 502, reason: `broadcast failed: ${String(e).slice(0, 160)}` };
    }
    await rememberSpend(
      swap,
      kind === "release"
        ? { releaseSig: sigHex, releaseSignerDid: opts.signerDid, releaseTxHash: txHash }
        : { refundSig: sigHex, refundSignerDid: opts.signerDid, refundAddress: toBase58, refundTxHash: txHash },
    );
    const out = await awaitConfirmed(deps.chain, txHash, to, escrowPollOpts());
    if (out.confirmed) return finishSettle(swap, kind, txHash, opts.actorDid);
    return { ok: true, status: swap.status, txHash, pending: true };
  }

  // ── escrow settlement hook ────────────────────────────────────────────────
  // Finishes pre-signed swaps while nobody is watching: release at
  // PAYMENT_VERIFIED, refund at EXPIRED. A swap only qualifies when the
  // seller presigned at lock (no stored row → the parties drive it), so
  // e2e/manual flows behave exactly as before. SETTLEMENT_ESCROW_HOOK_MS=0
  // (the default) disables the timer — the tick stays exported for tests.
  const inFlight = new Set<string>();
  const escrowHookTick = async () => {
    if (inFlight.size || !deps.chain) return;
    let swaps: P2pSwapEvent[] = [];
    try {
      swaps = await deps.store.listSwaps(500);
    } catch {
      return;
    }
    for (const swap of swaps) {
      if (swap.status !== "PAYMENT_VERIFIED" && swap.status !== "EXPIRED") continue;
      if (inFlight.has(swap.swapId)) continue;
      const row = await deps.store.getEscrowSigning(swap.swapId);
      if (!row) continue;
      const kind: EscrowKind = swap.status === "PAYMENT_VERIFIED" ? "release" : "refund";
      const hasSig = kind === "release" ? !!row.releaseSig : !!row.refundSig;
      const hasTx = kind === "release" ? !!row.releaseTxHash : !!row.refundTxHash;
      if (!hasSig && !hasTx) continue;
      if (kind === "release" && !swap.receiveAddress) continue;
      if (kind === "refund" && !row.refundAddress) continue;
      inFlight.add(swap.swapId);
      try {
        const signerDid = kind === "release" ? row.releaseSignerDid : row.refundSignerDid;
        let signerKey: PQKey | null = null;
        if (signerDid) {
          try {
            signerKey = keyFromDid(signerDid);
          } catch {
            signerKey = null;
          }
        }
        const res = await settleEscrow({
          swap,
          kind,
          sigHex: null,
          signerDid: signerDid || swap.sellerDid || "",
          signerKey,
          refundAddress: row.refundAddress,
          actorDid: kind === "release" ? engineDid() || swap.sellerDid || "" : swap.sellerDid || "",
        });
        if (!res.ok) {
          app.log.warn({ swapId: swap.swapId, kind, reason: res.reason }, "escrow hook: settlement deferred");
        }
      } catch (e) {
        app.log.warn({ swapId: swap.swapId, kind, err: String(e) }, "escrow hook: settlement failed");
      } finally {
        inFlight.delete(swap.swapId);
      }
    }
  };
  app.decorate("escrowHookTick", escrowHookTick);

  const hookRaw = Number(env.SETTLEMENT_ESCROW_HOOK_MS ?? "");
  const hookMs = Number.isFinite(hookRaw) && hookRaw > 0 ? hookRaw : 0;
  if (hookMs > 0) {
    const timer = setInterval(() => void escrowHookTick(), hookMs);
    timer.unref?.();
    const boot = setTimeout(() => void escrowHookTick(), Math.min(hookMs, 5_000));
    boot.unref?.();
    app.addHook("onClose", async () => {
      clearInterval(timer);
      clearTimeout(boot);
    });
  }


  /** Trust-model freeze: an open dispute or a refund arbitration pauses
   *  progress. expire/refund/cancel stay available so locked tokens can still
   *  come home. */
  function frozen(swap: P2pSwapEvent): string | null {
    if (swap.disputeOutcome === "refund") return "dispute resolved: refund ordered";
    if (swap.dispute && swap.dispute !== "RESOLVED") return `dispute ${swap.dispute}`;
    return null;
  }

  function requireAdmin(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }): boolean {
    const token = adminToken();
    if (!token || req.headers["x-settlement-admin-token"] !== token) {
      reply.code(403).send({ error: "admin token required" });
      return false;
    }
    return true;
  }

  app.get("/healthz", async () => ({ ok: true }));

  /**
   * Public capability report (no auth): which rails this engine serves. CNY
   * rails are engine config (`SETTLEMENT_CNY_RAILS`); the wallet reads this at
   * boot and hides rails that would only ever fail (docs/p2p.md).
   * `escrow`/`chain` are diagnostics: `chain.l0` false means lock proofs are
   * accepted WITHOUT verification (server.ts escrow_lock), never a prod state.
   */
  app.get("/capabilities", async () => ({
    ok: true,
    rails: [...cnyRails()],
    escrow: !!env.SETTLEMENT_ENGINE_PUBKEY?.trim(),
    /** Public escrow key: the wallet rebuilds the 2-of-3 vault with it. */
    escrowPubkey: env.SETTLEMENT_ENGINE_PUBKEY?.trim() || null,
    chain: { l0: !!deps.chain, l1: !!deps.anchor, orderTxVerify: !!(deps.verifyTx || deps.verifyOrderTx) },
    /** Chain-scan projector position (null until the watcher has run). */
    watch: deps.watchState ? { ...deps.watchState } : null,
  }));

  /**
   * Confirm a seller-anchored order txid: bounded polls of the intake gate (the
   * tx was just submitted, so one 0-wait check would race confirmation).
   * `verifyOrderTx` (full record match) wins over `verifyTx` (confirmation
   * only); with neither there is no chain check (mock/dev).
   */
  async function orderTxVerified(check: OrderTxCheck): Promise<{ ok: boolean; error?: string }> {
    if (!deps.verifyOrderTx && !deps.verifyTx) return { ok: true };
    const tries = Math.max(1, deps.orderTxTries ?? 4);
    let error = "txid not confirmed on L1-SOCIAL";
    for (let i = 0; i < tries; i++) {
      const r = deps.verifyOrderTx
        ? await deps.verifyOrderTx(check)
        : (await deps.verifyTx!(check.txid))
          ? { ok: true }
          : { ok: false, error: "txid not confirmed on L1-SOCIAL" };
      if (r.ok) return { ok: true };
      error = r.error ?? error;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, error };
  }

  app.post("/orders", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { sellerDid, giveToken, giveAmount, giveChain, wantCurrency, wantAmount, wantRail, validUntil } = body as any;
    if (typeof sellerDid !== "string" || !sellerDid) return reply.code(400).send({ error: "sellerDid required" });
    for (const [k, v] of Object.entries({ giveToken, giveAmount, giveChain, wantCurrency, wantAmount, wantRail })) {
      if (typeof v !== "string" || !v) return reply.code(400).send({ error: `${k} required` });
    }
    if (!/^\d+(\.\d+)?$/.test(String(giveAmount)) || !/^\d+(\.\d+)?$/.test(String(wantAmount))) {
      return reply.code(400).send({ error: "amounts must be decimal strings" });
    }
    // rail must be one of the CNY methods configured for this engine
    if (!cnyRails().includes(String(wantRail))) {
      return reply.code(400).send({ error: `wantRail not enabled (one of: ${cnyRails().join(", ")})` });
    }
    if (typeof validUntil !== "number" || validUntil * 1000 <= now()) {
      return reply.code(400).send({ error: "validUntil must be in the future (unix seconds)" });
    }
    // Seller-anchored orders carry the orderId the record already committed to
    // and the L1-SOCIAL txid that landed it; both are optional so the legacy
    // engine-intake path (mock / no chain) keeps working.
    const orderId = body.orderId === undefined ? `ord-${randomBytes(8).toString("hex")}` : String(body.orderId);
    if (!ORDER_ID_RE.test(orderId)) return reply.code(400).send({ error: "invalid orderId" });
    const txid = body.txid === undefined ? undefined : String(body.txid);
    if (txid !== undefined && !TXID_RE.test(txid)) return reply.code(400).send({ error: "invalid txid" });
    const signed = validateSignedRequest(body, sellerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (txid !== undefined) {
      const gate = await orderTxVerified({
        txid,
        sellerDid,
        orderId,
        status: "OPEN",
        terms: { giveToken, giveAmount, giveChain, wantCurrency, wantAmount, wantRail, validUntil },
      });
      if (!gate.ok) return reply.code(409).send({ error: gate.error ?? "txid not confirmed on L1-SOCIAL" });
    }
    const existing = await deps.store.getOrder(orderId);
    if (existing) {
      // Idempotent re-register of the same order (app retry after a dropped
      // response); a different seller/order collision is a hard conflict.
      if (existing.sellerDid !== sellerDid) return reply.code(409).send({ error: "orderId already in use" });
      return reply.code(200).send({ orderId, status: existing.status, txid: existing.txid ?? txid ?? null });
    }

    const order: P2pOrder = {
      orderId,
      type: "limit_sell",
      sellerDid,
      giveToken,
      giveAmount,
      giveChain,
      wantCurrency,
      wantAmount,
      wantRail,
      validUntil,
      status: "ACTIVE",
      signature: String(body.signature),
      ...(txid !== undefined ? { txid } : {}),
      createdAt: now(),
    };
    await deps.store.createOrder(order);
    return reply.code(201).send({ orderId: order.orderId, status: order.status, txid: order.txid ?? null });
  });

  app.post<{ Params: { orderId: string } }>("/orders/:orderId/cancel", async (request, reply) => {
    const { orderId } = request.params;
    if (!ORDER_ID_RE.test(orderId)) return reply.code(400).send({ error: "invalid orderId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sellerDid = body.sellerDid;
    if (typeof sellerDid !== "string" || !sellerDid) return reply.code(400).send({ error: "sellerDid required" });
    const order = await deps.store.getOrder(orderId);
    if (!order) return reply.code(404).send({ error: "unknown order" });
    if (order.sellerDid !== sellerDid) return reply.code(403).send({ error: "not the seller" });
    const txid = body.txid === undefined ? undefined : String(body.txid);
    if (txid !== undefined && !TXID_RE.test(txid)) return reply.code(400).send({ error: "invalid txid" });
    const signed = validateSignedRequest(body, sellerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (order.status === "CANCELLED") return reply.code(200).send({ orderId, status: "CANCELLED" });
    if (order.status !== "ACTIVE") return reply.code(409).send({ error: `order is ${order.status}` });
    if (txid !== undefined) {
      const gate = await orderTxVerified({ txid, sellerDid, orderId, status: "CANCELLED" });
      if (!gate.ok) return reply.code(409).send({ error: gate.error ?? "txid not confirmed on L1-SOCIAL" });
    }
    if (!(await deps.store.markOrderCancelled(orderId))) {
      return reply.code(409).send({ error: "order is no longer active" });
    }
    return reply.code(200).send({ orderId, status: "CANCELLED", txid: txid ?? null });
  });

  app.get("/orders", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const status = (request.query as { status?: string })?.status;
    return { orders: await deps.store.listOrders(status) };
  });

  // Public order book for wallet clients: open sell orders carry no PII, so
  // they are readable without the admin token. Defaults to ACTIVE only.
  /**
   * Derived reputation (docs/p2p.md §25) — a pure projection of the swap event
   * log, memoized briefly so the public order book does not rescan the log on
   * every request. PII-free by construction (counts, rates, latencies, public
   * DIDs).
   */
  let repCache: { at: number; map: Map<string, ReputationReport> } | null = null;
  async function reputationMap(): Promise<Map<string, ReputationReport>> {
    const ttlMs = 30_000;
    if (repCache && Date.now() - repCache.at < ttlMs) return repCache.map;
    const map = reputationFromEvents(await deps.store.allEvents());
    repCache = { at: Date.now(), map };
    return map;
  }

  /** Compact seller stats for the public order book (badge). */
  function compactReputation(r: ReputationReport) {
    return {
      tier: r.seller.tier,
      trades: r.seller.trades,
      completionRate: r.seller.completionRate,
      disputes: r.seller.disputes,
      lostDisputes: r.seller.lostDisputes,
    };
  }

  app.get("/public/orders", async (request, reply) => {
    const q = (request.query as { status?: string }) ?? {};
    const status = q.status === undefined ? "ACTIVE" : q.status;
    const orders = await deps.store.listOrders(status);
    const map = await reputationMap();
    return {
      orders: orders.map(({ signature: _s, ...o }) => ({
        ...o,
        sellerReputation: compactReputation(reputationForDid(o.sellerDid, map)),
      })),
    };
  });

  /**
   * Public reputation summary (docs/p2p.md §25): derived from the anchored
   * swap log, role-aware (separate seller/buyer profiles), wash-resistant
   * (pair-capped). Unknown DIDs get zeroed roles so badges render without a
   * 404.
   */
  app.get<{ Params: { did: string } }>("/public/reputation/:did", async (request, reply) => {
    const { did } = request.params;
    if (!did || did.length > 512) return reply.code(400).send({ error: "invalid did" });
    return reputationForDid(did, await reputationMap());
  });

  /** Admin: the per-swap attribution behind the public summary. */
  app.get<{ Params: { did: string } }>("/admin/reputation/:did", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { did } = request.params;
    if (!did || did.length > 512) return reply.code(400).send({ error: "invalid did" });
    return reputationDetail(await deps.store.allEvents(), did);
  });

  app.post<{ Params: { orderId: string } }>("/orders/:orderId/match", async (request, reply) => {
    const { orderId } = request.params;
    if (!ORDER_ID_RE.test(orderId)) return reply.code(400).send({ error: "invalid orderId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const buyerDid = body.buyerDid;
    if (typeof buyerDid !== "string" || !buyerDid) return reply.code(400).send({ error: "buyerDid required" });
    if (typeof body.receiveAddress !== "string" || !body.receiveAddress) {
      return reply.code(400).send({ error: "receiveAddress required" });
    }
    const order = await deps.store.getOrder(orderId);
    if (!order) return reply.code(404).send({ error: "unknown order" });
    if (order.status !== "ACTIVE") return reply.code(409).send({ error: `order is ${order.status}` });
    if (order.validUntil * 1000 <= now()) return reply.code(410).send({ error: "order expired" });
    const signed = validateSignedRequest(body, buyerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });

    const swapId = `swap-${randomBytes(8).toString("hex")}`;
    const event: P2pSwapEvent = {
      swapId,
      seq: 0,
      status: "MATCHED",
      eventType: "match",
      actorDid: buyerDid,
      orderId,
      sellerDid: order.sellerDid,
      buyerDid,
      giveChain: order.giveChain,
      giveToken: order.giveToken,
      giveAmount: order.giveAmount,
      wantAmount: order.wantAmount,
      wantRail: order.wantRail,
      wantCurrency: order.wantCurrency,
      escrowAddress: escrowFor(order.sellerDid, buyerDid),
      receiveAddress: body.receiveAddress,
      at: now(),
    };
    // Conditional ACTIVE→MATCHED: two concurrent matches race here and the
    // first claim wins (the loser never anchors a second MATCHED event).
    if (!(await deps.store.markOrderMatched(orderId, swapId))) {
      return reply.code(409).send({ error: "order is no longer active" });
    }
    let stored: P2pSwapEvent;
    try {
      stored = await persist(event);
    } catch (e) {
      // Anchor/store failure after the claim: put the order back so the seller
      // is not left with a MATCHED order that has no swap (replay would flag
      // the same gap later — better to heal it now).
      await deps.store.reopenOrder(orderId, swapId);
      throw e;
    }
    return reply.code(201).send({ swapId, status: stored.status, escrowAddress: stored.escrowAddress ?? null });
  });

  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/transitions", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const action = body.action;
    if (typeof action !== "string") return reply.code(400).send({ error: "action required" });
    const target = statusForAction(action);
    if (!target) return reply.code(400).send({ error: `unknown action ${action}` });
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    // The CNY-rail actions have dedicated routes with their own input validation
    // (docs/p2p.md §11); the generic transitions route must not bypass it.
    if (DEDICATED_ACTIONS.has(action)) {
      return reply.code(400).send({
        error: `action ${action} has a dedicated route (/swaps/:swapId/payment-instructions | proof | confirm)`,
      });
    }
    // Who must sign this transition? release/complete are the ENGINE's act
    // (the old engine let the buyer self-assert them).
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (action === "cancel") {
      if (did !== swap.buyerDid && did !== swap.sellerDid) return reply.code(403).send({ error: "not a swap party" });
    } else if (action === "release" || action === "complete") {
      if (!engineDid() || did !== engineDid()) return reply.code(403).send({ error: "engine signer required" });
    } else if (did !== swap.sellerDid) {
      return reply.code(403).send({ error: "seller signer required" });
    }
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (!canTransition(swap.status, target)) return reply.code(409).send({ error: `cannot ${swap.status} → ${target}` });
    // An open dispute / refund arbitration freezes the forward path;
    // expire/refund/cancel stay available so locked tokens can still come home.
    if (action === "release" || action === "complete") {
      const reason = frozen(swap);
      if (reason) return reply.code(422).send({ error: `swap frozen: ${reason}` });
    }

    const evidence: Partial<P2pSwapEvent> = {};
    if (action === "escrow_lock") {
      if (typeof body.txHash !== "string" || !body.txHash) return reply.code(400).send({ error: "txHash required" });
      if (deps.chain) {
        if (!swap.escrowAddress) return reply.code(409).send({ error: "swap has no escrow address" });
        const proof = await verifyChainLock(deps.chain, {
          txHash: body.txHash,
          escrowAddress: swap.escrowAddress,
          token: swap.giveToken,
          amount: swap.giveAmount,
        });
        if (!proof.ok) return reply.code(422).send({ error: proof.reason ?? "chain verification failed" });
      }
      evidence.escrowTxHash = body.txHash;
    } else if (action === "release") {
      if (typeof body.txHash !== "string" || !body.txHash) return reply.code(400).send({ error: "txHash required" });
      if (deps.chain) {
        const to = swap.receiveAddress;
        if (!to) return reply.code(409).send({ error: "swap has no receive address" });
        const proof = await verifyChainPayment(deps.chain, { txHash: body.txHash, toAddress: to });
        if (!proof.ok) return reply.code(422).send({ error: proof.reason ?? "chain verification failed" });
      }
      evidence.releaseTxHash = body.txHash;
    }

    const stored = await persist({
      ...swap,
      ...evidence,
      seq: swap.seq + 1,
      status: target,
      eventType: action as SwapAction,
      actorDid: did,
      at: now(),
    });
    return { swapId, status: stored.status, txid: stored.txid ?? null };
  });

  app.get<{ Params: { swapId: string } }>("/swaps/:swapId", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    return { swap: redact(swap) };
  });

  // Party-scoped swap reads for wallet clients: signed with the caller's did,
  // PII redacted, and only swaps the caller is a party to are returned.
  /**
   * Wallet-facing swap projection: the redacted view plus whether the seller
   * has pre-signed both spend skeletons (the escrow hook arm state — the UI
   * offers the presign retry only while this is false).
   */
  async function walletView(swap: P2pSwapEvent): Promise<P2pSwapView> {
    return { ...redact(swap), presigned: !!(await deps.store.getEscrowSigning(swap.swapId)) };
  }

  app.post("/swaps/mine", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const swaps = await deps.store.listSwapsForDid(did);
    return { swaps: await Promise.all(swaps.map(walletView)) };
  });

  app.post("/swaps/get", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const did = typeof body.did === "string" ? body.did : "";
    const swapId = typeof body.swapId === "string" ? body.swapId : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (swap.sellerDid !== did && swap.buyerDid !== did) return reply.code(403).send({ error: "not a swap party" });
    return { swap: await walletView(swap) };
  });

  /** Admin: latest state per swap, newest first (dai's p2p_status listing). */
  app.get("/swaps", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const raw = (request.query as { limit?: string })?.limit;
    const limit = raw === undefined ? 100 : Number(raw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return reply.code(400).send({ error: "invalid limit" });
    const swaps = await deps.store.listSwaps(limit);
    return { swaps: swaps.map(redact) };
  });

  //────────── CNY rails (docs/p2p.md) ─────────────────────────────────────
  // No API and no webhook exists for a personal WeChat/Alipay/bank transfer:
  // the buyer pays the seller directly and the seller's own confirmation is
  // the fiat signal. The engine never touches CNY — it enforces the protocol
  // (instructions → proof → confirm), freezes on dispute, and hands release to
  // the engine only after payment is confirmed (by seller or arbiter).

  /**
   * Buyer pulls the seller's CNY payment profile + a per-swap remark code the
   * transfer must carry (§6: the seller checks amount+remark+time+流水号 on
   * their own statements — screenshots never count). Buyer-signed; idempotent
   * while PAYMENT_PENDING; the profile itself stays off the chain record.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/payment-instructions", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (!swap.buyerDid) return reply.code(409).send({ error: "swap has no buyer" });
    if (!swap.sellerDid) return reply.code(409).send({ error: "swap has no seller" });
    if (!isCnyRail(swap.wantRail)) return reply.code(400).send({ error: "not a CNY swap" });
    const buyer = typeof body.did === "string" ? body.did : "";
    if (!buyer) return reply.code(400).send({ error: "did required" });
    if (buyer !== swap.buyerDid) return reply.code(403).send({ error: "buyer signer required" });
    const signed = validateSignedRequest(body, swap.buyerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const frozenReason = frozen(swap);
    if (frozenReason) return reply.code(422).send({ error: `swap frozen: ${frozenReason}` });
    const profile = await deps.store.getProfile(swap.sellerDid, swap.wantRail);
    if (!profile) return reply.code(409).send({ error: "seller has no payment profile for this rail" });
    if (swap.status === "PAYMENT_PENDING" && swap.remark) {
      return { swapId, status: swap.status, ...instructionsView(swap, profile, swap.remark) };
    }
    if (swap.status !== "ESCROW_LOCKED") {
      return reply.code(409).send({ error: `instructions require ESCROW_LOCKED (swap is ${swap.status})` });
    }
    const remark = randomBytes(6).toString("hex");
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      status: "PAYMENT_PENDING",
      eventType: "instructions",
      actorDid: swap.buyerDid,
      remark,
      at: now(),
    });
    return reply.code(201).send({ swapId, status: stored.status, ...instructionsView(stored, profile, remark) });
  });

  /**
   * Buyer claims the transfer: 流水号 (txId) required, receipt image optional
   * and stored as-is in the proof store while only its sha256 is anchored on
   * the swap event (§8: receipt bytes never reach the chain).
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/proof", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (!swap.buyerDid) return reply.code(409).send({ error: "swap has no buyer" });
    if (!isCnyRail(swap.wantRail)) return reply.code(400).send({ error: "not a CNY swap" });
    const buyer = typeof body.did === "string" ? body.did : "";
    if (!buyer) return reply.code(400).send({ error: "did required" });
    if (buyer !== swap.buyerDid) return reply.code(403).send({ error: "buyer signer required" });
    const signed = validateSignedRequest(body, swap.buyerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const frozenReason = frozen(swap);
    if (frozenReason) return reply.code(422).send({ error: `swap frozen: ${frozenReason}` });
    if (swap.status !== "PAYMENT_PENDING") {
      return reply.code(409).send({ error: `proof requires PAYMENT_PENDING (swap is ${swap.status})` });
    }
    const txId = typeof body.txId === "string" ? body.txId.trim() : "";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(txId)) {
      return reply.code(400).send({ error: "invalid txId (1..64: alnum . _ -)" });
    }
    if (body.remark !== undefined && body.remark !== swap.remark) {
      return reply.code(400).send({ error: "remark does not match the instructions" });
    }
    const receipt = typeof body.receipt === "string" && body.receipt ? body.receipt : undefined;
    if (receipt !== undefined && receipt.length > MAX_RECEIPT_CHARS) {
      return reply.code(413).send({ error: `receipt too large (max ${MAX_RECEIPT_CHARS} chars)` });
    }
    let sha = typeof body.receiptSha256 === "string" ? body.receiptSha256 : undefined;
    if (receipt !== undefined) {
      if (!receipt.startsWith("data:image/")) return reply.code(400).send({ error: "receipt must be an image data URL" });
      const bytes = receiptBytes(receipt);
      if (!bytes) return reply.code(400).send({ error: "receipt must be base64 (data:image/…;base64,…)" });
      // The engine hashes the decoded image bytes — a client-computed hash is
      // advisory and is overwritten, so the anchor always matches the stored
      // file (`sha256 <file>` reproduces it).
      sha = createHash("sha256").update(bytes).digest("hex");
    }
    if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) return reply.code(400).send({ error: "invalid receiptSha256" });

    const paidAt = now();
    await deps.store.addProof({
      swapId,
      txId,
      ...(swap.remark ? { remark: swap.remark } : {}),
      ...(sha ? { receiptSha256: sha } : {}),
      ...(receipt !== undefined ? { receipt } : {}),
      paidAt,
      createdAt: paidAt,
    });
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      status: "PAYMENT_CLAIMED",
      eventType: "payment_proof",
      actorDid: swap.buyerDid,
      ...(sha ? { receiptSha256: sha } : {}),
      paidAt,
      at: paidAt,
    });
    return { swapId, status: stored.status, txId, receiptSha256: stored.receiptSha256 ?? null };
  });

  /**
   * Seller confirms receipt on their own 流水 (§6). Seller-signed — after it
   * the engine releases tokens.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/confirm", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (did !== swap.sellerDid) return reply.code(403).send({ error: "seller signer required" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const frozenReason = frozen(swap);
    if (frozenReason) return reply.code(422).send({ error: `swap frozen: ${frozenReason}` });
    if (swap.status !== "PAYMENT_CLAIMED") {
      return reply.code(409).send({ error: `confirm requires PAYMENT_CLAIMED (swap is ${swap.status})` });
    }
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      status: "PAYMENT_VERIFIED",
      eventType: "payment_confirm",
      actorDid: did,
      at: now(),
    });
    return { swapId, status: stored.status };
  });

  /** Either party can freeze a CNY swap mid-review; tokens stay locked. */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/dispute", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (did !== swap.buyerDid && did !== swap.sellerDid) return reply.code(403).send({ error: "not a swap party" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (swap.dispute && swap.dispute !== "RESOLVED") return reply.code(409).send({ error: "dispute already open" });
    if (swap.status !== "PAYMENT_PENDING" && swap.status !== "PAYMENT_CLAIMED") {
      return reply.code(409).send({ error: `dispute requires PAYMENT_PENDING or PAYMENT_CLAIMED (swap is ${swap.status})` });
    }
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 512) : undefined;
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      eventType: "dispute_open",
      actorDid: did,
      dispute: "OPEN",
      ...(reason ? { disputeReason: reason } : {}),
      at: now(),
    });
    return { swapId, status: stored.status, dispute: stored.dispute, disputeReason: stored.disputeReason ?? null };
  });

  /**
   * Admin arbitration (§1: arbiter = the engine operator, off-platform
   * evidence). `release` verifies the swap and resumes the forward path;
   * `refund` keeps the status but freezes the swap permanently — expire/refund
   * then bring the tokens home.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/dispute/resolve", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (!swap.dispute || swap.dispute === "RESOLVED") return reply.code(409).send({ error: "no active dispute" });
    const outcome = body.outcome;
    if (outcome !== "release" && outcome !== "refund") {
      return reply.code(400).send({ error: "outcome must be release | refund" });
    }
    if (outcome === "release" && !canTransition(swap.status, "PAYMENT_VERIFIED")) {
      return reply.code(409).send({ error: `cannot ${swap.status} → PAYMENT_VERIFIED` });
    }
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      ...(outcome === "release" ? { status: "PAYMENT_VERIFIED" as const } : {}),
      eventType: "dispute_resolve",
      actorDid: engineDid() || undefined,
      dispute: "RESOLVED",
      disputeOutcome: outcome,
      at: now(),
    });
    return { swapId, status: stored.status, dispute: stored.dispute, disputeOutcome: stored.disputeOutcome };
  });

  /**
   * Seller: pre-sign both escrow spend skeletons once the lock is CONFIRMED
   * (docs/p2p.md — the settlement closure). The engine rebuilds its own copy
   * of each skeleton and verifies both signatures before storing them, so a
   * bad presign can never strand a swap at settlement time. Store-only:
   * nothing here is anchored or broadcast — the escrow hook later spends with
   * its own key as the second signature.
   */
  /**
   * Escrow signing context (party-scoped): what the wallet needs to rebuild
   * the two spend skeletons. The general swap view redacts `receiveAddress`
   * (the release destination) because it is only needed here — both parties
   * pull it over this signed, escrow-only endpoint instead of widening the
   * view. `presigned` mirrors the wallet-view flag for the retry flow.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/escrow/context", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (did !== swap.sellerDid && did !== swap.buyerDid) return reply.code(403).send({ error: "not a swap party" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (!swap.escrowAddress || !swap.escrowTxHash) return reply.code(409).send({ error: "swap has no locked escrow" });
    const row = await deps.store.getEscrowSigning(swapId);
    return {
      swapId,
      escrowAddress: swap.escrowAddress,
      escrowTxHash: swap.escrowTxHash,
      receiveAddress: swap.receiveAddress ?? "",
      sellerDid: swap.sellerDid ?? "",
      buyerDid: swap.buyerDid ?? "",
      presigned: !!row,
    };
  });

  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/escrow/presign", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (did !== swap.sellerDid) return reply.code(403).send({ error: "seller signer required" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (!deps.chain) return reply.code(503).send({ error: "chain not configured" });
    if (!swap.escrowTxHash || !swap.escrowAddress) return reply.code(409).send({ error: "swap has no locked escrow" });
    const releaseSig = typeof body.releaseSig === "string" ? body.releaseSig.trim() : "";
    const refundSig = typeof body.refundSig === "string" ? body.refundSig.trim() : "";
    const refundAddress = typeof body.refundAddress === "string" ? body.refundAddress.trim() : "";
    if (!releaseSig || !refundSig) return reply.code(400).send({ error: "releaseSig and refundSig required" });
    if (!destAddress(refundAddress)) return reply.code(400).send({ error: "refundAddress must be a base58 address" });
    const receive = swap.receiveAddress ? destAddress(swap.receiveAddress) : null;
    if (!receive) return reply.code(409).send({ error: "swap has no receive address" });

    const ctx = escrowContext(swap);
    if ("code" in ctx) return reply.code(ctx.code).send({ error: ctx.reason });
    let sellerKey: PQKey;
    try {
      sellerKey = keyFromDid(did);
    } catch {
      return reply.code(409).send({ error: "did has no PQ escrow key" });
    }
    if (ctx.vault.indexOf(sellerKey) < 0) {
      return reply.code(409).send({ error: "seller key is not an escrow participant" });
    }
    const releaseSkel = await buildSkeleton({
      chain: deps.chain,
      vault: ctx.vault,
      escrowAddress: swap.escrowAddress,
      escrowTxHash: swap.escrowTxHash,
      to: receive,
    });
    const refundSkel = await buildSkeleton({
      chain: deps.chain,
      vault: ctx.vault,
      escrowAddress: swap.escrowAddress,
      escrowTxHash: swap.escrowTxHash,
      to: destAddress(refundAddress)!,
    });
    if (!releaseSkel || !refundSkel) {
      return reply.code(409).send({ error: "escrow output not found (lock unconfirmed or already spent)" });
    }
    if (!verifyParticipantSig(releaseSkel.sighash, releaseSig, sellerKey)) {
      return reply.code(422).send({ error: "releaseSig does not verify against the release skeleton" });
    }
    if (!verifyParticipantSig(refundSkel.sighash, refundSig, sellerKey)) {
      return reply.code(422).send({ error: "refundSig does not verify against the refund skeleton" });
    }
    await rememberSpend(swap, {
      refundAddress,
      releaseSig,
      refundSig,
      releaseSignerDid: did,
      refundSignerDid: did,
    });
    return { swapId, presigned: true, refundAddress };
  });

  /**
   * Party co-sign (Path A): the wallet signs the exact skeleton, the engine
   * adds its own key, broadcasts, and settles the state machine only after
   * CONFIRMED — the manual counterpart of the escrow hook, which does the same
   * for a presigned swap with nobody watching. `kind=refund` is seller-only:
   * a refund pays the seller's `refundAddress`, which only the seller chooses.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/escrow/cosign", async (request, reply) => {
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (did !== swap.sellerDid && did !== swap.buyerDid) return reply.code(403).send({ error: "not a swap party" });
    const kind = body.kind === "release" || body.kind === "refund" ? (body.kind as EscrowKind) : null;
    if (!kind) return reply.code(400).send({ error: "kind must be release | refund" });
    if (kind === "refund" && did !== swap.sellerDid) return reply.code(403).send({ error: "seller signer required for a refund" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const sigHex = typeof body.sig === "string" ? body.sig.trim() : "";
    if (!sigHex) return reply.code(400).send({ error: "sig required" });
    let refundAddress = "";
    if (kind === "refund") {
      const fromBody = typeof body.refundAddress === "string" ? body.refundAddress.trim() : "";
      const row = fromBody ? null : await deps.store.getEscrowSigning(swapId);
      refundAddress = fromBody || row?.refundAddress || "";
      if (!destAddress(refundAddress)) return reply.code(400).send({ error: "refundAddress required (body or presign)" });
    }
    let signerKey: PQKey;
    try {
      signerKey = keyFromDid(did);
    } catch {
      return reply.code(409).send({ error: "did has no PQ escrow key" });
    }
    const res = await settleEscrow({
      swap,
      kind,
      sigHex,
      signerDid: did,
      signerKey,
      refundAddress,
      actorDid: kind === "release" ? engineDid() || did : did,
    });
    if (!res.ok) return reply.code(res.code).send({ error: res.reason });
    return reply.code(res.pending ? 202 : 200).send({
      swapId,
      status: res.status,
      txHash: res.txHash,
      pending: res.pending,
    });
  });

  /** Seller: upsert a CNY collection profile. PII: store + instruction reveals only. */
  app.post("/profiles", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    const method = typeof body.method === "string" ? body.method : "";
    if (!(CNY_RAILS as readonly string[]).includes(method)) {
      return reply.code(400).send({ error: `method must be one of: ${CNY_RAILS.join(", ")}` });
    }
    const accountName = typeof body.accountName === "string" ? body.accountName.trim() : "";
    if (!accountName || accountName.length > 64) return reply.code(400).send({ error: "invalid accountName (1..64)" });
    const account = typeof body.account === "string" ? body.account.trim() : "";
    if (!account || account.length > 128) return reply.code(400).send({ error: "invalid account (1..128)" });
    const bankName = typeof body.bankName === "string" && body.bankName.trim() ? body.bankName.trim() : undefined;
    if (bankName && bankName.length > 64) return reply.code(400).send({ error: "invalid bankName (1..64)" });
    const qr = typeof body.qr === "string" && body.qr ? body.qr : undefined;
    if (qr && qr.length > MAX_RECEIPT_CHARS) return reply.code(413).send({ error: `qr too large (max ${MAX_RECEIPT_CHARS} chars)` });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const profile: PaymentProfile = {
      sellerDid: did,
      method: method as CnyRail,
      accountName,
      account,
      ...(bankName ? { bankName } : {}),
      ...(qr ? { qr } : {}),
      updatedAt: now(),
    };
    await deps.store.upsertProfile(profile);
    return { ok: true, method, updatedAt: profile.updatedAt };
  });

  /** Seller: list own profiles. */
  app.post("/profiles/mine", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    return { profiles: await deps.store.listProfiles(did) };
  });

  return app;
}

async function main() {
  const { Pool } = await import("pg");
  const { PgSettlementStore, MemSettlementStore } = await import("./store.js");
  const { BlobSettlementStore } = await import("./storeBlob.js");
  const { blobStoreFromEnv } = await import("./blob.js");
  const { anchorFromEnv, l1Anchor } = await import("./anchor.js");
  const { PooledChainClient, poolFromEnv } = await import("./discovery.js");
  const { syncOnce, HttpSocialSource, fetchRecordByTxid, pgCursorStore, MemCursorStore, ensureWatchSchema } = await import("./replay.js");
  const env = process.env;
  // Store selection: pg (default when POSTGRES_URL is set), blob (no Postgres —
  // chain-derived projection in memory + confidential data in the encrypted
  // blob store), or mem (dev/e2e). A blob deploy without a blob target throws.
  const storeMode = env.SETTLEMENT_STORE === "mem" || env.SETTLEMENT_STORE === "blob"
    ? env.SETTLEMENT_STORE
    : env.POSTGRES_URL
      ? "pg"
      : "mem";
  const pool = storeMode === "pg" ? new Pool({ connectionString: env.POSTGRES_URL! }) : null;
  const store =
    storeMode === "pg"
      ? new PgSettlementStore(pool!)
      : storeMode === "blob"
        ? new BlobSettlementStore(blobStoreFromEnv(env))
        : new MemSettlementStore();
  if (pool) await ensureWatchSchema(pool);
  console.log(`p2p-engine: store=${storeMode}`);
  const anchorCfg = anchorFromEnv(env);
  if ((env.SETTLEMENT_L1_URL || env.SETTLEMENT_L1_SOCIAL_URL || env.SETTLEMENT_L1_SOCIAL_URLS) && !anchorCfg) {
    console.warn(
      "p2p-engine: L1-SOCIAL configured but SETTLEMENT_ENGINE_KEY is missing/invalid or SETTLEMENT_ENGINE_DID is mismatched — swap events will NOT be anchored",
    );
  }
  // Discovery (docs/p2p.md): pinned URLs first, optional DNS/registry, and a
  // health-gated pool per role. Boot probes run before listen so the first
  // request already has a verified endpoint (or fails closed, as with no env).
  const l0Pool = poolFromEnv(env, "l0");
  const socialPool = poolFromEnv(env, "social");
  await Promise.all([l0Pool?.start(), socialPool?.start()]);
  const anchor = anchorCfg
    ? l1Anchor(socialPool ? { ...anchorCfg, resolveUrl: () => socialPool.best() } : anchorCfg)
    : undefined;
  // Seller-anchored orders land on L1-SOCIAL before the index sees them: prove
  // the confirmed block carries the exact `social.p2p-order` record the request
  // claims (docs/p2p.md §11). No social endpoint configured → no check
  // (mock/dev). Fail-closed once configured: a node that is down returns
  // `{ok:false}` (409), never a silent accept.
  const socialUrl = () => socialPool?.best() ?? (env.SETTLEMENT_L1_SOCIAL_URL?.trim() || null);
  const socialConfigured = !!(
    socialPool ||
    env.SETTLEMENT_L1_SOCIAL_URL?.trim() ||
    env.SETTLEMENT_L1_SOCIAL_URLS?.trim() ||
    env.SETTLEMENT_L1_URL?.trim() ||
    env.L1_SOCIAL_URL?.trim()
  );
  const verifyOrderTx =
    socialConfigured && env.SETTLEMENT_ORDER_TX_VERIFY !== "0"
      ? async (check: OrderTxCheck): Promise<{ ok: boolean; error?: string }> => {
          const url = socialUrl();
          if (!url) return { ok: false, error: "no healthy L1-SOCIAL endpoint" };
          let st;
          try {
            st = await new HttpChainClient(url).transactionStatus(check.txid);
          } catch {
            return { ok: false, error: "L1-SOCIAL unreachable" };
          }
          if (st.status !== "CONFIRMED") return { ok: false, error: "txid not confirmed on L1-SOCIAL" };
          if (!st.blockHash) return { ok: false, error: "confirmed tx has no block hash" };
          let rec: Record<string, unknown> | null;
          try {
            rec = await fetchRecordByTxid(
              new HttpSocialSource(url, fetch, 10_000, settlementParams(env)),
              st.blockHash,
              check.txid,
            );
          } catch {
            return { ok: false, error: "L1-SOCIAL block read failed" };
          }
          if (!rec) return { ok: false, error: "anchored order record not found in the confirmed block" };
          const valid = validateP2pOrderRecord(rec as never);
          if (!valid.ok) return { ok: false, error: `anchored order record invalid: ${valid.error}` };
          if (!verifyRecordSig(rec as never)) return { ok: false, error: "anchored order record signature invalid" };
          const r = rec as unknown as P2pOrderRecord;
          if (r.from !== check.sellerDid) return { ok: false, error: "anchored record author is not the seller" };
          if (r.to !== check.orderId) return { ok: false, error: "anchored record orderId mismatch" };
          if (r.status !== check.status) return { ok: false, error: "anchored record status mismatch" };
          if (check.status === "OPEN" && check.terms) {
            for (const field of ["giveToken", "giveAmount", "giveChain", "wantCurrency", "wantAmount", "wantRail"] as const) {
              if (String(r[field] ?? "") !== String(check.terms[field])) {
                return { ok: false, error: `anchored record ${field} mismatch` };
              }
            }
            if (Number(r.validUntil) !== check.terms.validUntil) {
              return { ok: false, error: "anchored record validUntil mismatch" };
            }
          }
          return { ok: true };
        }
      : undefined;
  const watchState = { height: null as number | null, hash: null as string | null, lastRunAt: null as number | null, lastError: null as string | null };
  // Blob mode keeps its chain-derived projection in memory, so it must replay
  // from the chain at boot (the projector is not optional there).
  const watchOn = (env.SETTLEMENT_WATCH === "1" || storeMode === "blob") && socialConfigured;
  if (storeMode === "blob" && !socialConfigured) {
    console.warn("p2p-engine: store=blob without an L1-SOCIAL endpoint — the order/swap projection cannot be rebuilt");
  }
  const app = await buildApp({
    store,
    chain: l0Pool ? new PooledChainClient(l0Pool) : null,
    ...(anchor ? { anchor } : {}),
    ...(verifyOrderTx ? { verifyOrderTx, orderTxTries: Number(env.SETTLEMENT_ORDER_TX_TRIES ?? 4) } : {}),
    ...(watchOn ? { watchState } : {}),
  });
  app.addHook("onClose", async () => {
    l0Pool?.stop();
    socialPool?.stop();
    if (watchTimer) clearInterval(watchTimer);
  });
  // Chain-scan projector (docs/p2p.md §14): on boot + every interval, walk
  // back from the head to the cursor and apply new records. Mem store replays
  // from genesis each boot (idempotent); PG resumes from p2p_watch_cursor.
  let watchTimer: NodeJS.Timeout | undefined;
  if (watchOn) {
    const cursors = pool ? pgCursorStore(pool) : new MemCursorStore();
    const maxWalk = Number(env.SETTLEMENT_WATCH_MAX_WALK ?? 2000);
    const tick = async () => {
      try {
        const url = socialUrl();
        if (!url) throw new Error("no healthy L1-SOCIAL endpoint");
        const r = await syncOnce(new HttpSocialSource(url), store, cursors, { maxWalk });
        if (r.error) watchState.lastError = r.error;
        else {
          watchState.height = r.cursor?.height ?? null;
          watchState.hash = r.cursor?.hash ?? null;
          watchState.lastError = r.conflicts.length ? `${r.conflicts.length} conflict(s)` : null;
          if (r.conflicts.length) console.warn("p2p-engine watch: conflicts", r.conflicts.slice(0, 5));
        }
      } catch (e) {
        watchState.lastError = e instanceof Error ? e.message : String(e);
      } finally {
        watchState.lastRunAt = Date.now();
      }
    };
    await tick();
    watchTimer = setInterval(() => void tick(), Number(env.SETTLEMENT_WATCH_INTERVAL_MS ?? 15_000));
    watchTimer.unref?.();
  }
  await app.listen({ port: Number(env.PORT ?? 8108), host: env.HOST ?? "127.0.0.1" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
