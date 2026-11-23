import { describe, expect, it } from 'vitest';
import * as secp256k1 from 'secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  bigintToBytes,
  bytesToHex,
  erc20TransferData,
  hexToBytes,
  rlpEncode,
  signType2,
  unsignedType2Hash,
  type Type2Tx,
} from '../src/ethTx.js';
import { addressFromPublicKey } from '../src/depositAddress.js';

const KEY = hexToBytes('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const RECIPIENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('RLP', () => {
  it('matches the canonical vectors', () => {
    expect(bytesToHex(rlpEncode(new TextEncoder().encode('dog')))).toBe('0x83646f67');
    expect(bytesToHex(rlpEncode([
      new TextEncoder().encode('cat'),
      new TextEncoder().encode('dog'),
    ]))).toBe('0xc88363617483646f67');
    expect(bytesToHex(rlpEncode(bigintToBytes(0n)))).toBe('0x80');
    expect(bytesToHex(rlpEncode(bigintToBytes(15n)))).toBe('0x0f');
    expect(bytesToHex(rlpEncode(bigintToBytes(1024n)))).toBe('0x820400');
  });
});

describe('ERC-20 calldata', () => {
  it('encodes transfer(address,uint256)', () => {
    const data = bytesToHex(erc20TransferData(RECIPIENT, 100_000_000n));
    expect(data).toBe(
      '0xa9059cbb'
      + '0000000000000000000000007e5f4552091a69125d5dfcb7b8c2659029395bdf'
      + '0000000000000000000000000000000000000000000000000000000005f5e100',
    );
  });
});

describe('EIP-1559 signing', () => {
  const tx: Type2Tx = {
    chainId: 1n,
    nonce: 7n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 3_000_000_000n,
    gasLimit: 65_000n,
    to: hexToBytes(USDT),
    value: 0n,
    data: erc20TransferData(RECIPIENT, 1n),
  };

  it('signs a type-2 payload that recovers to the sender', () => {
    const signed = signType2(tx, KEY);
    expect(signed.raw[0]).toBe(0x02);
    expect(bytesToHex(signed.sighash)).toBe(bytesToHex(unsignedType2Hash(tx)));
    expect(bytesToHex(signed.hash)).toBe(bytesToHex(keccak_256(signed.raw)));

    const recovered = secp256k1.ecdsaRecover(
      concat([signed.r, signed.s]),
      signed.yParity,
      signed.sighash,
      false,
    );
    expect(addressFromPublicKey(recovered)).toBe(ADDRESS);
  });

  it('rejects a malformed recipient', () => {
    expect(() => signType2({ ...tx, to: new Uint8Array(19) }, KEY)).toThrow(/20-byte/);
  });
});
