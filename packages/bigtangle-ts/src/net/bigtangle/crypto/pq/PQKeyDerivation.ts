import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { PQConstants } from './PQConstants';

const KEY_SEED_LEN = 32;

export class PQKeyDerivation {
  static deriveRootKeyMaterial(seed: Uint8Array): Uint8Array {
    if (seed.length < 32)
      throw new Error("seed must be >= 32 bytes (256-bit entropy)");

    const salt = new TextEncoder().encode(PQConstants.HKDF_SALT);
    const prk = hkdfExtract(salt, seed);
    const info = new TextEncoder().encode(PQConstants.HKDF_INFO_WALLET);
    return hkdfExpand(prk, info, 64);
  }

  static deriveChildKey(prk: Uint8Array, index: number, suite: number): Uint8Array {
    const info = new TextEncoder().encode("child-" + index + "-" + suite);
    return hkdfExpand(prk, info, 64);
  }

  static getMLDSASeed(keyMaterial: Uint8Array): Uint8Array {
    return keyMaterial.slice(0, KEY_SEED_LEN);
  }

  static getSLHDSASeed(keyMaterial: Uint8Array): Uint8Array {
    return keyMaterial.slice(KEY_SEED_LEN, KEY_SEED_LEN * 2);
  }
}

function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return new Uint8Array(hmac(sha256, salt, ikm));
}

function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let t: Uint8Array = new Uint8Array(0);
  let offset = 0;

  for (let i = 1; offset < length; i++) {
    const mac = hmac.create(sha256, prk);
    mac.update(t);
    mac.update(info);
    mac.update(new Uint8Array([i & 0xFF]));
    t = new Uint8Array(mac.digest());

    const copyLen = Math.min(t.length, length - offset);
    result.set(t.subarray(0, copyLen), offset);
    offset += copyLen;
  }

  return result;
}
