/**
 * @dai/did — self-certifying did:key identity.
 *
 * Extracted from bigtai src/crypto (proven in production). Pure crypto, no
 * blockchain runtime dependency: one secp256k1/Ed25519 keypair yields both a
 * did:key identifier and a BigTangle chain address.
 *
 * Provides: key generation, ECDSA/Ed25519 sign/verify, WIF, did:key,
 * chain address derivation, ECDH encryption, challenge auth.
 */
import * as secp256k1Module from "secp256k1";
// Normalize CJS/ESM interop: vitest and tsx resolve the CJS module differently.
const secp256k1Raw = secp256k1Module as unknown as Record<string, unknown>;
const secp256k1 = (
  typeof secp256k1Raw.privateKeyVerify === "function"
    ? secp256k1Raw
    : (secp256k1Raw.default as Record<string, unknown>)
) as typeof import("secp256k1");
import * as ed25519 from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import nodeCrypto from "crypto";

// Configure Ed25519 with SHA-512 (v3 API)
ed25519.hashes.sha512 = sha512;

function randomBytes(length: number): Uint8Array {
  const b = new Uint8Array(length);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(b);
  } else {
    for (let i = 0; i < length; i++) b[i] = Math.floor(Math.random() * 256);
  }
  return b;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length);
  r.set(a, 0);
  r.set(b, a.length);
  return r;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// charCode → digit (ASCII-only alphabet; anything else, incl. surrogates, is -1)
const BASE58_DIGIT = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE58.length; i++) BASE58_DIGIT[BASE58.charCodeAt(i)] = i;

/**
 * base58, both directions, without per-digit BigInt work (the original
 * implementation did a BigInt multiply per character — one ML-DSA did:key
 * decode took ~48ms and sat on every request that validates a DID).
 *
 * decode: characters accumulate in float-safe 9-digit groups (58^9 < 2^53)
 * into one BigInt, then a single hex dump to bytes (~0.5ms for 3554 chars).
 * encode: number[] limbs of 32 bits, 3 base58 digits per divmod sweep.
 */
const B58_CHUNK = 3; // encode: digits per limb sweep
const B58_POW = 195112; // 58^3
const U32 = 4294967296;
const B58_POW9 = 58n ** 9n; // < 2^53, safe to build as a float first
const HEX_DIGIT = new Int16Array(128).fill(-1);
for (let i = 0; i < 10; i++) HEX_DIGIT["0".charCodeAt(0) + i] = i;
for (let i = 0; i < 6; i++) HEX_DIGIT["a".charCodeAt(0) + i] = 10 + i;

export function base58Encode(input: Uint8Array): string {
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  // little-endian uint32 limbs of the value after the leading zero bytes
  const limbs: number[] = [];
  for (let bi = input.length - 1; bi >= zeros; bi--) {
    const pos = (input.length - 1 - bi) & 3;
    if (pos === 0) limbs.push(input[bi]);
    else limbs[limbs.length - 1] += input[bi] * 256 ** pos; // * not << : stay < 2^31-free
  }
  const chunks: string[] = [];
  while (limbs.length > 0) {
    let rem = 0;
    for (let j = limbs.length - 1; j >= 0; j--) {
      const t = rem * U32 + limbs[j];
      limbs[j] = Math.floor(t / B58_POW);
      rem = t % B58_POW;
    }
    while (limbs.length > 0 && limbs[limbs.length - 1] === 0) limbs.pop();
    let chunk = "";
    for (let k = 0; k < B58_CHUNK; k++) {
      chunk = BASE58[rem % 58] + chunk;
      rem = Math.floor(rem / 58);
    }
    chunks.push(chunk);
  }
  // chunks are least-significant first; strip the top chunk's '1' padding
  const body = chunks.reverse().join("").replace(/^1+/, "");
  return "1".repeat(zeros) + body;
}

