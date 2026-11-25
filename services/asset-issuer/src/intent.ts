/**
 * Signed redemption intents.
 *
 * A redemption must name the Ethereum destination and prove that the L1 account
 * authorized it. The message is signed with the account's **L1 key** (PQ or
 * legacy EC), not with an API token: a bearer token can move balances but must
 * not choose where value leaves custody.
 *
 * The intent is a fixed-order JSON object so the client and server hash exactly
 * the same bytes. `nonce` is unique per account/asset and `expiry` bounds the
 * window; the server stores both and refuses a replay.
 */

import {
  Address,
  ECKey,
  MainNetParams,
  PQKey,
  Sha256Hash,
  SignatureBundle,
  TestParams,
  Utils,
  type NetworkParameters,
} from 'bigt-ai-ts';

export const REDEEM_INTENT_DOMAIN = 'bigt-ai-wallet-redeem-v2';

export type RedeemNetwork = 'Mainnet' | 'Test';
export type IntentKeyType = 'EC' | 'PQ';

export interface RedeemIntent {
  domain: typeof REDEEM_INTENT_DOMAIN;
  network: RedeemNetwork;
  assetId: string;
  /** L1 account (base58 for EC, hex for PQ). */
  account: string;
  /** Amount at the L1 scale, smallest units. */
  amountRaw: string;
  /** Ethereum destination (0x + 40 hex). */
  destination: string;
  /**
   * Hash of the L1 transaction that paid `amountRaw` of the asset's token to
   * the issuer's redemption address. The release is refused without a confirmed
   * output for it, and the hash may back only one release.
   */
  l1TxHash: string;
  /** Unique per (asset, account); a replay is rejected. */
  nonce: string;
  /** Unix milliseconds. */
  expiry: number;
}

export interface RedeemProof {
  keyType: IntentKeyType;
  /** EC compressed public key or PQ prefixed bundle, hex (optional 0x). */
  publicKey: string;
  /** EC: `TransactionSignature.encodeToBitcoin()`; PQ: `SignatureBundle.serialize()`. */
  signature: string;
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

export function networkParams(network: RedeemNetwork): NetworkParameters {
  return network === 'Mainnet' ? new MainNetParams() : new TestParams();
}

/**
 * Exact bytes the client signs. Do not reorder or add fields: a different
 * serialization is a different intent.
 */
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

function strip0x(hex: string): string {
  return hex.replace(/^0x/i, '');
}

function hexBytes(hex: string, name: string): Uint8Array {
  const clean = strip0x(hex);
  if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2) {
    throw new Error(`${name} must be hex`);
  }
  return Utils.HEX.decode(clean);
}

function addressMatches(account: string, key: ECKey | PQKey, params: NetworkParameters): boolean {
  const target = account.trim();
  const candidates: string[] = [];
  try {
    candidates.push(key.toAddressString(params));
  } catch {
    /* not every key type supports it */
  }
  try {
    candidates.push(Address.fromKey(params, key).toBase58());
  } catch {
    /* PQ addresses are hex */
  }
  for (const candidate of candidates) {
    if (candidate === target) return true;
    if (/^[0-9a-fA-F]+$/.test(target) && candidate.toLowerCase() === target.toLowerCase()) {
      return true;
    }
  }
  return false;
}

/** Verify the signature and that the public key is the requested L1 account. */
export function verifyRedeemIntent(intent: RedeemIntent, proof: RedeemProof): VerifyResult {
  let hash: Sha256Hash;
  try {
    hash = intentHash(intent);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid intent' };
  }

  let publicKey: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKey = hexBytes(proof.publicKey, 'publicKey');
    signature = hexBytes(proof.signature, 'signature');
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid proof encoding' };
  }

  const params = networkParams(intent.network);

  try {
    if (proof.keyType === 'EC') {
      const key = ECKey.fromPublicOnly(publicKey);
      if (!ECKey.verify(hash.getBytes(), signature, publicKey)) {
        return { ok: false, error: 'signature does not verify' };
      }
      if (!addressMatches(intent.account, key, params)) {
        return { ok: false, error: 'public key does not match the account' };
      }
      return { ok: true };
    }

    if (proof.keyType === 'PQ') {
      const key = PQKey.fromPublicOnly(publicKey);
      if (!PQKey.verify(hash, SignatureBundle.deserialize(signature), publicKey)) {
        return { ok: false, error: 'signature does not verify' };
      }
      if (!addressMatches(intent.account, key, params)) {
        return { ok: false, error: 'public key does not match the account' };
      }
      return { ok: true };
    }

    return { ok: false, error: `unsupported keyType: ${String(proof.keyType)}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'invalid proof' };
  }
}

/** Amount/nonce/expiry checks shared by the route and tests. */
export function validateIntentFields(intent: RedeemIntent, now: number): VerifyResult {
  if (intent.domain !== REDEEM_INTENT_DOMAIN) return { ok: false, error: 'unknown intent domain' };
  if (!/^\d+$/.test(intent.amountRaw) || BigInt(intent.amountRaw) <= 0n) {
    return { ok: false, error: 'amountRaw must be a positive decimal string' };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(intent.destination)) {
    return { ok: false, error: 'destination must be a 20-byte 0x address' };
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(intent.l1TxHash)) {
    return { ok: false, error: 'l1TxHash must be a 32-byte transaction hash' };
  }
  if (!intent.nonce || intent.nonce.length < 8 || intent.nonce.length > 128) {
    return { ok: false, error: 'nonce must be 8..128 characters' };
  }
  if (!Number.isFinite(intent.expiry) || intent.expiry <= now) {
    return { ok: false, error: 'intent has expired' };
  }
  if (intent.expiry > now + 7 * 24 * 60 * 60 * 1000) {
    return { ok: false, error: 'intent expiry is too far in the future' };
  }
  return { ok: true };
}
