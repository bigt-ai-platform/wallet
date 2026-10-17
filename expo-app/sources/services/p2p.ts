import { P2P_ENGINE_URL, P2P_SOCIAL_URL } from '@/constants/app';
import { serverErrorMessage } from '@/lib/httpError';
import type { PQKey } from 'bigtangle-ts';
import { p2pOrderRecord, type P2pReleaseRecord } from 'p2p-protocol';
import { newOrderId, signP2pRecord, signedBody } from '@/lib/p2pIdentity';
import { anchorSocialRecord } from '@/services/transaction';
import { chainBookEnabled, orderBookFromChain } from '@/services/p2pChain';

/**
 * Thin client for the P2P settlement engine (services/p2p-engine). Reads that
 * are public (the order book) use plain GET; everything that mutates or is
 * party-scoped is signed with the wallet's PQ key.
 */
export type P2pSwapStatus =
  | 'MATCHED'
  | 'ESCROW_LOCKED'
  | 'PAYMENT_PENDING'
  | 'PAYMENT_CLAIMED'
  | 'PAYMENT_VERIFIED'
  | 'ESCROW_RELEASED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'ESCROW_REFUNDED'
  | 'CANCELLED';

export type P2pSwapAction =
  | 'escrow_lock'
  | 'release'
  | 'expire'
  | 'refund'
  | 'cancel'
  | 'instructions'
  | 'payment_proof'
  | 'payment_confirm'
  | 'complete';

/** Fiat rails (docs/p2p.md §7): buyer pays seller directly, seller confirms. */
export type P2pCnyRail = 'wechat' | 'alipay' | 'bank';

export interface P2pOrder {
  orderId: string;
  type: string;
  sellerDid: string;
  giveToken: string;
  giveAmount: string;
  giveChain: string;
  wantCurrency: string;
  wantAmount: string;
  wantRail: string;
  validUntil: number;
  status: 'ACTIVE' | 'MATCHED' | 'CANCELLED';
  swapId?: string;
  /** L1-SOCIAL txid of the seller-anchored social.p2p-order record. */
  txid?: string;
  createdAt: number;
  /**
   * The engine escrow participant this order was pinned to
   * (`P2pOrderRecord.enginePubkey`, docs/p2p.md §26) — the buyer derives the
   * 2-of-3 vault from this when present, instead of `GET /capabilities`.
   * Absent on legacy engine-intake orders.
   */
  enginePubkey?: string;
  /** Derived seller reputation (docs/p2p.md §25) — computed from the anchored
   *  swap log; PII-free counts, rates and tier. */
  sellerReputation?: {
    tier: 'new' | 'established' | 'trusted';
    trades: number;
    trades30d: number;
    completionRate: number;
    disputes: number;
    lostDisputes: number;
  };
}

export interface P2pSwap {
  swapId: string;
  seq: number;
  status: P2pSwapStatus;
  eventType: string;
  sellerDid?: string;
  buyerDid?: string;
  giveChain?: string;
  giveToken?: string;
  giveAmount?: string;
  wantAmount?: string;
  wantCurrency?: string;
  wantRail?: string;
  escrowAddress?: string;
  escrowTxHash?: string;
  releaseTxHash?: string;
  /**
   * The engine escrow participant the swap was created against, when known
   * (docs/p2p.md §26). Preferred over `GET /capabilities` for deriving the
   * 2-of-3 vault, so the wallet does not depend on the engine for the key.
   */
  enginePubkey?: string;
  dispute?: string;
  disputeOutcome?: 'release' | 'refund';
  /** CNY rails: per-swap remark code the transfer must carry. */
  remark?: string;
  receiptSha256?: string;
  paidAt?: number;
  txid?: string;
  /** Seller pre-signed both escrow spend skeletons (the auto-settle hook is armed). */
  presigned?: boolean;
  at: number;
}

export interface P2pIdentity {
  key: PQKey;
  did: string;
}

export interface CreateOrderInput {
  giveToken: string;
  giveAmount: string;
  giveChain: string;
  wantCurrency: string;
  wantAmount: string;
  wantRail: string;
  validUntil: number;
  /**
   * The engine escrow participant to pin this order to (docs/p2p.md §26) —
   * the engine's `escrowPubkey`. Anchored in the record so the buyer derives
   * the vault from the chain instead of `/capabilities`.
   */
  enginePubkey?: string;
}

export interface MatchOrderInput {
  receiveAddress: string;
}