export function base58Decode(input: string): Uint8Array {
  let zeros = 0;
  while (zeros < input.length && input[zeros] === "1") zeros++;
  let v = 0n;
  let c = 0;
  let cnt = 0;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    const d = code < 128 ? BASE58_DIGIT[code] : -1;
    if (d < 0) throw new Error("invalid base58");
    c = c * 58 + d;
    if (++cnt === 9) {
      v = v * B58_POW9 + BigInt(c);
      c = 0;
      cnt = 0;
    }
  }
  if (cnt > 0) v = v * (58n ** BigInt(cnt)) + BigInt(c);
  if (v === 0n) return new Uint8Array(zeros);
  let hex = v.toString(16);
  if ((hex.length & 1) === 1) hex = "0" + hex;
  const out = new Uint8Array(zeros + (hex.length >> 1));
  for (let i = 0; i < hex.length; i += 2) {
    out[zeros + (i >> 1)] = (HEX_DIGIT[hex.charCodeAt(i)] << 4) | HEX_DIGIT[hex.charCodeAt(i + 1)];
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return b;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeUvarint(value: number): Uint8Array {
  const bytes: number[] = [];
  while (value > 0x7f) { bytes.push((value & 0x7f) | 0x80); value >>>= 7; }
  bytes.push(value & 0x7f);
  return new Uint8Array(bytes);
}

export function decodeUvarint(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0, shift = 0, i = offset;
  while (i < data.length) { const b = data[i]; value |= (b & 0x7f) << shift; i++; if (!(b & 0x80)) break; shift += 7; }
  return { value, length: i - offset };
}

const MULTICODEC_SECP256K1 = 0xe7;
const MULTICODEC_ED25519 = 0xed;

/** secp256k1 curve order (for low-S canonicalization, BIP-62 style). */
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);

/** Normalize an ECDSA compact signature (r‖s, 64 bytes) to low-S canonical
 *  form so it verifies under verifiers that reject malleable high-S sigs. */
