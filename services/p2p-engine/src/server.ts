/**
 * P2P settlement engine (docs/p2p.md).
 *
 *   POST /orders                              seller posts a signed limit order
 *   GET  /orders                              admin: list open orders
 *   GET  /public/orders                       wallet: list open orders (no PII, no sig)
 *   POST /orders/:orderId/match               buyer matches (derives escrow)
 *   POST /payments/send                       buyer records a fiat-payment hint
 *   POST /swaps/:swapId/transitions           signed state transition
 *   POST /swaps/mine                          wallet: party-scoped swap list
 *   POST /swaps/get                           wallet: one party-scoped swap
 *   POST /swaps/:swapId/invoice               admin: issue/retry the fiat invoice (step 4)
 *   POST /swaps/:swapId/payout-sync           admin: poll payout outcome (webhook fallback)
 *   GET  /swaps/:swapId                       admin: swap view (PII redacted)
 *   GET  /swaps?limit=                        admin: latest state per swap
 *   POST /webhooks/paypal                     RSA-verified, idempotent
 *
 * Only the engine (or the seller for lock/expire/refund) can advance a swap;
 * the state machine is append-only and every durable transition is anchored as
 * a `social.p2p-swap` record through the injected `anchor` hook — anchor
 * failure fails the transition (the chain record is the durable seed).
 */
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { hexToBytes } from "did";
import { pqPubFromDid } from "did/pq";
import { PQKey } from "bigtangle-ts";
import { ACTION_STATUS, canTransition, statusForAction } from "./state.js";
import { ReplayGuard, validateSignedRequest } from "./sign.js";
import { escrowAddress } from "./escrow.js";
import { verifyChainLock, verifyChainPayment, HttpChainClient, type ChainClient } from "./chain.js";
import { paypalConfig, verifyWebhookSignature, type WebhookHeaders } from "./paypal.js";
import { HttpPaypalClient, MockPaypalClient, type PaypalClient } from "./paypalClient.js";
import type { P2pOrder, P2pSwapEvent, P2pSwapView, SwapAction } from "./types.js";
import type { SettlementStore } from "./store.js";

export interface SettlementDeps {
  store: SettlementStore;
  env?: NodeJS.ProcessEnv;
  guard?: ReplayGuard;
  paypal?: PaypalClient | null;
  chain?: ChainClient | null;
  now?: () => number;
  log?: boolean;
  /** Verify a PayPal webhook (defaults to the RSA scheme + env webhook id). */
  verifyWebhook?: (headers: WebhookHeaders, rawBody: string) => Promise<boolean>;
  /** Anchor a swap event on chain (returns the txid). Default: no-op. */
  anchor?: (event: P2pSwapEvent) => Promise<{ txid?: string } | void>;
}

const ORDER_ID_RE = /^ord-[0-9a-f]{16}$/;
const SWAP_ID_RE = /^swap-[0-9a-f]{16}$/;

