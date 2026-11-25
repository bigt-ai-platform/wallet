/**
 * Signed redemption intent (L1 USDT → Ethereum USDT).
 *
 * The L1 key proves the destination; the issuer verifies it with the same
 * fixed-order message, checks that the named L1 transaction actually returned
 * the tokens to the issuer's redemption address, stores the nonce and debits
 * the balance. This module only builds/signs/sends; the issuer owns balances
 * and the treasury release.
 */

import {
  Address,
  ECKey,
  MainNetParams,
  PQKey,
  Sha256Hash,
  TestParams,
  Utils,
  type NetworkParameters,
} from 'bigt-ai-ts';
import type { WalletKey } from '@/lib/walletKeys';

export const REDEEM_INTENT_DOMAIN = 'bigt-ai-wallet-redeem-v2';

export type RedeemNetwork = 'Mainnet' | 'Test';
export type RedeemKeyType = 'EC' | 'PQ';

export interface RedeemIntent {
  domain: typeof REDEEM_INTENT_DOMAIN;
  network: RedeemNetwork;
  assetId: string;
  account: string;
  amountRaw: string;
  destination: string;
  /** L1 funding transaction hash that paid the tokens to the issuer. */
  l1TxHash: string;
  nonce: string;
  expiry: number;
}

export interface RedeemProof {
  keyType: RedeemKeyType;
  publicKey: string;
  signature: string;
}

export interface RedeemSettings {
  apiUrl: string;
  apiToken: string;
}

export interface RedeemResult {
  id: string;
  status: string;
}

export function networkParams(network: RedeemNetwork): NetworkParameters {
  return network === 'Mainnet' ? new MainNetParams() : new TestParams();
}

/** Must match `services/asset-issuer/src/intent.ts` byte for byte. */
export function intentMessage(intent: RedeemIntent): string {
  return JSON.stringify({
    domain: intent.domain,
    network: intent.network,
    assetId: intent.assetId,
    account: intent.account,
    amountRaw: intent.amountRaw,
    destination: intent.destination,
    l1TxHash: intent.l1TxHash,
    nonce: intent.nonce,
    expiry: intent.expiry,
  });
}

export function intentHash(intent: RedeemIntent): Sha256Hash {
  return Sha256Hash.of(new TextEncoder().encode(intentMessage(intent)));
}

export interface BuildIntentInput {
  assetId: string;
  account: string;
  amountRaw: string;
  destination: string;
  l1TxHash: string;
  network: RedeemNetwork;
  nonce: string;
  expiry: number;
}

export function buildRedeemIntent(input: BuildIntentInput): RedeemIntent {
  return {
    domain: REDEEM_INTENT_DOMAIN,
    network: input.network,
    assetId: input.assetId,
    account: input.account,
    amountRaw: input.amountRaw,
    destination: input.destination,
    l1TxHash: input.l1TxHash,
    nonce: input.nonce,
    expiry: input.expiry,
  };
}

/** 16 random bytes; uniqueness is what matters, not secrecy. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Utils.HEX.encode(bytes);
}

function addressMatches(account: string, key: ECKey | PQKey, params: NetworkParameters): boolean {
  const target = account.trim();
  const candidates: string[] = [];
  try {
    candidates.push(key.toAddressString(params));
  } catch {
    /* ignore */
  }
  try {
    candidates.push(Address.fromKey(params, key).toBase58());
  } catch {
    /* PQ addresses are hex */
  }
  for (const candidate of candidates) {
    if (candidate === target) return true;
    if (/^[0-9a-fA-F]+$/.test(target) && candidate.toLowerCase() === target.toLowerCase()) return true;
  }
  return false;
}

/** Sign the intent with the wallet's Bigt-Ai key (PQ or legacy EC). */
export function signRedeemIntent(key: WalletKey, intent: RedeemIntent): RedeemProof {
  const params = networkParams(intent.network);
  const keyType: RedeemKeyType = key.keyType ?? 'PQ';

  if (keyType === 'EC') {
    const ec = ECKey.fromPrivateString(key.privateKey);
    if (!addressMatches(intent.account, ec, params)) {
      throw new Error('This key does not control the L1 account');
    }
    return {
      keyType,
      publicKey: Utils.HEX.encode(ec.getPubKey()),
      signature: Utils.HEX.encode(ec.sign(intentHash(intent)).encodeToBitcoin()),
    };
  }

  const pq = PQKey.fromPrivateKeyHex(key.privateKey);
  if (!addressMatches(intent.account, pq, params)) {
    throw new Error('This key does not control the L1 account');
  }
  return {
    keyType,
    publicKey: pq.getPublicKeyAsHex(),
    signature: Utils.HEX.encode(pq.sign(intentHash(intent)).serialize()),
  };
}

export async function submitRedeemIntent(
  intent: RedeemIntent,
  proof: RedeemProof,
  settings: RedeemSettings,
): Promise<RedeemResult> {
  if (!settings.apiUrl) throw new Error('Issuer API URL is not configured');
  const response = await fetch(`${settings.apiUrl.replace(/\/+$/, '')}/redeem-intents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(settings.apiToken ? { authorization: `Bearer ${settings.apiToken}` } : {}),
    },
    body: JSON.stringify({
      account: intent.account,
      assetId: intent.assetId,
      amount: intent.amountRaw,
      destination: intent.destination,
      l1TxHash: intent.l1TxHash,
      nonce: intent.nonce,
      expiry: intent.expiry,
      keyType: proof.keyType,
      publicKey: proof.publicKey,
      signature: proof.signature,
    }),
  });

  const body = (await response.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    error?: string;
    retryable?: boolean;
  };
  if (!response.ok) {
    // The L1 funding transfer is not confirmed yet; the caller may retry the
    // same signed intent (nothing was reserved server-side).
    if (body.retryable) throw new RedeemPendingError(body.error || 'Redemption is pending');
    throw new Error(body.error || `Redeem request failed (HTTP ${response.status})`);
  }
  if (!body.id) throw new Error('Issuer response is missing the operation id');
  return { id: body.id, status: body.status ?? 'pending' };
}

/** Retryable: the L1 return exists but is not confirmed yet. */
export class RedeemPendingError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'RedeemPendingError';
  }
}
