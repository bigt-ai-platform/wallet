/**
 * Per-user EVM deposit addresses (Binance-style), derived from an **xpub**.
 *
 * The issuer never needs private keys to *receive*: a BIP32 extended public key
 * at an account/change level is enough to derive `m/…/<index>` addresses for
 * each L1 account. Sweeping those addresses is a separate job that needs the
 * corresponding signing key (HSM/MPC), exactly like Binance's deposit sweep.
 *
 * Only non-hardened derivation is possible from an xpub; that is enforced here
 * rather than failing later inside secp256k1.
 *
 * Address = last 20 bytes of keccak256(uncompressed public key), EIP-55 shown.
 */

import * as secp256k1 from 'secp256k1';
import bs58 from 'bs58';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const HARDENED = 0x80000000;
/** 78-byte BIP32 payload + 4-byte base58check checksum. */
const XPUB_LENGTH = 82;
const XPUB_PAYLOAD = 78;

export interface ExtendedPublicKey {
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
  /** 32-byte chain code. */
  chainCode: Uint8Array;
  depth: number;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * Parse a base58check xpub/tpub. The version bytes are not pinned (mainnet and
 * testnet both work); the key and chain code are what matter.
 */
export function parseXpub(text: string): ExtendedPublicKey {
  const value = text.trim();
  if (!value) throw new Error('xpub is empty');

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error('xpub is not valid base58');
  }
  if (decoded.length !== XPUB_LENGTH) {
    throw new Error(`xpub must decode to ${XPUB_LENGTH} bytes, got ${decoded.length}`);
  }

  const payload = decoded.subarray(0, XPUB_PAYLOAD);
  const checksum = decoded.subarray(XPUB_PAYLOAD);
  const expected = sha256(sha256(payload)).subarray(0, 4);
  if (!equalBytes(expected, checksum)) throw new Error('xpub checksum does not verify');

  const publicKey = decoded.subarray(45, 78);
  if (publicKey[0] !== 0x02 && publicKey[0] !== 0x03) {
    throw new Error('xpub does not carry a compressed public key');
  }
  try {
    secp256k1.publicKeyConvert(publicKey, true);
  } catch {
    throw new Error('xpub public key is not a valid secp256k1 point');
  }

  return {
    publicKey: Uint8Array.from(publicKey),
    chainCode: Uint8Array.from(decoded.subarray(13, 45)),
    depth: decoded[4]!,
  };
}

/** BIP32 non-hardened child. Throws on a hardened index. */
export function deriveChild(parent: ExtendedPublicKey, index: number): ExtendedPublicKey {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
    throw new Error(`cannot derive hardened or invalid index ${index} from an xpub`);
  }
  const data = new Uint8Array(37);
  data.set(parent.publicKey, 0);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;

  const digest = hmac(sha512, parent.chainCode, data);
  const tweak = digest.subarray(0, 32);
  const chainCode = Uint8Array.from(digest.subarray(32));

  let publicKey: Uint8Array;
  try {
    publicKey = secp256k1.publicKeyTweakAdd(parent.publicKey, tweak, true);
  } catch {
    // BIP32 says to skip such an index (probability ~2^-127); surface it so the
    // allocator can try the next one instead of returning a wrong address.
    throw new Error(`invalid child key at index ${index}; try the next index`);
  }

  return { publicKey, chainCode, depth: parent.depth + 1 };
}

/**
 * Derive a path (e.g. `0` or `0/1`) from an xpub. Segments must be
 * non-hardened decimal indices.
 */
export function derivePath(xpub: string, path: string): ExtendedPublicKey {
  let node = parseXpub(xpub);
  const segments = path.split('/').map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    if (/[h']$/i.test(segment)) {
      throw new Error(`hardened segment '${segment}' cannot be derived from an xpub`);
    }
    if (!/^\d+$/.test(segment)) throw new Error(`invalid derivation segment '${segment}'`);
    const index = Number(segment);
    if (!Number.isSafeInteger(index)) throw new Error(`derivation index out of range: ${segment}`);
    node = deriveChild(node, index);
  }
  return node;
}

/** 20-byte address from a compressed/uncompressed public key, EIP-55 shown. */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  const uncompressed = secp256k1.publicKeyConvert(publicKey, false);
  const digest = keccak_256(uncompressed.subarray(1));
  return toChecksumAddress(`0x${hex(digest.subarray(12))}`);
}

