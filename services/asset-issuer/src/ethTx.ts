/**
 * Minimal EIP-1559 transaction encoder/signer for the deposit sweeper.
 *
 * The wallet has a richer `lib/eth` implementation, but it lives inside the app
 * bundle (React Native aliases); the issuer service keeps only what a sweep
 * needs: RLP, the type-2 signing hash and a `transfer(address,uint256)` call.
 * No provider SDK and no key handling beyond the injected secp256k1 secret.
 */

import * as secp256k1 from 'secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';

export type RlpInput = Uint8Array | RlpInput[];

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function encodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const lengthBytes = bigintToBytes(BigInt(length));
  return concat([Uint8Array.of(offset + 55 + lengthBytes.length), lengthBytes]);
}

/** RLP encode bytes or a list. Integers are encoded with {@link bigintToBytes}. */
export function rlpEncode(input: RlpInput): Uint8Array {
  if (Array.isArray(input)) {
    const body = concat(input.map(rlpEncode));
    return concat([encodeLength(body.length, 0xc0), body]);
  }
  if (input.length === 1 && input[0]! < 0x80) return Uint8Array.from(input);
  return concat([encodeLength(input.length, 0x80), input]);
}

/** Big-endian minimal bytes; **0 encodes as the empty byte string** (RLP integer). */
export function bigintToBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('cannot encode a negative integer');
  if (value === 0n) return new Uint8Array();
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2) throw new Error('invalid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBigInt(hex: string): bigint {
  return hex === '0x' || hex === '' ? 0n : BigInt(hex);
}

/** keccak256("transfer(address,uint256)") */
const TRANSFER_SELECTOR = Uint8Array.of(0xa9, 0x05, 0x9c, 0xbb);

/** ERC-20 `transfer(to, amount)` calldata. */
export function erc20TransferData(to: string, amountRaw: bigint): Uint8Array {
  const address = hexToBytes(to);
  if (address.length !== 20) throw new Error('ERC-20 recipient must be a 20-byte address');
  if (amountRaw < 0n) throw new Error('amount must be >= 0');
  const addressWord = new Uint8Array(32);
  addressWord.set(address, 12);
  const amount = new Uint8Array(32);
  let value = amountRaw;
  for (let i = 31; i >= 0 && value > 0n; i -= 1) {
    amount[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return concat([TRANSFER_SELECTOR, addressWord, amount]);
}

export interface Type2Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** 20-byte recipient. */
  to: Uint8Array;
  value: bigint;
  data: Uint8Array;
  accessList?: RlpInput[];
}

function txFields(tx: Type2Tx): RlpInput[] {
  return [
    bigintToBytes(tx.chainId),
    bigintToBytes(tx.nonce),
    bigintToBytes(tx.maxPriorityFeePerGas),
    bigintToBytes(tx.maxFeePerGas),
    bigintToBytes(tx.gasLimit),
    tx.to,
    bigintToBytes(tx.value),
    tx.data,
    tx.accessList ?? [],
  ];
}

/** keccak256(0x02 || rlp(fields)) — the digest the sender signs. */
export function unsignedType2Hash(tx: Type2Tx): Uint8Array {
  if (tx.to.length !== 20) throw new Error('recipient must be a 20-byte address');
  return keccak_256(concat([Uint8Array.of(0x02), rlpEncode(txFields(tx))]));
}

export interface SignedType2 {
  /** Raw transaction to broadcast (`eth_sendRawTransaction`). */
  raw: Uint8Array;
  /** Transaction hash = keccak256(raw). */
  hash: Uint8Array;
  /** Digest that was signed, for recovery/tests. */
  sighash: Uint8Array;
  yParity: number;
  r: Uint8Array;
  s: Uint8Array;
}

export function signType2(tx: Type2Tx, privateKey: Uint8Array): SignedType2 {
  if (!secp256k1.privateKeyVerify(privateKey)) throw new Error('invalid secp256k1 private key');
  const sighash = unsignedType2Hash(tx);
  const { signature, recid } = secp256k1.ecdsaSign(sighash, privateKey);
  const r = Uint8Array.from(signature.subarray(0, 32));
  const s = Uint8Array.from(signature.subarray(32));
  const yParity = recid;
  const raw = concat([
    Uint8Array.of(0x02),
    rlpEncode([...txFields(tx), bigintToBytes(BigInt(yParity)), r, s]),
  ]);
  return { raw, hash: keccak_256(raw), sighash, yParity, r, s };
}
