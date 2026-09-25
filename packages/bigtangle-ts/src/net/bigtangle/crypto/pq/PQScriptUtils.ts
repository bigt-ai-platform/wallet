import { PQConstants } from './PQConstants';
import { KeyBundle } from './KeyBundle';
import { SignatureBundle } from './SignatureBundle';
import { Sha256Hash } from '../../core/Sha256Hash';
import { BcPQSignatureProvider } from './PQSignatureProvider';

export class PQScriptUtils {
  static readonly PQ_PUBKEY_PREFIX = 0x05;

  private static provider: BcPQSignatureProvider | null = null;
  private static readonly verifyCache: Map<string, boolean> = new Map<string, boolean>();
  private static readonly VERIFY_CACHE_MAX = 100_000;

  static setProvider(p: BcPQSignatureProvider): void {
    PQScriptUtils.provider = p;
  }

  static getProvider(): BcPQSignatureProvider {
    if (PQScriptUtils.provider == null) PQScriptUtils.provider = new BcPQSignatureProvider();
    return PQScriptUtils.provider;
  }

  static isPQPubkey(pubkey: Uint8Array | null): boolean {
    return (
      pubkey != null &&
      pubkey.length > 1 &&
      pubkey[0] === PQScriptUtils.PQ_PUBKEY_PREFIX
    );
  }

  static extractKeyBundle(prefixedPubkey: Uint8Array): KeyBundle {
    return KeyBundle.deserialize(prefixedPubkey.slice(1));
  }

  static prefixedPubkey(keyBundle: KeyBundle): Uint8Array {
    const bundleBytes = keyBundle.serialize();
    const result = new Uint8Array(1 + bundleBytes.length);
    result[0] = PQScriptUtils.PQ_PUBKEY_PREFIX;
    result.set(bundleBytes, 1);
    return result;
  }

  static domainSeparatedHash(base: Uint8Array, domain: string): Uint8Array;
  static domainSeparatedHash(base: Sha256Hash, domain: string): Uint8Array;
  static domainSeparatedHash(base: Uint8Array | Sha256Hash, domain: string): Uint8Array {
    const baseBytes = base instanceof Sha256Hash ? base.getBytes() : base;
    const domainBytes = new TextEncoder().encode(domain);
    const combined = new Uint8Array(domainBytes.length + baseBytes.length);
    combined.set(domainBytes, 0);
    combined.set(baseBytes, domainBytes.length);
    return Sha256Hash.hash(combined);
  }

  static slhDsaRequiredForTx(): boolean {
    return PQConstants.dualActivationHeightFromProperty() >= 0;
  }

  static verifyPQ(prefixedPubkey: Uint8Array, sigBytes: Uint8Array, baseSighash: Sha256Hash): boolean;
  static verifyPQ(prefixedPubkey: Uint8Array, sigBytes: Uint8Array, baseSighash: Sha256Hash, requireSlhDsa: boolean): boolean;
  static verifyPQ(prefixedPubkey: Uint8Array, sigBytes: Uint8Array, baseSighash: Sha256Hash, requireSlhDsa?: boolean): boolean {
    const require = requireSlhDsa === undefined ? PQScriptUtils.slhDsaRequiredForTx() : requireSlhDsa;

    const keyMaterial = new Uint8Array(
      1 + prefixedPubkey.length + sigBytes.length + baseSighash.getBytes().length
    );
    keyMaterial[0] = require ? 1 : 0;
    let off = 1;
    keyMaterial.set(prefixedPubkey, off);
    off += prefixedPubkey.length;
    keyMaterial.set(sigBytes, off);
    off += sigBytes.length;
    keyMaterial.set(baseSighash.getBytes(), off);
    const digestKey = Sha256Hash.of(keyMaterial).toString();

    const cached = PQScriptUtils.verifyCache.get(digestKey);
    if (cached !== undefined) return cached;
    const ok = PQScriptUtils.doVerifyPQ(prefixedPubkey, sigBytes, baseSighash, require);
    if (ok) {
      if (PQScriptUtils.verifyCache.size >= PQScriptUtils.VERIFY_CACHE_MAX)
        PQScriptUtils.verifyCache.delete(PQScriptUtils.verifyCache.keys().next().value as string);
      PQScriptUtils.verifyCache.set(digestKey, true);
    }
    return ok;
  }

  private static doVerifyPQ(
    prefixedPubkey: Uint8Array,
    sigBytes: Uint8Array,
    baseSighash: Sha256Hash,
    requireSlhDsa: boolean
  ): boolean {
    try {
      const keyBundle = PQScriptUtils.extractKeyBundle(prefixedPubkey);
      const sigBundle = SignatureBundle.deserialize(sigBytes);

      const p = PQScriptUtils.getProvider();

      const txHash = PQScriptUtils.domainSeparatedHash(baseSighash.getBytes(), PQConstants.TX_DOMAIN);

      const mlMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);
      const mlKey = keyBundle.getEntry(PQConstants.ALG_ML_DSA_87);
      const mlSig = sigBundle.getEntry(PQConstants.ALG_ML_DSA_87);
      if (mlKey == null || mlSig == null) return false;
      if (!p.verify(PQConstants.ALG_ML_DSA_87, mlKey.publicKey, mlMsg, mlSig.signature))
        return false;

      const slhKey = keyBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
      if (slhKey != null) {
        const slhSig = sigBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
        if (slhSig == null) {
          if (requireSlhDsa) return false;
        } else {
          const slhMsg = PQScriptUtils.domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);
          if (!p.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKey.publicKey, slhMsg, slhSig.signature))
            return false;
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }

  static verifyProposerSignature(
    keyBundle: KeyBundle,
    sigBundle: SignatureBundle,
    signingHash: Uint8Array
  ): boolean;
  static verifyProposerSignature(
    keyBundle: KeyBundle,
    sigBundle: SignatureBundle,
    signingHash: Uint8Array,
    requireSlhDsa: boolean
  ): boolean;
  static verifyProposerSignature(
    keyBundle: KeyBundle,
    sigBundle: SignatureBundle,
    signingHash: Uint8Array,
    requireSlhDsa?: boolean
  ): boolean {
    const require = requireSlhDsa === undefined ? true : requireSlhDsa;
    try {
      const p = PQScriptUtils.getProvider();

      const mlMsg = PQScriptUtils.domainSeparatedHash(signingHash, PQConstants.MLDSA_SIG_DOMAIN);
      const mlKey = keyBundle.getEntry(PQConstants.ALG_ML_DSA_87);
      const mlSig = sigBundle.getEntry(PQConstants.ALG_ML_DSA_87);
      if (mlKey == null || mlSig == null) return false;
      if (!p.verify(PQConstants.ALG_ML_DSA_87, mlKey.publicKey, mlMsg, mlSig.signature))
        return false;

      const slhMsg = PQScriptUtils.domainSeparatedHash(signingHash, PQConstants.SLHDSA_SIG_DOMAIN);
      const slhKey = keyBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
      const slhSig = sigBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
      if (require) {
        if (slhKey == null || slhSig == null) return false;
        if (!p.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKey.publicKey, slhMsg, slhSig.signature))
          return false;
      } else {
        if (slhKey != null && slhSig != null) {
          if (!p.verify(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKey.publicKey, slhMsg, slhSig.signature))
            return false;
        }
      }

      return true;
    } catch (e) {
      return false;
    }
  }
}
