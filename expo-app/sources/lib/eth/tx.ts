/**
 * EIP-1559 (type-2) transaction encoding and signing.
 *
 * payload  = 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *                          gasLimit, to, value, data, accessList])
 * hash     = keccak256(payload)
 * raw      = 0x02 || rlp([...same fields, yParity, r, s])
 *
 * `secp256k1.ecdsaSign` returns a canonical (low-S) signature — required by
 * EIP-2 — plus the recovery id that becomes `yParity`. Chain id is always
 * signed, so a transaction cannot be replayed on another chain.
 */

import * as secp256k1 from 'secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, rlpEncode, type RlpInput } from './rlp';
import { bytesToHex, hexToBytes, stripHexPrefix, isAddress, toChecksumAddress, addressFromPrivateKey, addressBytesFromPublicKey } from './address';

export interface Eip1559TxParams {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** Recipient; contract creation (empty `to`) is not supported. */
  to: string;
  value: bigint;
  /** Calldata (ERC-20 transfer), 0x-hex or bytes. */
  data?: string | Uint8Array;
}

export interface SignedEip1559Tx {
  /** 0x02-prefixed signed transaction, ready for eth_sendRawTransaction. */
  raw: string;
  /** keccak256 of `raw` — the transaction hash. */
  hash: string;
  /** Signer address (checksummed), for safety assertions. */
  from: string;
}

function dataBytes(data?: string | Uint8Array): Uint8Array {
  if (!data) return new Uint8Array(0);
  return typeof data === 'string' ? hexToBytes(stripHexPrefix(data)) : data;
}

function txFields(tx: Eip1559TxParams): RlpInput[] {
  if (!isAddress(tx.to)) throw new Error('Invalid recipient address');
  if (tx.value < 0n) throw new Error('Value cannot be negative');
  return [
    tx.chainId,
    tx.nonce,
    tx.maxPriorityFeePerGas,
    tx.maxFeePerGas,
    tx.gasLimit,
    hexToBytes(stripHexPrefix(tx.to).toLowerCase()),
    tx.value,
    dataBytes(tx.data),
    [], // accessList
  ];
}

const TYPE_2 = new Uint8Array([0x02]);

/** Unsigned type-2 payload (what gets hashed for signing). */
export function encodeUnsignedType2(tx: Eip1559TxParams): Uint8Array {
  return concatBytes([TYPE_2, rlpEncode(txFields(tx))]);
}

export function unsignedType2Hash(tx: Eip1559TxParams): Uint8Array {
  return keccak_256(encodeUnsignedType2(tx));
}

export function signEip1559(tx: Eip1559TxParams, privateKey: Uint8Array): SignedEip1559Tx {
  if (privateKey.length !== 32) throw new Error('Ethereum private key must be 32 bytes');
  const digest = unsignedType2Hash(tx);
  const { signature, recid } = secp256k1.ecdsaSign(digest, privateKey);
  const r = BigInt(bytesToHex(signature.subarray(0, 32)));
  const s = BigInt(bytesToHex(signature.subarray(32, 64)));
  const raw = concatBytes([
    TYPE_2,
    rlpEncode([...txFields(tx), BigInt(recid), r, s]),
  ]);
  return {
    raw: bytesToHex(raw),
    hash: bytesToHex(keccak_256(raw)),
    from: addressFromPrivateKey(bytesToHex(privateKey)),
  };
}

/** Recover the signer address from a signed type-2 transaction (self-check). */
export function decodeType2(raw: string): {
  params: Eip1559TxParams;
  yParity: number;
  r: bigint;
  s: bigint;
} {
  const bytes = hexToBytes(stripHexPrefix(raw));
  if (bytes[0] !== 0x02) throw new Error('Not a type-2 transaction');
  const fields = decodeRlpList(bytes.subarray(1));
  if (fields.length !== 12) throw new Error('Malformed type-2 transaction');
  const asBig = (f: Uint8Array) => (f.length === 0 ? 0n : BigInt(bytesToHex(f)));
  return {
    params: {
      chainId: asBig(fields[0]),
      nonce: asBig(fields[1]),
      maxPriorityFeePerGas: asBig(fields[2]),
      maxFeePerGas: asBig(fields[3]),
      gasLimit: asBig(fields[4]),
      to: bytesToHex(fields[5]),
      value: asBig(fields[6]),
      data: fields[7],
    },
    yParity: Number(asBig(fields[9])),
    r: asBig(fields[10]),
    s: asBig(fields[11]),
  };
}

export function recoverType2Signer(raw: string): string {
  const { params, yParity, r, s } = decodeType2(raw);
  const sig = new Uint8Array(64);
  sig.set(hexToBytes(r.toString(16).padStart(64, '0')), 0);
  sig.set(hexToBytes(s.toString(16).padStart(64, '0')), 32);
  const pub = secp256k1.ecdsaRecover(sig, yParity, unsignedType2Hash(params), false);
  return toChecksumAddress(bytesToHex(addressBytesFromPublicKey(pub)));
}

/** Single-level RLP list decoder (enough for our own transaction payloads). */
function decodeRlpList(bytes: Uint8Array): Uint8Array[] {
  if (bytes[0] < 0xc0) throw new Error('Expected an RLP list');
  let offset = 1;
  let length = bytes[0] - 0xc0;
  if (length >= 56) {
    const lenOfLen = length - 55;
    length = 0;
    for (let i = 0; i < lenOfLen; i++) length = length * 256 + bytes[offset++];
  }
  const end = offset + length;
  const items: Uint8Array[] = [];
  while (offset < end) {
    const prefix = bytes[offset];
    if (prefix < 0x80) {
      items.push(bytes.subarray(offset, offset + 1));
      offset += 1;
    } else if (prefix < 0xb8) {
      const len = prefix - 0x80;
      items.push(bytes.subarray(offset + 1, offset + 1 + len));
      offset += 1 + len;
    } else if (prefix < 0xc0) {
      const lenOfLen = prefix - 0xb7;
      let len = 0;
      for (let i = 0; i < lenOfLen; i++) len = len * 256 + bytes[offset + 1 + i];
      const start = offset + 1 + lenOfLen;
      items.push(bytes.subarray(start, start + len));
      offset = start + len;
    } else {
      // A list field (only the empty access list in a type-2 tx): keep its raw
      // encoded slice so the field count stays aligned.
      const start = offset;
      let cursor = offset + 1;
      let len: number;
      if (prefix < 0xf8) {
        len = prefix - 0xc0;
      } else {
        const lenOfLen = prefix - 0xf7;
        len = 0;
        for (let i = 0; i < lenOfLen; i++) len = len * 256 + bytes[cursor++];
      }
      const end2 = cursor + len;
      items.push(bytes.subarray(start, end2));
      offset = end2;
    }
  }
  return items;
}
