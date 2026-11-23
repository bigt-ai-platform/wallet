import { describe, expect, it } from 'vitest';
import * as secp256k1 from 'secp256k1';
import bs58 from 'bs58';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  addressFromPublicKey,
  deriveDepositAddress,
  derivePath,
  derivePrivatePath,
  parseXpub,
  parseXprv,
  privateKeyAt,
  toChecksumAddress,
} from '../src/depositAddress.js';

/**
 * BIP32 test vector 1 (seed 000102…0f), at m/0'/1. Non-hardened children can
 * therefore be checked independently through the matching xprv.
 */
const XPUB_M_0H_1 = 'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ';
const XPRV_M_0H_1 = 'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs';

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Test-side raw decode (no checksum validation) for the private oracle. */
function parseXprvUnchecked(text: string): { privateKey: Uint8Array; chainCode: Uint8Array } {
  const decoded = bs58.decode(text);
  return {
    privateKey: Uint8Array.from(decoded.subarray(46, 78)),
    chainCode: Uint8Array.from(decoded.subarray(13, 45)),
  };
}

/** Independent private-path derivation for the test oracle. */
function privateChild(
  parent: { privateKey: Uint8Array; chainCode: Uint8Array },
  index: number,
): { privateKey: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array(37);
  data.set(secp256k1.publicKeyCreate(parent.privateKey, true), 0);
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;
  const digest = hmac(sha512, parent.chainCode, data);
  return {
    privateKey: secp256k1.privateKeyTweakAdd(parent.privateKey, digest.subarray(0, 32)),
    chainCode: Uint8Array.from(digest.subarray(32)),
  };
}

describe('xpub parsing', () => {
  it('reads the chain code and compressed key', () => {
    const node = parseXpub(XPUB_M_0H_1);
    expect(node.publicKey).toHaveLength(33);
    expect(node.chainCode).toHaveLength(32);
    expect(node.depth).toBe(2);
  });

  it('rejects a bad checksum and a hardened path', () => {
    expect(() => parseXpub(XPUB_M_0H_1.replace(/^xpub6/, 'xpub7'))).toThrow(/checksum/);
    expect(() => derivePath(XPUB_M_0H_1, "0'")).toThrow(/hardened/);
  });
});

describe('address derivation', () => {
  it('matches the private-key derivation at m/0\'/1/2', () => {
    const expectedPrivate = privateChild(parseXprvUnchecked(XPRV_M_0H_1), 2).privateKey;
    const expected = addressFromPublicKey(secp256k1.publicKeyCreate(expectedPrivate, false));

    expect(deriveDepositAddress(XPUB_M_0H_1, '', 2)).toBe(expected);
    expect(derivePath(XPUB_M_0H_1, '')).toMatchObject({ depth: 2 });
  });

  it('applies a non-hardened path before the index', () => {
    // m/0'/1 + 3 = m/0'/1/3
    const node3 = privateChild(parseXprvUnchecked(XPRV_M_0H_1), 3);
    const expected = addressFromPublicKey(secp256k1.publicKeyCreate(node3.privateKey, false));
    expect(deriveDepositAddress(XPUB_M_0H_1, '', 3)).toBe(expected);

    const derivedNode = derivePath(XPUB_M_0H_1, '3');
    expect(addressFromPublicKey(derivedNode.publicKey)).toBe(expected);
    expect(derivedNode.depth).toBe(3);

    // ...and one more hop: m/0'/1/3/0.
    const expectedChild = addressFromPublicKey(
      secp256k1.publicKeyCreate(privateChild(node3, 0).privateKey, false),
    );
    expect(deriveDepositAddress(XPUB_M_0H_1, '3', 0)).toBe(expectedChild);
  });

  it('derives the sweep key that matches the xpub address at m/0\'/1/2', () => {
    const key = privateKeyAt(XPRV_M_0H_1, '', 2);
    const address = addressFromPublicKey(secp256k1.publicKeyCreate(key, false));
    expect(address).toBe(deriveDepositAddress(XPUB_M_0H_1, '', 2));
  });

  it('supports hardened segments from an xprv (BIP32 vector m/0\'/1/2\')', () => {
    const node = derivePrivatePath(XPRV_M_0H_1, "2'");
    const expected = parseXprv('xprv9z4pot5VBttmtdRTWfWQmoH1taj2axGVzFqSb8C9xaxKymcFzXBDptWmT7FwuEzG3ryjH4ktypQSAewRiNMjANTtpgP4mLTj34bhnZX7UiM');
    expect(toHex(node.privateKey)).toBe(toHex(expected.privateKey));
    expect(toHex(node.chainCode)).toBe(toHex(expected.chainCode));
    expect(node.depth).toBe(3);
  });

  it('rejects a corrupted xprv checksum', () => {
    expect(() => parseXprv(XPRV_M_0H_1.replace(/^xprv9/, 'xprv8'))).toThrow(/checksum/);
  });

  it('produces EIP-55 addresses for the Hardhat account 0 key', () => {
    const key = hexToBytes('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    expect(addressFromPublicKey(secp256k1.publicKeyCreate(key, false)))
      .toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(toChecksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed'))
      .toBe('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  });
});