function redact(swap: P2pSwapEvent): P2pSwapView {
  const { paypalAccount: _p, receiveAddress: _r, buyerEmail: _b, ...view } = swap;
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

  /** Step 4: create + send the exact-amount invoice (invoice_number = swapId). */
  async function issueInvoice(
    paypal: PaypalClient,
    swapId: string,
    email: string,
    amount: string,
    currency: string,
  ): Promise<{ invoiceId: string; invoiceUrl?: string }> {
    const invoice = await paypal.createInvoice(swapId, email, amount, currency);
    await paypal.sendInvoice(invoice.id);
    return { invoiceId: invoice.id, ...(invoice.url ? { invoiceUrl: invoice.url } : {}) };
  }

  /** Trust-model freeze: reversed capture or open dispute pauses progress. */
  function frozen(swap: P2pSwapEvent): string | null {
    if (swap.paymentReversed) return "payment reversed (PayPal capture clawed back)";
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
    if (typeof validUntil !== "number" || validUntil * 1000 <= now()) {
      return reply.code(400).send({ error: "validUntil must be in the future (unix seconds)" });
    }
    const signed = validateSignedRequest(body, sellerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });

    const order: P2pOrder = {
      orderId: `ord-${randomBytes(8).toString("hex")}`,
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
      createdAt: now(),
    };
    await deps.store.createOrder(order);
    return reply.code(201).send({ orderId: order.orderId, status: order.status });
  });

  app.get("/orders", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const status = (request.query as { status?: string })?.status;
    return { orders: await deps.store.listOrders(status) };
  });

  // Public order book for wallet clients: open sell orders carry no PII, so
  // they are readable without the admin token. Defaults to ACTIVE only.
  app.get("/public/orders", async (request, reply) => {
    const q = (request.query as { status?: string }) ?? {};
    const status = q.status === undefined ? "ACTIVE" : q.status;
    const orders = await deps.store.listOrders(status);
    return { orders: orders.map(({ signature: _s, ...o }) => o) };
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
    if (typeof body.paypalAccount !== "string" || !body.paypalAccount) {
      return reply.code(400).send({ error: "paypalAccount required" });
    }
    // invoice recipient (step 4) — PII: engine store + redacted views only, never anchored
    const buyerEmail =
      typeof body.buyerEmail === "string" && body.buyerEmail.trim() ? body.buyerEmail.trim() : undefined;
    if (buyerEmail && buyerEmail.length > 256) return reply.code(400).send({ error: "invalid buyerEmail (1..256)" });
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
      paypalAccount: body.paypalAccount,
      ...(buyerEmail ? { buyerEmail } : {}),
      at: now(),
    };
    await deps.store.markOrderMatched(orderId, swapId);
    const stored = await persist(event);
    return reply.code(201).send({ swapId, status: stored.status, escrowAddress: stored.escrowAddress ?? null });
  });

  app.post("/payments/send", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const swapId = body.swapId;
    if (typeof swapId !== "string" || !SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (!swap.buyerDid) return reply.code(409).send({ error: "swap has no buyer" });
    if (typeof body.paymentRef !== "string" || !body.paymentRef) {
      return reply.code(400).send({ error: "paymentRef required" });
    }
    const signed = validateSignedRequest(body, swap.buyerDid, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const target = ACTION_STATUS.payment_send;
    if (!canTransition(swap.status, target)) return reply.code(409).send({ error: `cannot ${swap.status} → ${target}` });
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      status: target,
      eventType: "payment_send",
      actorDid: swap.buyerDid,
      paymentRail: "paypal",
      paymentRef: body.paymentRef,
      at: now(),
    });
    return { swapId, status: stored.status, rail: stored.paymentRail };
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

    // Who must sign this transition? verify/release/payout are the ENGINE's
    // act (the old engine let the buyer self-assert them).
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    if (action === "cancel") {
      if (did !== swap.buyerDid && did !== swap.sellerDid) return reply.code(403).send({ error: "not a swap party" });
    } else if (action === "verify" || action === "release" || action === "payout") {
      if (!engineDid() || did !== engineDid()) return reply.code(403).send({ error: "engine signer required" });
    } else if (did !== swap.sellerDid) {
      return reply.code(403).send({ error: "seller signer required" });
    }
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    if (!canTransition(swap.status, target)) return reply.code(409).send({ error: `cannot ${swap.status} → ${target}` });
    // Reversed capture / open dispute freezes the forward path; expire/refund/
    // cancel stay available so locked tokens can still come home.
    if (action === "verify" || action === "release" || action === "payout") {
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
      // Step 4 — the engine originates the invoice so INVOICING.INVOICE.PAID
      // fires. Best-effort: a PayPal blip must not block an already-verified
      // lock; the admin invoice route retries issuance.
      if (deps.paypal && swap.buyerEmail && !swap.invoiceId) {
        try {
          Object.assign(
            evidence,
            await issueInvoice(deps.paypal, swapId, swap.buyerEmail, swap.wantAmount ?? "0", swap.wantCurrency ?? "USD"),
          );
        } catch (e) {
          app.log.warn({ swapId, err: String(e) }, "invoice issuance failed");
        }
      }
    } else if (action === "release") {
      if (typeof body.txHash !== "string" || !body.txHash) return reply.code(400).send({ error: "txHash required" });
      if (deps.chain) {
        const to = swap.receiveAddress;
        if (!to) return reply.code(409).send({ error: "swap has no receive address" });
        const proof = await verifyChainPayment(deps.chain, { txHash: body.txHash, toAddress: to });
        if (!proof.ok) return reply.code(422).send({ error: proof.reason ?? "chain verification failed" });
      }
      evidence.releaseTxHash = body.txHash;
    } else if (action === "payout") {
      if (deps.paypal) {
        if (!swap.paypalAccount) return reply.code(409).send({ error: "swap has no paypal account" });
        try {
          const payout = await deps.paypal.createPayout(swapId, swap.paypalAccount, swap.wantAmount ?? "0", swap.wantCurrency ?? "USD");
          evidence.payoutRef = payout.id;
          if (payout.itemId) evidence.payoutItemId = payout.itemId;
          // Step 7 evidence: item SUCCESS arrives via the payout webhook or
          // payout-sync; until then the batch is PENDING.
          evidence.payoutStatus = "PENDING";
        } catch (e) {
          return reply.code(502).send({ error: `payout failed: ${String(e).slice(0, 120)}` });
        }
      } else if (typeof body.payoutRef === "string") {
        evidence.payoutRef = body.payoutRef;
      }
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
    return {
      swapId,
      status: stored.status,
      txid: stored.txid ?? null,
      ...(stored.invoiceId
        ? { invoiceId: stored.invoiceId, ...(stored.invoiceUrl ? { invoiceUrl: stored.invoiceUrl } : {}) }
        : {}),
      ...(stored.payoutRef ? { payoutRef: stored.payoutRef, payoutStatus: stored.payoutStatus ?? null } : {}),
    };
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
  app.post("/swaps/mine", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const did = typeof body.did === "string" ? body.did : "";
    if (!did) return reply.code(400).send({ error: "did required" });
    const signed = validateSignedRequest(body, did, guard);
    if (!signed.ok) return reply.code(signed.status ?? 400).send({ error: signed.error });
    const swaps = await deps.store.listSwapsForDid(did);
    return { swaps: swaps.map(redact) };
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
    return { swap: redact(swap) };
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

  /**
   * Step 4 — issue (or retry) the exact-amount invoice for a locked swap.
   * The engine normally does this inside `escrow_lock`; this route is the
   * retry path when issuance failed there or the swap matched without an
   * email. Idempotent: an already-issued invoice is returned, not recreated.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/invoice", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    if (!deps.paypal) return reply.code(503).send({ error: "paypal not configured" });
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (swap.invoiceId) {
      return { swapId, status: swap.status, invoiceId: swap.invoiceId, invoiceUrl: swap.invoiceUrl ?? null, existing: true };
    }
    if (swap.status !== "ESCROW_LOCKED") {
      return reply.code(409).send({ error: `invoice requires ESCROW_LOCKED (swap is ${swap.status})` });
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email =
      typeof body.buyerEmail === "string" && body.buyerEmail.trim() ? body.buyerEmail.trim() : swap.buyerEmail;
    if (!email || email.length > 256) {
      return reply.code(400).send({ error: "buyerEmail required (carry it on match or pass it here)" });
    }
    let issued: { invoiceId: string; invoiceUrl?: string };
    try {
      issued = await issueInvoice(deps.paypal, swapId, email, swap.wantAmount ?? "0", swap.wantCurrency ?? "USD");
    } catch (e) {
      return reply.code(502).send({ error: `invoice failed: ${String(e).slice(0, 120)}` });
    }
    const stored = await persist({
      ...swap,
      seq: swap.seq + 1,
      eventType: "invoice",
      actorDid: engineDid() || undefined,
      buyerEmail: email,
      ...issued,
      at: now(),
    });
    return reply
      .code(201)
      .send({ swapId, status: stored.status, invoiceId: stored.invoiceId, invoiceUrl: stored.invoiceUrl ?? null });
  });

  /**
   * Payout-outcome fallback (docs/p2p.md): poll the batch we created and
   * record the observed status when it changed — the path when
   * `PAYMENT.PAYOUTS-ITEM.*` webhooks are late or lost. The webhook handler
   * persists the same fields; both are idempotent on the observed status.
   */
  app.post<{ Params: { swapId: string } }>("/swaps/:swapId/payout-sync", async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const { swapId } = request.params;
    if (!SWAP_ID_RE.test(swapId)) return reply.code(400).send({ error: "invalid swapId" });
    if (!deps.paypal) return reply.code(503).send({ error: "paypal not configured" });
    const swap = await deps.store.getSwap(swapId);
    if (!swap) return reply.code(404).send({ error: "unknown swap" });
    if (!swap.payoutRef) return reply.code(409).send({ error: "swap has no payout" });
    let live: { status?: string; itemId?: string };
    try {
      live = await deps.paypal.getPayout(swap.payoutRef);
    } catch (e) {
      return reply.code(502).send({ error: `payout status failed: ${String(e).slice(0, 120)}` });
    }
    if (live.status && live.status !== swap.payoutStatus) {
      const stored = await persist({
        ...swap,
        seq: swap.seq + 1,
        eventType: "payout_poll",
        actorDid: engineDid() || undefined,
        payoutStatus: live.status,
        ...(live.itemId ? { payoutItemId: live.itemId } : {}),
        at: now(),
      });
      return { swapId, status: stored.status, payoutRef: stored.payoutRef, payoutStatus: stored.payoutStatus, changed: true };
    }
    return {
      swapId,
      status: swap.status,
      payoutRef: swap.payoutRef,
      payoutStatus: swap.payoutStatus ?? null,
      changed: false,
    };
  });

  app.post("/webhooks/paypal", async (request, reply) => {
    const raw = (request as { rawBody?: string }).rawBody ?? "";
    const headers = request.headers as WebhookHeaders;
    const cfg = paypalConfig(env);
    if (!cfg && env.SETTLEMENT_PAYPAL_INSECURE !== "1") {
      return reply.code(503).send({ error: "paypal not configured" });
    }
    const verify =
      deps.verifyWebhook ??
      ((h: WebhookHeaders, body: string) => verifyWebhookSignature(h, body, cfg?.webhookId ?? ""));
    if (!(await verify(headers, raw))) return reply.code(401).send({ error: "invalid signature" });

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "invalid json" });
    }
    const type = String(event?.event_type ?? "");
    const resource = event.resource ?? {};

    // Resolve the swap from correlation ids PayPal actually carries: the
    // swap id itself (invoice_number / sender_batch_id) or a reference we
    // stored earlier (invoice id, payout batch id).
    async function matchSwap(candidates: unknown[]): Promise<P2pSwapEvent | null> {
      for (const c of candidates) {
        if (typeof c !== "string" || !c) continue;
        const swap = SWAP_ID_RE.test(c) ? await deps.store.getSwap(c) : await deps.store.findSwapByRef(c);
        if (swap) return swap;
      }
      return null;
    }
    function idempotent(swap: P2pSwapEvent, extra: Record<string, unknown> = {}) {
      return { received: true, swapId: swap.swapId, status: swap.status, idempotent: true, ...extra };
    }

    if (type === "INVOICING.INVOICE.PAID") {
      const swap = await matchSwap([
        resource.invoice_number,
        resource.invoice?.invoice_number,
        resource.custom_id,
        resource.invoice?.id,
        resource.invoice_id,
      ]);
      if (!swap) return { received: true, ignored: "unknown invoice" };
      // idempotent: only advance from PAYMENT_PENDING
      if (swap.status !== "PAYMENT_PENDING") return idempotent(swap);
      const stored = await persist({
        ...swap,
        seq: swap.seq + 1,
        status: "PAYMENT_VERIFIED",
        eventType: "paypal_webhook",
        actorDid: engineDid() || undefined,
        paymentRail: "paypal",
        at: now(),
      });
      return { received: true, swapId: swap.swapId, status: stored.status };
    }

    // Outbound payout outcome (docs/p2p.md): SUCCEEDED finalizes the evidence,
    // FAILED/HELD surfaces for a `payout` retry with the same request id.
    if (type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" || type === "PAYMENT.PAYOUTS-ITEM.FAILED" || type === "PAYMENT.PAYOUTS-ITEM.HELD") {
      const observed = type.endsWith("SUCCEEDED") ? "SUCCESS" : type.endsWith("FAILED") ? "FAILED" : "ONHOLD";
      const swap = await matchSwap([
        resource.batch_header?.sender_batch_id,
        resource.batch_header?.payout_batch_id,
        resource.sender_batch_id,
        resource.payout_batch_id,
        resource.payout_item_id,
        resource.payout_item?.payout_batch_id,
      ]);
      if (!swap) return { received: true, ignored: "unmatched payout event" };
      if (swap.payoutStatus === observed) return idempotent(swap, { payoutStatus: observed });
      const stored = await persist({
        ...swap,
        seq: swap.seq + 1,
        eventType: "paypal_webhook",
        actorDid: engineDid() || undefined,
        payoutStatus: observed,
        ...(typeof resource.payout_item_id === "string" ? { payoutItemId: resource.payout_item_id } : {}),
        at: now(),
      });
      return { received: true, swapId: swap.swapId, status: stored.status, payoutStatus: stored.payoutStatus };
    }

    // Capture clawed back — freeze the swap; the seller's expire/refund path
    // brings locked tokens home (docs/p2p.md: "freeze; refund if still locked").
    if (type === "PAYMENT.CAPTURE.REVERSED") {
      const swap = await matchSwap([resource.invoice_id, resource.invoice_number, resource.custom_id, resource.invoice?.id]);
      if (!swap) return { received: true, ignored: "unmatched reversal" };
      if (swap.paymentReversed) return idempotent(swap, { paymentReversed: true });
      const stored = await persist({
        ...swap,
        seq: swap.seq + 1,
        eventType: "paypal_webhook",
        actorDid: engineDid() || undefined,
        paymentReversed: true,
        at: now(),
      });
      return { received: true, swapId: swap.swapId, status: stored.status, paymentReversed: true };
    }

    // Dispute opened/updated/resolved — pause the swap until RESOLVED.
    if (type === "CUSTOMER.DISPUTE.CREATED" || type === "CUSTOMER.DISPUTE.UPDATED" || type === "CUSTOMER.DISPUTE.RESOLVED") {
      const state = type.endsWith("RESOLVED") ? "RESOLVED" : type.endsWith("CREATED") ? "OPEN" : "UPDATED";
      const swap = await matchSwap([resource.invoice_id, resource.invoice_number, resource.custom_id, resource.invoice?.id]);
      if (!swap) return { received: true, ignored: "unmatched dispute" };
      if (swap.dispute === state) return idempotent(swap, { dispute: swap.dispute });
      const stored = await persist({
        ...swap,
        seq: swap.seq + 1,
        eventType: "paypal_webhook",
        actorDid: engineDid() || undefined,
        dispute: state,
        at: now(),
      });
      return { received: true, swapId: swap.swapId, status: stored.status, dispute: stored.dispute };
    }

    return { received: true, ignored: type || "unknown" };
  });

  return app;
}

