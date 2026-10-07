import { Base58, PQKey, Sha256Hash, Utils } from 'bigtangle-ts';

/**
 * App-local P2P identity helpers.
 *
 * The wallet's P2P identity is its PQ (ML-DSA-87) key. The engine authenticates
 * each request with a did:key over that key, and a signature over the sha256 of
 * the canonical (sorted top-level keys) JSON body. This mirrors
 * `packages/did` + `services/p2p-engine/src/sign.ts` but is implemented with
 * `bigtangle-ts` only, because importing the `did` package pulls in
 * `node:crypto` (Metro-hostile).
 */
const MULTICODEC_MLDSA87 = 0x300001;
const DID_PREFIX = 'did:key:z';

function encodeUvarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/** Rebuild the wallet's PQ key from its stored private key hex. The wallet
 *  stores `PQKey.getPrivateKeyHex()` (the serialized bundle), so this must use
 *  `fromPrivateKey` — exactly as `WalletHelper` reconstructs it — not the
 *  seed-based `fromPrivateKeyHex`. */
export function pqKeyFromPrivateHex(privateKeyHex: string): PQKey {
  return PQKey.fromPrivateKey(Utils.HEX.decode(privateKeyHex));
}

/** did:key over the PQ public key (codec 0x300001, base58btc) — matches the engine. */
export function pqDidFromKey(key: PQKey): string {
  const mc = encodeUvarint(MULTICODEC_MLDSA87);
  const pub = key.getPrefixedPublicKeyBytes();
  const combined = new Uint8Array(mc.length + pub.length);
  combined.set(mc, 0);
  combined.set(pub, mc.length);
  return `${DID_PREFIX}${Base58.encode(combined)}`;
}

/** Sorted top-level keys — the canonical form the engine verifies. */
export function canonicalJson(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

/** Sign the sha256 digest of the canonical payload, hex-encoded SignatureBundle. */
export function signP2pPayload(key: PQKey, payload: Record<string, unknown>): string {
  const digest = Sha256Hash.hash(new TextEncoder().encode(canonicalJson(payload)));
  const bundle = key.sign(Sha256Hash.wrap(digest));
  return Utils.HEX.encode(bundle.serialize());
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(arr);
  else for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256);
  return Utils.HEX.encode(arr);
}

/**
 * Attach `did`/`nonce`/`timestamp` and a PQ signature, the exact shape the
 * engine's `validateSignedRequest` expects.
 */
export function signedBody(
  key: PQKey,
  did: string,
  fields: Record<string, unknown>,
  now: number = Date.now(),
): Record<string, unknown> {
  const payload = { ...fields, did, nonce: randomHex(16), timestamp: now };
  return { ...payload, signature: signP2pPayload(key, payload) };
}