/** Seller's payment instructions for one swap (docs/p2p.md §11). */
export interface P2pPaymentInstructions {
  method: P2pCnyRail;
  rail: string;
  accountName: string;
  account: string;
  bankName?: string;
  qr?: string;
  amount: string;
  currency: string;
  remark: string;
  /** Unix seconds: last moment the remark is guaranteed to be valid. */
  payBy: number;
}

/** The seller's saved collection profile (PII — never leaves the party scope). */
export interface P2pPaymentProfile {
  sellerDid: string;
  method: P2pCnyRail;
  accountName: string;
  account: string;
  bankName?: string;
  qr?: string;
  updatedAt: number;
}

/** Whether a P2P engine endpoint is configured for this build. */
export function p2pConfigured(): boolean {
  return !!P2P_ENGINE_URL;
}

/** Device-verification auto-release policy (`SETTLEMENT_CNY_AUTO_RELEASE_ON`). */
export type P2pAutoReleasePolicy = 'off' | 'seller_receipt' | 'two_sided' | 'verified_receipt';

const AUTO_RELEASE_POLICIES: readonly P2pAutoReleasePolicy[] = ['off', 'seller_receipt', 'two_sided', 'verified_receipt'];

/** Unknown/absent policy → `off` (evidence only) — never enable by typo. */
export function normalizeAutoReleasePolicy(p: unknown): P2pAutoReleasePolicy {
  return typeof p === 'string' && (AUTO_RELEASE_POLICIES as readonly string[]).includes(p)
    ? (p as P2pAutoReleasePolicy)
    : 'off';
}

/** What a deployed engine actually serves (GET /capabilities — public). */
export interface P2pCapabilities {
  /** Enabled rails (CNY collection methods; docs/p2p.md). */
  rails: string[];
  /** Engine escrow pubkey configured (the 2-of-3 participant). */
  escrow: boolean;
  /** Public engine escrow key: rebuilds the 2-of-3 vault to sign escrow spends. */
  escrowPubkey: string | null;
  /** CNY device-verification auto-release policy: does a qualifying phone read
   *  act as the confirm? `off` = evidence only. Absent on older engines. */
  autoReleaseOn: P2pAutoReleasePolicy;
  /** Chain clients wired: l0 = escrow proof/broadcast, l1 = social anchor,
   *  orderTxVerify = the engine confirms order/cancel txids before indexing. */
  chain: { l0: boolean; l1: boolean; orderTxVerify?: boolean };
  /** Chain-scan projector position (null until the watcher has run). */
  watch?: { height: number | null; hash: string | null; lastRunAt: number | null; lastError: string | null } | null;
}

/**
 * The engine's capability report. Returns null (never throws) when the engine
 * is unconfigured, unreachable, or too old to expose /capabilities — callers
 * then keep their built-in defaults (see p2p.ts).
 */
export async function getCapabilities(): Promise<P2pCapabilities | null> {
  if (!p2pConfigured()) return null;
  try {
    const res = await fetch(`${baseUrl()}/capabilities`);
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<P2pCapabilities>;
    if (!Array.isArray(data.rails)) return null;
    return {
      rails: data.rails.filter((r): r is string => typeof r === 'string'),
      escrow: !!data.escrow,
      escrowPubkey: typeof data.escrowPubkey === 'string' && data.escrowPubkey ? data.escrowPubkey : null,
      autoReleaseOn: normalizeAutoReleasePolicy(data.autoReleaseOn),
      chain: {
        l0: !!data.chain?.l0,
        l1: !!data.chain?.l1,
        orderTxVerify: !!data.chain?.orderTxVerify,
      },
      watch: data.watch
        ? {
            height: typeof data.watch.height === 'number' ? data.watch.height : null,
            hash: typeof data.watch.hash === 'string' ? data.watch.hash : null,
            lastRunAt: typeof data.watch.lastRunAt === 'number' ? data.watch.lastRunAt : null,
            lastError: typeof data.watch.lastError === 'string' ? data.watch.lastError : null,
          }
        : null,
    };
  } catch {
    return null;
  }
}

function baseUrl(): string {
  if (!P2P_ENGINE_URL) throw new Error('p2p engine not configured');
  return P2P_ENGINE_URL.replace(/\/$/, '');
}