async function main() {
  const { Pool } = await import("pg");
  const { PgSettlementStore, MemSettlementStore } = await import("./store.js");
  const { anchorFromEnv, l1Anchor } = await import("./anchor.js");
  const env = process.env;
  const store =
    env.SETTLEMENT_STORE === "mem" || !env.POSTGRES_URL
      ? new MemSettlementStore()
      : new PgSettlementStore(new Pool({ connectionString: env.POSTGRES_URL }));
  const cfg = paypalConfig(env);
  const anchorCfg = anchorFromEnv(env);
  if ((env.SETTLEMENT_L1_URL || env.SETTLEMENT_L1_SOCIAL_URL) && !anchorCfg) {
    console.warn(
      "p2p-engine: L1-SOCIAL configured but SETTLEMENT_ENGINE_KEY is missing/invalid or SETTLEMENT_ENGINE_DID is mismatched — swap events will NOT be anchored",
    );
  }
  const app = await buildApp({
    store,
    paypal: cfg
      ? new HttpPaypalClient(cfg)
      : env.SETTLEMENT_PAYPAL_INSECURE === "1"
        ? new MockPaypalClient()
        : null,
    chain: env.SETTLEMENT_L0_URL ? new HttpChainClient(env.SETTLEMENT_L0_URL) : null,
    ...(anchorCfg ? { anchor: l1Anchor(anchorCfg) } : {}),
  });
  await app.listen({ port: Number(env.PORT ?? 8108), host: env.HOST ?? "127.0.0.1" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
