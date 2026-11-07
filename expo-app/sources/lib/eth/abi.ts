/**
 * Tiny ABI codec for the only contract calls the wallet makes: ERC-20
 * `balanceOf`, `decimals`, `symbol` and `transfer`. All values are 32-byte
 * words; there are no dynamic arrays or structs.
 */

import { hexToBytes, stripHexPrefix, toChecksumAddress, isAddress } from './address';
import { concatBytes } from './rlp';

export const ERC20_SELECTORS = {
  balanceOf: '0x70a08231',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  transfer: '0xa9059cbb',
} as const;

/** 32-byte big-endian word for a non-negative integer. */
export function uintWord(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('ABI uint cannot be negative');
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('ABI uint256 overflow');
  return out;
}

/** 32-byte left-padded address word. */
export function addressWord(address: string): Uint8Array {
  if (!isAddress(address)) throw new Error('Invalid Ethereum address');
  const out = new Uint8Array(32);
  out.set(hexToBytes(stripHexPrefix(address).toLowerCase()), 12);
  return out;
}

export function encodeCall(selector: string, ...words: Uint8Array[]): string {
  const body = concatBytes([hexToBytes(selector), ...words]);
  let out = '0x';
  for (const b of body) out += b.toString(16).padStart(2, '0');
  return out;
}

export function encodeBalanceOf(address: string): string {
  return encodeCall(ERC20_SELECTORS.balanceOf, addressWord(address));
}

export function encodeTransfer(to: string, amount: bigint): string {
  return encodeCall(ERC20_SELECTORS.transfer, addressWord(to), uintWord(amount));
}

function dataBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? hexToBytes(stripHexPrefix(data)) : data;
}

/** Decode a single 32-byte uint word (returns 0 for empty data). */
export function decodeUint(data: string | Uint8Array): bigint {
  const bytes = dataBytes(data);
  if (bytes.length === 0) return 0n;
  const word = bytes.length >= 32 ? bytes.subarray(0, 32) : bytes;
  let out = 0n;
  for (const b of word) out = (out << 8n) | BigInt(b);
  return out;
}

/** Decode an ABI-encoded `string` return value (offset/length/bytes layout). */
export function decodeString(data: string | Uint8Array): string {
  const bytes = dataBytes(data);
  if (bytes.length <= 64) return '';
  try {
    const offset = Number(decodeUint(bytes.subarray(0, 32)));
    if (offset + 32 > bytes.length) return '';
    const length = Number(decodeUint(bytes.subarray(offset, offset + 32)));
    if (offset + 32 + length > bytes.length) return '';
    const text = bytes.subarray(offset + 32, offset + 32 + length);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(text);
    let out = '';
    for (const b of text) out += String.fromCharCode(b);
    return out;
  } catch {
    return '';
  }
}

/** Addresses inside call data are lowercase; expose the checksummed form. */
export function checksumOrRaw(address: string): string {
  try {
    return toChecksumAddress(address);
  } catch {
    return address;
  }
}
