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
  | 'cancel';

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
  txid?: string;
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
  paypalAccount: string;
  buyerEmail?: string;
}

/** Whether a P2P engine endpoint is configured for this build. */
export function p2pConfigured(): boolean {
  return !!P2P_ENGINE_URL;
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
