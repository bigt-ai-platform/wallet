/**
 * Post-quantum DID support — the keypair management model from ../wallet:
 * ML-DSA-87 keys (PQKey, bigtangle-ts), challenge signatures as
 * SignatureBundles. bigtangle-ts is a peer dependency, imported here only.
 *
 * DID form: did:key:z<base58btc(uvarint(codec) ‖ prefixedPubBytes)>
 * codec 0x300001 is in the multicodec private-use range until an official
 * ML-DSA-87-prefixed codepoint is registered.
 */
import { Sha256Hash } from "bigtangle-ts/dist/net/bigtangle/core/Sha256Hash.js";
import { PQKey } from "bigtangle-ts/dist/net/bigtangle/crypto/pq/PQKey.js";
import { SignatureBundle } from "bigtangle-ts/dist/net/bigtangle/crypto/pq/SignatureBundle.js";
import { base58Decode, base58Encode, concat, decodeUvarint, encodeUvarint, hexToBytes, bytesToHex } from "./index.js";

export const MULTICODEC_DAI_MLDSA87_PREFIXED = 0x300001;

export function didFromPQKey(pqKey: PQKey): string {
  return didFromPQPub(pqKey.getPrefixedPublicKeyBytes());
}

export function didFromPQPub(prefixedPubBytes: Uint8Array): string {
  const mc = encodeUvarint(MULTICODEC_DAI_MLDSA87_PREFIXED);
  return `did:key:z${base58Encode(concat(mc, prefixedPubBytes))}`;
}

export function pqPubFromDid(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error("unsupported DID format");
  const decoded = base58Decode(did.slice(9));
  const { value, length } = decodeUvarint(decoded, 0);
  if (value !== MULTICODEC_DAI_MLDSA87_PREFIXED) {
    throw new Error(`unsupported multicodec: 0x${value.toString(16)}`);
  }
  return decoded.slice(length);
}

export function isValidPQDid(did: string): boolean {
  try {
    pqPubFromDid(did);
    return true;
  } catch {
    return false;
  }
}

/** Sign a hex nonce with the wallet-style PQKey; returns hex-serialized SignatureBundle. */
export function signChallengePQ(pqKey: PQKey, nonceHex: string): string {
  const bundle = pqKey.sign(Sha256Hash.wrap(hexToBytes(nonceHex)));
  return bytesToHex(bundle.serialize());
}

/** Verify a PQ challenge signature against a did:key derived from prefixed pubkey bytes. */
export function verifyChallengeWithPQDid(did: string, nonceHex: string, sigBundleHex: string): boolean {
  try {
    const pubBytes = pqPubFromDid(did);
    const bundle = SignatureBundle.deserialize(hexToBytes(sigBundleHex));
    return PQKey.verify(Sha256Hash.wrap(hexToBytes(nonceHex)), bundle, pubBytes);
  } catch {
    return false;
  }
}

import { isValidDid } from "./index.js";

/** Accept either classic did:key (Ed25519/secp256k1) or PQ ML-DSA-87 dids.
 *  PQ first: an ML-DSA did:key body is ~3500 chars, so trying the classic
 *  parser first would base58-decode the whole thing only to reject its codec. */
export function anyDidValid(did: string): boolean {
  return isValidPQDid(did) || isValidDid(did);
}