/** EIP-55 mixed-case form for a 20-byte hex address. */
export function toChecksumAddress(address: string): string {
  const clean = address.replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error('invalid Ethereum address');
  const digest = keccak_256(new TextEncoder().encode(clean));
  let out = '0x';
  for (let i = 0; i < clean.length; i += 1) {
    const nibble = (digest[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? clean[i]!.toUpperCase() : clean[i]!;
  }
  return out;
}

/**
 * Address for `<xpub><path>/<index>`. `path` defaults to the external chain
 * (`0`), i.e. an account-level xpub at `m/44'/60'/0'`.
 */
export function deriveDepositAddress(xpub: string, path: string, index: number): string {
  const parent = derivePath(xpub, path);
  return addressFromPublicKey(deriveChild(parent, index).publicKey);
}

// ─── Private derivation (sweeping only) ─────────────────────────────────────

export interface ExtendedPrivateKey {
  privateKey: Uint8Array;
  chainCode: Uint8Array;
  depth: number;
}

/**
 * Parse a base58check xprv. This is **signing material**: keep it in the
 * sweeper process only (HSM/MPC or a short-lived testnet run), never in the
 * HTTP service.
 */
export function parseXprv(text: string): ExtendedPrivateKey {
  const value = text.trim();
  if (!value) throw new Error('xprv is empty');

  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error('xprv is not valid base58');
  }
  if (decoded.length !== XPUB_LENGTH) {
    throw new Error(`xprv must decode to ${XPUB_LENGTH} bytes, got ${decoded.length}`);
  }

  const payload = decoded.subarray(0, XPUB_PAYLOAD);
  const checksum = decoded.subarray(XPUB_PAYLOAD);
  if (!equalBytes(sha256(sha256(payload)).subarray(0, 4), checksum)) {
    throw new Error('xprv checksum does not verify');
  }
  if (decoded[45] !== 0x00) throw new Error('xprv does not carry a private key');

  const privateKey = Uint8Array.from(decoded.subarray(46, 78));
  if (!secp256k1.privateKeyVerify(privateKey)) throw new Error('xprv private key is invalid');

  return {
    privateKey,
    chainCode: Uint8Array.from(decoded.subarray(13, 45)),
    depth: decoded[4]!,
  };
}

/** BIP32 child from a private node; hardens when `index >= 2^31`. */
export function derivePrivateChild(parent: ExtendedPrivateKey, index: number): ExtendedPrivateKey {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 32) {
    throw new Error(`invalid derivation index ${index}`);
  }
  const hardened = index >= HARDENED;
  const data = new Uint8Array(37);
  if (hardened) {
    data.set(parent.privateKey, 1);
  } else {
    data.set(secp256k1.publicKeyCreate(parent.privateKey, true), 0);
  }
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;

  const digest = hmac(sha512, parent.chainCode, data);
  const tweak = digest.subarray(0, 32);
  let privateKey: Uint8Array;
  try {
    privateKey = secp256k1.privateKeyTweakAdd(parent.privateKey, tweak);
  } catch {
    throw new Error(`invalid child key at index ${index}; try the next index`);
  }
  return {
    privateKey: Uint8Array.from(privateKey),
    chainCode: Uint8Array.from(digest.subarray(32)),
    depth: parent.depth + 1,
  };
}

/** Derive a path (`0`, `0/1`, `0'`) from an xprv. */
export function derivePrivatePath(xprv: string, path: string): ExtendedPrivateKey {
  let node = parseXprv(xprv);
  const segments = path.split('/').map((s) => s.trim()).filter(Boolean);
  for (const segment of segments) {
    const hardened = /[h']$/i.test(segment);
    const numeric = hardened ? segment.slice(0, -1) : segment;
    if (!/^\d+$/.test(numeric)) throw new Error(`invalid derivation segment '${segment}'`);
    const index = Number(numeric) + (hardened ? HARDENED : 0);
    if (!Number.isSafeInteger(index) || index >= 2 ** 32) {
      throw new Error(`derivation index out of range: ${segment}`);
    }
    node = derivePrivateChild(node, index);
  }
  return node;
}

/** Secret for `<xprv><path>/<index>`; the sweep signer's only key input. */
export function privateKeyAt(xprv: string, path: string, index: number): Uint8Array {
  if (index < 0 || index >= HARDENED) throw new Error('deposit index must be non-hardened');
  return derivePrivateChild(derivePrivatePath(xprv, path), index).privateKey;
}
