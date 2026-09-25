import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { slh_dsa_sha2_256s } from '@noble/post-quantum/slh-dsa.js';
import { PQConstants } from './PQConstants';
import { sha256Drbg, MLDSA_SEED_BYTES, SLHDSA_SEED_BYTES } from './sha256Drbg';

export interface PQKeyPair {
  algorithm: number;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export class UnsupportedOperationException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedOperationException';
  }
}

export class BcPQSignatureProvider {
  supportedAlgorithms(): number[] {
    return [PQConstants.ALG_ML_DSA_87, PQConstants.ALG_SLH_DSA_SHA2_256S];
  }

  generateKeyPair(algorithm: number, seed: Uint8Array): PQKeyPair {
    switch (algorithm) {
      case PQConstants.ALG_ML_DSA_87:
        return this.generateMLDSA(seed);
      case PQConstants.ALG_SLH_DSA_SHA2_256S:
        return this.generateSLHDSA(seed);
      default:
        throw new UnsupportedOperationException("Unsupported algorithm: " + algorithm);
    }
  }

  sign(algorithm: number, privateKey: Uint8Array, message: Uint8Array): Uint8Array {
    switch (algorithm) {
      case PQConstants.ALG_ML_DSA_87:
        return ml_dsa87.sign(message, privateKey);
      case PQConstants.ALG_SLH_DSA_SHA2_256S:
        return slh_dsa_sha2_256s.sign(message, privateKey);
      default:
        throw new UnsupportedOperationException("Unsupported algorithm: " + algorithm);
    }
  }

  verify(algorithm: number, publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    switch (algorithm) {
      case PQConstants.ALG_ML_DSA_87:
        return ml_dsa87.verify(signature, message, publicKey);
      case PQConstants.ALG_SLH_DSA_SHA2_256S:
        return slh_dsa_sha2_256s.verify(signature, message, publicKey);
      default:
        throw new UnsupportedOperationException("Unsupported algorithm: " + algorithm);
    }
  }

  private generateMLDSA(seed: Uint8Array): PQKeyPair {
    const xi = sha256Drbg(seed, MLDSA_SEED_BYTES);
    const kp = ml_dsa87.keygen(xi);
    return {
      algorithm: PQConstants.ALG_ML_DSA_87,
      publicKey: kp.publicKey,
      privateKey: kp.secretKey,
    };
  }

  private generateSLHDSA(seed: Uint8Array): PQKeyPair {
    const expanded = sha256Drbg(seed, SLHDSA_SEED_BYTES);
    const kp = slh_dsa_sha2_256s.keygen(expanded);
    return {
      algorithm: PQConstants.ALG_SLH_DSA_SHA2_256S,
      publicKey: kp.publicKey,
      privateKey: kp.secretKey,
    };
  }
}
