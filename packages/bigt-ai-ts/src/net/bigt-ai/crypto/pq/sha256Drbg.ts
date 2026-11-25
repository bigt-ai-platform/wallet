import { sha256 } from '@noble/hashes/sha256';

export const MLDSA_SEED_BYTES = 32;
export const SLHDSA_SEED_BYTES = 96;

export function sha256Drbg(seed: Uint8Array, outputLen: number): Uint8Array {
  const hashLen = 32;
  const hashSize = BigInt(hashLen);

  // addSeedMaterial(byte[]): seed = H(input || seed_old)
  let d = sha256.create();
  if (seed.length > 0) {
    d.update(seed);
  }
  let seedBuf = new Uint8Array(hashLen);
  d.update(seedBuf);
  seedBuf = new Uint8Array(d.digest());

  let stateBuf = new Uint8Array(hashLen);
  let stateCounter = 1n;

  const result = new Uint8Array(outputLen);
  let offset = 0;
  while (offset < outputLen) {
    // generateState(): state = H(old_counter || state || seed)
    const oldCounter = stateCounter;
    stateCounter += 1n;

    d = sha256.create();
    // Little-endian counter byte order (matching BC DigestRandomGenerator)
    for (let i = 0; i < 8; i++) {
      d.update(new Uint8Array([Number(oldCounter >> BigInt(i * 8) & 0xFFn)]));
    }
    d.update(stateBuf);
    d.update(seedBuf);
    stateBuf = new Uint8Array(d.digest());

    const copyLen = Math.min(hashLen, outputLen - offset);
    result.set(stateBuf.subarray(0, copyLen), offset);
    offset += copyLen;
  }
  return result;
}