async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const url = `${baseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'network error');
  }
  const text = await res.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    throw new Error(serverErrorMessage(data, res.status));
  }
  return data as T;
}

/** Public order book (ACTIVE sell orders, no signatures, no PII).
 *
 *  With `EXPO_PUBLIC_P2P_CHAIN_BOOK=1` and a social node configured, the book
 *  is derived straight from L1-SOCIAL (docs/p2p.md §26) so no engine is needed
 *  to browse; any failure falls back to the engine's `/public/orders`. */
export async function listOpenOrders(): Promise<P2pOrder[]> {
  if (chainBookEnabled()) {
    try {
      return await orderBookFromChain();
    } catch {
      // social node unreachable / not indexed — fall back to the engine
    }
  }
  const data = await request<{ orders: P2pOrder[] }>('/public/orders?status=ACTIVE');
  return data.orders ?? [];
}

/** Seller lists a sell order (signed by the seller's wallet key).
 *
 *  With L1-SOCIAL configured the order is anchored first — the seller's own
 *  key signs the `social.p2p-order` record and submits it, then POST /orders
 *  carries `{orderId, txid}` so the engine only indexes what the chain
 *  already has (docs/p2p.md §11). Without a social URL (production today)
 *  the legacy engine-intake path signs the order into the request itself. */
export async function createOrder(
  id: P2pIdentity,
  input: CreateOrderInput,
): Promise<{ orderId: string; status: string; txid?: string | null }> {
  if (!P2P_SOCIAL_URL) {
    const body = signedBody(id.key, id.did, { ...input, sellerDid: id.did });
    return request<{ orderId: string; status: string; txid?: string | null }>('/orders', body);
  }
  const orderId = newOrderId();
  const record = p2pOrderRecord({ from: id.did, to: orderId, ...input, ts: Date.now() });
  const txid = await anchorSocialRecord({
    key: id.key,
    l1Url: P2P_SOCIAL_URL,
    record: { ...record, ...signP2pRecord(id.key, record) },
  });
  const body = signedBody(id.key, id.did, { orderId, txid, ...input, sellerDid: id.did });
  return request<{ orderId: string; status: string; txid?: string | null }>('/orders', body);
}

/**
 * The engine-free release channel (docs/p2p.md §6 "Engine as dispute-only
 * attestor"): author-sign and anchor a `social.p2p-release` record on
 * L1-SOCIAL, handing this party's escrow signature to the counterparty so it
 * can assemble and broadcast the cooperative spend without any engine.
 * Returns the anchor txid; the counterparty reads the record from the chain.
 * Requires P2P_SOCIAL_URL (no social node → fall back to the engine path).
 */
export async function publishCoopRelease(
  id: P2pIdentity,
  record: P2pReleaseRecord,
): Promise<string> {
  if (!P2P_SOCIAL_URL) throw new Error('p2p social chain not configured');
  if (record.from !== id.did) throw new Error('release record from != wallet did');
  const signed = { ...record, ...signP2pRecord(id.key, record) };
  return anchorSocialRecord({ key: id.key, l1Url: P2P_SOCIAL_URL, record: signed });
}

/** Seller withdraws an ACTIVE order: anchor a CANCELLED `social.p2p-order`
 *  (same chain-first path as createOrder), then have the engine index it. */
export async function cancelOrder(
  id: P2pIdentity,
  orderId: string,
): Promise<{ orderId: string; status: string }> {
  let txid: string | undefined;
  if (P2P_SOCIAL_URL) {
    const record = p2pOrderRecord({ from: id.did, to: orderId, status: 'CANCELLED', orderSeq: 1, ts: Date.now() });
    txid = await anchorSocialRecord({
      key: id.key,
      l1Url: P2P_SOCIAL_URL,
      record: { ...record, ...signP2pRecord(id.key, record) },
    });
  }
  const body = signedBody(id.key, id.did, { sellerDid: id.did, ...(txid ? { txid } : {}) });
  return request(`/orders/${orderId}/cancel`, body);
}

/** Buyer matches an order; the engine derives the 2-of-3 escrow address. */
export async function matchOrder(
  id: P2pIdentity,
  orderId: string,
  input: MatchOrderInput,
): Promise<{ swapId: string; status: string; escrowAddress: string | null }> {
  const body = signedBody(id.key, id.did, { ...input, buyerDid: id.did });
  return request(`/orders/${orderId}/match`, body);
}

/**
 * Signed state transition. Which party may sign depends on the action: the
 * seller drives escrow_lock/expire/refund (expire only before a payment
 * claim), the buyer cancel (only before claiming), and release/complete are
 * the engine's (the app never calls those). A claim or an open dispute bars
 * the unwind paths — those resolve through dispute (docs/p2p.md §9/§12).
 */
export async function transition(
  id: P2pIdentity,
  swapId: string,
  action: P2pSwapAction,
  extra: Record<string, unknown> = {},
): Promise<{ swapId: string; status: string; txid?: string | null }> {
  const body = signedBody(id.key, id.did, { swapId, action, ...extra });
  return request(`/swaps/${swapId}/transitions`, body);
}

/** Party-scoped swap list (PII redacted, only swaps this did is party to). */
export async function mySwaps(id: P2pIdentity): Promise<P2pSwap[]> {
  const body = signedBody(id.key, id.did, {});
  const data = await request<{ swaps: P2pSwap[] }>('/swaps/mine', body);
  return data.swaps ?? [];
}

/** One party-scoped swap. */
export async function getSwap(id: P2pIdentity, swapId: string): Promise<P2pSwap> {
  const body = signedBody(id.key, id.did, { swapId });
  const data = await request<{ swap: P2pSwap }>('/swaps/get', body);
  return data.swap;
}

/**
 * CNY rails: the buyer pulls the seller's payment instructions (account,
 * amount, per-swap remark). Idempotent while PAYMENT_PENDING.
 */
export async function fetchInstructions(
  id: P2pIdentity,
  swapId: string,
): Promise<P2pPaymentInstructions> {
  const body = signedBody(id.key, id.did, {});
  return request(`/swaps/${swapId}/payment-instructions`, body);
}

/**
 * CNY rails: the buyer claims the transfer (流水号 required, receipt image
 * optional). Only the receipt's sha256 is anchored — the image stays server-side.
 */
export async function submitProof(
  id: P2pIdentity,
  swapId: string,
  input: { txId: string; remark?: string; receipt?: string },
): Promise<{ swapId: string; status: string; txId: string; receiptSha256: string | null }> {
  const body = signedBody(id.key, id.did, { ...input });
  return request(`/swaps/${swapId}/proof`, body);
}

/** CNY rails: the seller confirms receipt on their own statements (→ verified). */
export async function confirmPayment(
  id: P2pIdentity,
  swapId: string,
): Promise<{ swapId: string; status: string }> {
  const body = signedBody(id.key, id.did, {});
  return request(`/swaps/${swapId}/confirm`, body);
}

/** Either party freezes a swap mid-review (tokens stay locked until resolved). */
export async function openDispute(
  id: P2pIdentity,
  swapId: string,
  reason?: string,
): Promise<{ swapId: string; dispute: string }> {
  const body = signedBody(id.key, id.did, reason ? { reason } : {});
  return request(`/swaps/${swapId}/dispute`, body);
}

/**
 * Escrow signing context (party-scoped): the lock outpoint, the release
 * destination (`receiveAddress` — redacted from the general swap view because
 * it is only needed to rebuild the spend skeletons), and the presign state.
 */
export interface P2pEscrowContext {
  swapId: string;
  escrowAddress: string;
  escrowTxHash: string;
  receiveAddress: string;
  sellerDid: string;
  buyerDid: string;
  presigned: boolean;
}

export async function escrowContext(id: P2pIdentity, swapId: string): Promise<P2pEscrowContext> {
  const body = signedBody(id.key, id.did, { swapId });
  return request(`/swaps/${swapId}/escrow/context`, body);
}

/**
 * Seller: pre-sign both spend skeletons at lock (release pays the buyer's
 * receive address, refund pays the seller-chosen address) so the engine's
 * hook can finish the swap with its own key while nobody watches.
 */
export async function presignEscrow(
  id: P2pIdentity,
  swapId: string,
  input: { releaseSig: string; refundSig: string; refundAddress: string },
): Promise<{ swapId: string; presigned: boolean; refundAddress: string }> {
  const body = signedBody(id.key, id.did, { swapId, ...input });
  return request(`/swaps/${swapId}/escrow/presign`, body);
}

/**
 * Party co-sign (Path A): submit this wallet's signature over the rebuilt
 * skeleton; the engine adds its key, broadcasts, and settles only after
 * CONFIRMED. `kind=refund` is seller-only (the refund pays the seller's
 * address). 202 = broadcast pending.
 */
export async function cosignEscrow(
  id: P2pIdentity,
  swapId: string,
  input: { kind: 'release' | 'refund'; sig: string; refundAddress?: string },
): Promise<{ swapId: string; status: string; txHash: string | null; pending: boolean }> {
  const fields: Record<string, unknown> = { swapId, kind: input.kind, sig: input.sig };
  if (input.refundAddress) fields.refundAddress = input.refundAddress;
  const body = signedBody(id.key, id.did, fields);
  return request(`/swaps/${swapId}/escrow/cosign`, body);
}

/** Seller: upsert a CNY collection profile. */
export async function saveProfile(
  id: P2pIdentity,
  input: { method: P2pCnyRail; accountName: string; account: string; bankName?: string },
): Promise<{ ok: boolean; method: string }> {
  const body = signedBody(id.key, id.did, { ...input });
  return request('/profiles', body);
}

/** Seller: list own collection profiles. */
export async function getMyProfiles(id: P2pIdentity): Promise<P2pPaymentProfile[]> {
  const body = signedBody(id.key, id.did, {});
  const data = await request<{ profiles: P2pPaymentProfile[] }>('/profiles/mine', body);
  return data.profiles ?? [];
}

// ── Device-side verification (docs/p2p.md §12) ─────────────────────────────
// The party pairs their own phone (the Mobile Agent app) once, then the engine
// reads the matching entry in that party's own rail app and returns a verdict
// the wallet signs. Only the caller's own pairing is ever used, and only the
// caller's own side (buyer reads the sending ledger, seller the receiving one).

/** A stored device pairing (the bearer token never comes back — `tokenSet` only). */
export interface P2pPairing {
  pairingId: string;
  endpoint: string;
  deviceId: string;
  swapId: string | null;
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
  tokenSet: boolean;
}

/** Fresh pairing id (`pr-<24hex>`, the engine's pairingId pattern). */
function newPairingId(): string {
  const arr = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  return `pr-${Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Pair the party's own phone with the engine: a DID-signed grant naming the
 * endpoint, the device and the endpoint's bearer token (never logged). `swapId`
 * scopes the grant to one swap; omit it for a general pairing (≤ 30 days).
 */
export async function createPairing(
  id: P2pIdentity,
  input: { endpoint: string; token: string; deviceId?: string; swapId?: string; ttlMs?: number },
): Promise<{ pairingId: string; expiresAt: number }> {
  const now = Date.now();
  const ttl = Math.min(Math.max(input.ttlMs ?? 24 * 60 * 60 * 1000, 60_000), 30 * 24 * 60 * 60 * 1000);
  const body = signedBody(
    id.key,
    id.did,
    {
      pairingId: newPairingId(),
      endpoint: input.endpoint.trim().replace(/\/+$/, ''),
      deviceId: input.deviceId?.trim() || 'self',
      token: input.token.trim(),
      ...(input.swapId ? { swapId: input.swapId } : {}),
      issuedAt: now,
      expiresAt: now + ttl,
    },
    now,
  );
  return request('/pairings', body);
}

/** The caller's own pairings (revoke any of them at will). */
export async function listMyPairings(id: P2pIdentity): Promise<P2pPairing[]> {
  const body = signedBody(id.key, id.did, {});
  const data = await request<{ pairings: P2pPairing[] }>('/pairings/mine', body);
  return data.pairings ?? [];
}

/** Revoke a pairing — the endpoint is never reached again. */
export async function revokePairing(id: P2pIdentity, pairingId: string): Promise<void> {
  const body = signedBody(id.key, id.did, { pairingId });
  await request('/pairings/revoke', body);
}

/** The engine's device read (docs/p2p.md §12) — the verdict payload the wallet signs. */
export interface P2pDeviceReadResult {
  swapId: string;
  side: 'buyer' | 'seller';
  verdict: Record<string, unknown>;
  check: { ok: boolean; error?: string; claimMismatch?: { claimed: string; observed: string } };
  entry: Record<string, unknown> | null;
}

/**
 * Ask the engine to read the caller's own paired phone and extract the matching
 * entry (buyer → sending ledger, seller → receiving ledger). Only the caller's
 * own pairing is used; the read is never trusted on its own — the wallet signs
 * the returned verdict and posts it to `/swaps/:swapId/verify`.
 */
export async function deviceRead(
  id: P2pIdentity,
  swapId: string,
  input: { pairingId?: string; evidenceKind?: 'device_read' | 'bank_ereceipt'; receiptVerified?: boolean } = {},
): Promise<P2pDeviceReadResult> {
  const body = signedBody(id.key, id.did, {
    ...(input.pairingId ? { pairingId: input.pairingId } : {}),
    ...(input.evidenceKind ? { evidenceKind: input.evidenceKind } : {}),
    ...(input.receiptVerified !== undefined ? { receiptVerified: input.receiptVerified } : {}),
  });
  return request(`/swaps/${swapId}/device-read`, body);
}

/** Sign the engine-read verdict with the party's key and submit it (side = the signer's role). */
export async function submitVerdict(
  id: P2pIdentity,
  swapId: string,
  verdict: Record<string, unknown>,
): Promise<{ swapId: string; status: string; verifySource?: string }> {
  const body = signedBody(id.key, id.did, { ...verdict });
  return request(`/swaps/${swapId}/verify`, body);
}