export function lowS(compactSig: Uint8Array): Uint8Array {
  const hex = bytesToHex(compactSig);
  const r = BigInt("0x" + hex.slice(0, 64));
  let s = BigInt("0x" + hex.slice(64, 128));
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
  return hexToBytes(r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0"));
}

// ── ECKey (secp256k1, for backward compat and ECDH) ─────────────────────

export class ECKey {
  private _priv: Uint8Array | null;
  private _pub: Uint8Array;
  private _compressed: boolean;

  constructor(priv: Uint8Array | null, pub: Uint8Array, compressed: boolean = true) {
    this._priv = priv;
    this._pub = pub;
    this._compressed = compressed;
  }

  static createNewKey(compressed: boolean = true): ECKey {
    let priv: Uint8Array;
    do { priv = randomBytes(32); } while (!secp256k1.privateKeyVerify(priv));
    const pub = secp256k1.publicKeyCreate(priv, compressed);
    return new ECKey(priv, new Uint8Array(pub), compressed);
  }

  static fromPrivateBytes(priv: Uint8Array, compressed: boolean = true): ECKey {
    if (!secp256k1.privateKeyVerify(priv)) throw new Error("invalid private key");
    const pub = secp256k1.publicKeyCreate(priv, compressed);
    return new ECKey(priv, new Uint8Array(pub), compressed);
  }

  static fromPublicBytes(pub: Uint8Array, compressed: boolean = true): ECKey {
    return new ECKey(null, pub, compressed);
  }

  getPrivBytes(): Uint8Array | null { return this._priv; }
  getPubBytes(): Uint8Array { return this._pub; }
  getPrivHex(): string | null { return this._priv ? bytesToHex(this._priv) : null; }
  getPubHex(): string { return bytesToHex(this._pub); }
  hasPrivate(): boolean { return this._priv !== null; }

  sign(messageHash: Uint8Array): { r: Uint8Array; s: Uint8Array; compact: Uint8Array } {
    if (!this._priv) throw new Error("no private key");
    const sig = secp256k1.ecdsaSign(messageHash, this._priv);
    const compact = lowS(new Uint8Array(sig.signature));
    return { r: compact.slice(0, 32), s: compact.slice(32, 64), compact };
  }

  verify(messageHash: Uint8Array, signatureCompact: Uint8Array): boolean {
    return secp256k1.ecdsaVerify(signatureCompact, messageHash, this._pub);
  }
}

// ── Ed25519Key ──────────────────────────────────────────────────────────

export class Ed25519Key {
  private _priv: Uint8Array | null;
  private _pub: Uint8Array;

  constructor(priv: Uint8Array | null, pub: Uint8Array) {
    this._priv = priv;
    this._pub = pub;
  }

  static createNewKey(): Ed25519Key {
    const priv = randomBytes(32);
    const pub = ed25519.getPublicKey(priv);
    return new Ed25519Key(priv, pub);
  }

  static fromPrivateBytes(priv: Uint8Array): Ed25519Key {
    if (priv.length !== 32) throw new Error("Ed25519 private key must be 32 bytes");
    const pub = ed25519.getPublicKey(priv);
    return new Ed25519Key(priv, pub);
  }

  static fromPublicBytes(pub: Uint8Array): Ed25519Key {
    if (pub.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
    return new Ed25519Key(null, pub);
  }

  getPrivBytes(): Uint8Array | null { return this._priv; }
  getPubBytes(): Uint8Array { return this._pub; }
  getPrivHex(): string | null { return this._priv ? bytesToHex(this._priv) : null; }
  getPubHex(): string { return bytesToHex(this._pub); }
  hasPrivate(): boolean { return this._priv !== null; }

  sign(message: Uint8Array): Uint8Array {
    if (!this._priv) throw new Error("no private key");
    return ed25519.sign(message, this._priv);
  }

  verify(message: Uint8Array, signature: Uint8Array): boolean {
    return ed25519.verify(signature, message, this._pub);
  }
}

// ── WIF (secp256k1 only) ────────────────────────────────────────────────

const MAINNET_PRIVKEY_VERSION = 0x80;

function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

export function wifEncode(privBytes: Uint8Array, compressed: boolean = true): string {
  const payload = new Uint8Array(compressed ? 34 : 33);
  payload[0] = MAINNET_PRIVKEY_VERSION;
  payload.set(privBytes, 1);
  if (compressed) payload[34 - 1] = 0x01;
  const hash = doubleSha256(payload.slice(0, compressed ? 34 : 33));
  const withChecksum = concat(payload, hash.slice(0, 4));
  return base58Encode(withChecksum);
}

export function wifDecode(wif: string): { privBytes: Uint8Array; compressed: boolean } {
  const decoded = base58Decode(wif);
  if (decoded.length < 37) throw new Error("WIF too short");
  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const computed = doubleSha256(payload).slice(0, 4);
  for (let i = 0; i < 4; i++) if (computed[i] !== checksum[i]) throw new Error("WIF checksum mismatch");
  if (payload[0] !== MAINNET_PRIVKEY_VERSION) throw new Error("unsupported WIF version");
  const compressed = payload.length === 34 && payload[33] === 0x01;
  return { privBytes: payload.slice(1, 33), compressed };
}

// ── did:key (multi-codec aware) ─────────────────────────────────────────

export function didKeyFromPub(pubBytes: Uint8Array): string {
  const codec = pubBytes.length === 33 ? MULTICODEC_SECP256K1 : MULTICODEC_ED25519;
  const mc = encodeUvarint(codec);
  return `did:key:z${base58Encode(concat(mc, pubBytes))}`;
}

export function didKeyFromPubEd25519(pubBytes: Uint8Array): string {
  const mc = encodeUvarint(MULTICODEC_ED25519);
  return `did:key:z${base58Encode(concat(mc, pubBytes))}`;
}

export function pubFromDid(did: string): { pubBytes: Uint8Array; codec: number } {
  if (!did.startsWith("did:key:z")) throw new Error("unsupported DID format");
  const decoded = base58Decode(did.slice(9));
  const { value, length } = decodeUvarint(decoded, 0);
  if (value !== MULTICODEC_SECP256K1 && value !== MULTICODEC_ED25519)
    throw new Error(`unsupported multicodec: 0x${value.toString(16)}`);
  const key = decoded.slice(length);
  return { pubBytes: key, codec: value };
}

export function didFromECKey(key: ECKey): string {
  return didKeyFromPub(key.getPubBytes());
}

export function didFromEd25519Key(key: Ed25519Key): string {
  return didKeyFromPubEd25519(key.getPubBytes());
}

export function ecKeyFromDid(did: string): ECKey {
  const { pubBytes, codec } = pubFromDid(did);
  if (codec !== MULTICODEC_SECP256K1) throw new Error("DID is not secp256k1");
  return ECKey.fromPublicBytes(pubBytes);
}

export function ed25519KeyFromDid(did: string): Ed25519Key {
  const { pubBytes, codec } = pubFromDid(did);
  if (codec !== MULTICODEC_ED25519) throw new Error("DID is not Ed25519");
  return Ed25519Key.fromPublicBytes(pubBytes);
}

export function isValidDid(did: string): boolean {
  try { pubFromDid(did); return true; } catch { return false; }
}

// ── ECDH (secp256k1) ───────────────────────────────────────────────────

export interface EncryptedData {
  ephemeralPubKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export function ecdhSharedSecret(myPriv: Uint8Array, peerPub: Uint8Array): Uint8Array {
  return secp256k1.ecdh(peerPub, myPriv);
}

export function ecdhEncrypt(recipientPub: Uint8Array, data: Uint8Array): EncryptedData {
  let ephPriv: Uint8Array;
  do { ephPriv = randomBytes(32); } while (!secp256k1.privateKeyVerify(ephPriv));
  const ephPub = secp256k1.publicKeyCreate(ephPriv, true);
  const secret = ecdhSharedSecret(ephPriv, recipientPub);
  const key = sha256(sha256(concat(secret, new TextEncoder().encode("bigt-ecdh"))));
  const iv = randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key.slice(0, 32), iv);
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  return {
    ephemeralPubKey: new Uint8Array(ephPub),
    iv,
    ciphertext: new Uint8Array(Buffer.concat([enc, cipher.getAuthTag()])),
  };
}

export function ecdhDecrypt(myPriv: Uint8Array, encrypted: EncryptedData): Uint8Array {
  const secret = ecdhSharedSecret(myPriv, encrypted.ephemeralPubKey);
  const key = sha256(sha256(concat(secret, new TextEncoder().encode("bigt-ecdh"))));
  const authTag = encrypted.ciphertext.slice(-16);
  const ct = encrypted.ciphertext.slice(0, -16);
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key.slice(0, 32), encrypted.iv);
  decipher.setAuthTag(Buffer.from(authTag));
  return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
}

// ── challenge auth ──────────────────────────────────────────────────────

export function createChallenge(expiryMs: number = 5 * 60 * 1000): { nonce: string; expiresAt: number } {
  const nonce = bytesToHex(randomBytes(32));
  return { nonce, expiresAt: Date.now() + expiryMs };
}

export function signChallenge(nonce: string, key: ECKey | Ed25519Key): string {
  if (key instanceof Ed25519Key) {
    const sig = key.sign(hexToBytes(nonce));
    return bytesToHex(sig);
  }
  const hash = sha256(hexToBytes(nonce));
  const sig = (key as ECKey).sign(hash);
  return bytesToHex(sig.compact);
}

export function verifyChallenge(nonce: string, compactSigHex: string, pubKey: ECKey | Ed25519Key): boolean {
  if (pubKey instanceof Ed25519Key) {
    const sig = hexToBytes(compactSigHex);
    return pubKey.verify(hexToBytes(nonce), sig);
  }
  const hash = sha256(hexToBytes(nonce));
  const sig = hexToBytes(compactSigHex);
  return (pubKey as ECKey).verify(hash, sig);
}

export function verifyChallengeWithDid(did: string, nonce: string, compactSigHex: string): boolean {
  const { pubBytes, codec } = pubFromDid(did);
  if (codec === MULTICODEC_ED25519) {
    return Ed25519Key.fromPublicBytes(pubBytes).verify(hexToBytes(nonce), hexToBytes(compactSigHex));
  }
  return ECKey.fromPublicBytes(pubBytes).verify(sha256(hexToBytes(nonce)), hexToBytes(compactSigHex));
}

/** h160 = RIPEMD160(SHA256(pub)) — the bigtangle UTXO query key. */
export function pubKeyHashFromPub(pubBytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(pubBytes));
}

// ── chain address (BigTangle P2PKH-style) ────────────────────────────────

/**
 * Derive a BigTangle chain address from a public key:
 * base58(version ‖ RIPEMD160(SHA256(pub)) ‖ checksum4).
 * The version byte comes from the network's NetworkParameters (0x00 default).
 */
export function addressFromPub(pubBytes: Uint8Array, version: number = 0x00): string {
  const h160 = pubKeyHashFromPub(pubBytes);
  const payload = concat(new Uint8Array([version]), h160);
  const checksum = doubleSha256(payload).slice(0, 4);
  return base58Encode(concat(payload, checksum));
}

export function addressFromKey(key: ECKey | Ed25519Key, version?: number): string {
  return addressFromPub(key.getPubBytes(), version);
}
