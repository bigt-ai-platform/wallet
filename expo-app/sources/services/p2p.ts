import { P2P_ENGINE_URL } from '@/constants/app';
import type { PQKey } from 'bigtangle-ts';
import { signedBody } from '@/lib/p2pIdentity';

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
  | 'payment_send'
  | 'verify'
  | 'release'
  | 'payout'
  | 'expire'
  | 'refund'
  | 'cancel'
  | 'instructions'
  | 'payment_proof'
  | 'payment_confirm'
  | 'complete';

/** CNY collection rails (docs/p2pcny.md): settle peer-to-peer, manual confirm. */
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
  createdAt: number;
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
  paymentRef?: string;
  payoutRef?: string;
  payoutStatus?: string;
  invoiceId?: string;
  invoiceUrl?: string;
  paymentReversed?: boolean;
  dispute?: string;
  disputeOutcome?: 'release' | 'refund';
  paymentRail?: string;
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
}

export interface MatchOrderInput {
  receiveAddress: string;
  /** PayPal rail only — the buyer's PayPal handle. CNY orders omit it. */
  paypalAccount?: string;
  buyerEmail?: string;
}

/** Seller's CNY payment instructions for one swap (docs/p2pcny.md §5). */
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

/** What a deployed engine actually serves (GET /capabilities — public). */
export interface P2pCapabilities {
  /** Enabled rails in the engine's preference order (paypal first when wired). */
  rails: string[];
  /** PayPal client configured — false means /invoice and /payout-sync 503. */
  paypal: boolean;
  /** Engine escrow pubkey configured (the 2-of-3 participant). */
  escrow: boolean;
  /** Public engine escrow key: rebuilds the 2-of-3 vault to sign escrow spends. */
  escrowPubkey: string | null;
  /** Chain clients wired: l0 = escrow proof/broadcast, l1 = social anchor. */
  chain: { l0: boolean; l1: boolean };
}

/**
 * The engine's capability report. Returns null (never throws) when the engine
 * is unconfigured, unreachable, or too old to expose /capabilities — callers
 * then keep their built-in defaults, so a CNY-only deploy hides the paypal
 * rail while an older engine behaves exactly as before.
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
      paypal: !!data.paypal,
      escrow: !!data.escrow,
      escrowPubkey: typeof data.escrowPubkey === 'string' && data.escrowPubkey ? data.escrowPubkey : null,
      chain: { l0: !!data.chain?.l0, l1: !!data.chain?.l1 },
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
    const message = (data as { error?: string }).error || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

/** Public order book (ACTIVE sell orders, no signatures, no PII). */
export async function listOpenOrders(): Promise<P2pOrder[]> {
  const data = await request<{ orders: P2pOrder[] }>('/public/orders?status=ACTIVE');
  return data.orders ?? [];
}

/** Seller lists a sell order (signed by the seller's wallet key). */
export async function createOrder(
  id: P2pIdentity,
  input: CreateOrderInput,
): Promise<{ orderId: string; status: string }> {
  const body = signedBody(id.key, id.did, { ...input, sellerDid: id.did });
  return request<{ orderId: string; status: string }>('/orders', body);
}

/** Buyer matches an order; the engine derives the 2-of-3 escrow address. */
export async function matchOrder(
  id: P2pIdentity,
  orderId: string,
  input: MatchOrderInput,
): Promise<{ swapId: string; status: string; escrowAddress: string | null }> {
  const fields: Record<string, unknown> = { ...input, buyerDid: id.did };
  if (!input.buyerEmail) delete fields.buyerEmail;
  const body = signedBody(id.key, id.did, fields);
  return request(`/orders/${orderId}/match`, body);
}

/** Buyer records a fiat-payment hint (the invoice number / payment ref). */
export async function sendPayment(
  id: P2pIdentity,
  swapId: string,
  paymentRef: string,
): Promise<{ swapId: string; status: string }> {
  const body = signedBody(id.key, id.did, { swapId, paymentRef });
  return request('/payments/send', body);
}

/**
 * Signed state transition. Which party may sign depends on the action: the
 * seller drives escrow_lock/expire/refund, the buyer cancel, and verify/
 * release/payout are the engine's (the app never calls those).
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
