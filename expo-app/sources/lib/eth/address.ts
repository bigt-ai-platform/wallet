/**
 * Bigtangle EC key → Ethereum address.
 *
 * The wallet's legacy EC key is a plain 32-byte secp256k1 secret, so it is also
 * a valid Ethereum private key (exactly what `../vmproject` does with web3j's
 * `Credentials.create(hex)`). Post-quantum keys have no secp256k1 point and
 * therefore no Ethereum address — callers must gate on `keyType === 'EC'`.
 *
 * Address = last 20 bytes of keccak256(uncompressed 64-byte public key),
 * displayed with the EIP-55 mixed-case checksum.
 */

import * as secp256k1 from 'secp256k1';
// `@noble/hashes` ships in the bundle already (bigtangle-ts dependency).
import { keccak_256 } from '@noble/hashes/sha3.js';

export function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = stripHexPrefix(hex.trim());
  if (!/^[0-9a-fA-F]*$/.test(clean)) throw new Error('Invalid hex string');
  if (clean.length % 2 !== 0) throw new Error('Hex string must have an even length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Validates a secp256k1 secret (32 bytes, in range) and returns its bytes. */
export function privateKeyBytes(hex: string): Uint8Array {
  const bytes = hexToBytes(hex);
  if (bytes.length !== 32) throw new Error('Ethereum private key must be 32 bytes');
  if (!secp256k1.privateKeyVerify(bytes)) throw new Error('Invalid secp256k1 private key');
  return bytes;
}

/** 65-byte uncompressed public key for a 32-byte secret. */
export function publicKeyUncompressed(privateKey: Uint8Array): Uint8Array {
  return secp256k1.publicKeyCreate(privateKey, false);
}

/**
 * 20-byte address from a public key. Accepts 65-byte uncompressed, 64-byte raw
 * or 33-byte compressed input (the compressed form is decompressed first).
 */
export function addressBytesFromPublicKey(publicKey: Uint8Array): Uint8Array {
  let uncompressed: Uint8Array;
  if (publicKey.length === 65 && publicKey[0] === 0x04) {
    uncompressed = publicKey;
  } else if (publicKey.length === 64) {
    uncompressed = new Uint8Array(65);
    uncompressed[0] = 0x04;
    uncompressed.set(publicKey, 1);
  } else if (publicKey.length === 33) {
    uncompressed = secp256k1.publicKeyConvert(publicKey, false);
  } else {
    throw new Error('Unsupported public key length');
  }
  const digest = keccak_256(uncompressed.subarray(1));
  return digest.subarray(12);
}

/** EIP-55 checksum address (`0x` + mixed case) for a 20-byte/lowercase-hex input. */
export function toChecksumAddress(address: string): string {
  const clean = stripHexPrefix(address).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new Error('Invalid Ethereum address');
  const digest = keccak_256(new TextEncoder().encode(clean));
  let out = '0x';
  for (let i = 0; i < clean.length; i++) {
    const nibble = (digest[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    out += nibble >= 8 ? clean[i].toUpperCase() : clean[i];
  }
  return out;
}

/** Checksummed Ethereum address for a hex private key. */
export function addressFromPrivateKey(privateKeyHex: string): string {
  const priv = privateKeyBytes(privateKeyHex);
  return toChecksumAddress(bytesToHex(addressBytesFromPublicKey(publicKeyUncompressed(priv))));
}

/** True for any 20-byte hex address, checksummed or not. */
export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

/**
 * True when the value is a *mixed-case* address whose casing matches EIP-55.
 * All-lowercase (and all-uppercase) input is accepted — it carries no checksum
 * to verify; mixed case that does not match is a poisoned/mistyped address.
 */
export function isValidChecksumAddress(value: string): boolean {
  if (!isAddress(value)) return false;
  const clean = stripHexPrefix(value);
  if (clean === clean.toLowerCase() || clean === clean.toUpperCase()) return true;
  return toChecksumAddress(clean) === `0x${clean}`;
}

/** Normalizes to the checksummed form, rejecting invalid/poisoned input. */
export function requireAddress(value: string): string {
  if (!isAddress(value)) throw new Error('Invalid Ethereum address');
  if (!isValidChecksumAddress(value)) throw new Error('Invalid EIP-55 checksum');
  return toChecksumAddress(value);
}

/** Case-insensitive address equality (checksum casing is presentation only). */
export function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && stripHexPrefix(a).toLowerCase() === stripHexPrefix(b).toLowerCase();
}
