import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';
import { slh_dsa_sha2_256s } from '@noble/post-quantum/slh-dsa.js';
import { sha256 } from '@noble/hashes/sha256';
import { PQConstants } from './PQConstants';
import { KeyBundle, KeyBundleEntry } from './KeyBundle';
import { SignatureBundle, SignatureBundleEntry } from './SignatureBundle';
import { PQAddress } from './PQAddress';
import { PQKeyDerivation } from './PQKeyDerivation';
import { Sha256Hash } from '../../core/Sha256Hash';
import { Utils } from '../../utils/Utils';
import { Address } from '../../core/Address';
import { NetworkParameters } from '../../params/NetworkParameters';
import { KeyCrypter, KeyParameter } from '../KeyCrypter';
import { EncryptedData } from '../EncryptedData';
import { EncryptionType, EncryptableItem } from '../EncryptableItem';

const MLDSA_SEED_BYTES = 32;
const SLHDSA_SEED_BYTES = 96;

export class PQKey implements EncryptableItem {
  protected mlDsaPrivateKey: Uint8Array;
  protected slhDsaPrivateKey: Uint8Array;
  protected keyBundle: KeyBundle;
  protected network: number;
  protected creationTimeSeconds: number;
  protected keyCrypter: KeyCrypter | null = null;
  protected encryptedPrivateKey: EncryptedData | null = null;

  protected constructor();
  protected constructor(
    mlDsaPrivateKey: Uint8Array,
    slhDsaPrivateKey: Uint8Array,
    keyBundle: KeyBundle,
    network: number,
  );
  protected constructor(...args: any[]) {
    if (args.length === 0) {
      this.mlDsaPrivateKey = new Uint8Array(0);
      this.slhDsaPrivateKey = new Uint8Array(0);
      this.keyBundle = null!;
      this.network = 0;
    } else {
      this.mlDsaPrivateKey = args[0];
      this.slhDsaPrivateKey = args[1];
      this.keyBundle = args[2];
      this.network = args[3];
    }
    this.creationTimeSeconds = Utils.currentTimeSeconds();
  }

  static createNew(network: number = PQConstants.NETWORK_TESTNET): PQKey {
    // Default: ML-DSA-87 only (FIPS 204), matching Java PQKey.createNew().
    // Dual (SLH-DSA) keys are created explicitly via fromSeeds().
    const mlDsaSeed = new Uint8Array(MLDSA_SEED_BYTES);
    crypto.getRandomValues(mlDsaSeed);
    return PQKey.fromMLDSA(mlDsaSeed, network);
  }

  /** ML-DSA-87 only key (FIPS 204). Matches Java PQKey.fromMLDSA(). */
  static fromMLDSA(mlDsaSeed: Uint8Array, network: number = PQConstants.NETWORK_TESTNET): PQKey {
    if (mlDsaSeed.length !== MLDSA_SEED_BYTES)
      throw new Error(`ML-DSA seed must be ${MLDSA_SEED_BYTES} bytes`);

    // Match Java BC DigestRandomGenerator(SHA256) behavior:
    // seed → SHA256-DRBG → ξ → FIPS 204 ML-DSA.KeyGen
    const xi = sha256Drbg(mlDsaSeed, MLDSA_SEED_BYTES);
    const mlKp = ml_dsa87.keygen(xi);

    const entries: KeyBundleEntry[] = [
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, mlKp.publicKey),
    ];
    const bundle = new KeyBundle(entries);

    return new PQKey(mlKp.secretKey, new Uint8Array(0), bundle, network);
  }

  static fromSeeds(
    mlDsaSeed: Uint8Array,
    slhDsaSeed: Uint8Array,
    network: number = PQConstants.NETWORK_TESTNET,
  ): PQKey {
    if (mlDsaSeed.length !== MLDSA_SEED_BYTES)
      throw new Error(`ML-DSA seed must be ${MLDSA_SEED_BYTES} bytes`);

    // Match Java BC DigestRandomGenerator(SHA256) behavior:
    // seed → SHA256-DRBG → ξ → FIPS 204 ML-DSA.KeyGen
    const xi = sha256Drbg(mlDsaSeed, MLDSA_SEED_BYTES);
    const mlKp = ml_dsa87.keygen(xi);

    // seed → SHA256-DRBG → 96-byte expanded seed → FIPS 205 SLH-DSA.KeyGen
    const slhSeed = sha256Drbg(slhDsaSeed, SLHDSA_SEED_BYTES);
    const slhKp = slh_dsa_sha2_256s.keygen(slhSeed);

    const entries: KeyBundleEntry[] = [
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, mlKp.publicKey),
      new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhKp.publicKey),
    ];
    const bundle = new KeyBundle(entries);

    return new PQKey(mlKp.secretKey, slhKp.secretKey, bundle, network);
  }

  static fromKeyMaterial(keyMaterial: Uint8Array, network: number = PQConstants.NETWORK_TESTNET): PQKey {
    // 32 bytes → ML-DSA-87 only; 64+ bytes → dual (ML + SLH-DSA), matching
    // Java PQKey.fromPrivateKeyHex (32-byte ML-only / 64-byte dual seed).
    if (keyMaterial.length === MLDSA_SEED_BYTES) {
      return PQKey.fromMLDSA(keyMaterial, network);
    }
    if (keyMaterial.length < MLDSA_SEED_BYTES * 2)
      throw new Error('keyMaterial must be 32 bytes (ML-DSA only) or 64 bytes (dual)');
    const mlDsaSeed = keyMaterial.slice(0, MLDSA_SEED_BYTES);
    const slhDsaSeed = keyMaterial.slice(MLDSA_SEED_BYTES, MLDSA_SEED_BYTES * 2);
    return PQKey.fromSeeds(mlDsaSeed, slhDsaSeed, network);
  }

  static fromPublicOnly(pubBytes: Uint8Array, network: number = PQConstants.NETWORK_TESTNET): PQKey {
    if (pubBytes.length < 2 || pubBytes[0] !== PQConstants.BUNDLE_VERSION)
      throw new Error('invalid PQ public key bytes');
    const bundle = KeyBundle.deserialize(pubBytes);
    return new PQKey(
      new Uint8Array(0),
      new Uint8Array(0),
      bundle,
      network,
    );
  }

  static fromPrefixedPublicKey(pubBytes: Uint8Array, network: number = PQConstants.NETWORK_TESTNET): PQKey {
    if (pubBytes.length < 2 || pubBytes[0] !== 0x05)
      throw new Error('invalid prefixed PQ public key bytes');
    return PQKey.fromPublicOnly(pubBytes.slice(1), network);
  }

  getKeyBundle(): KeyBundle {
    return this.keyBundle;
  }

  getPublicKeyBytes(): Uint8Array {
    return this.keyBundle.serialize();
  }

  getPrefixedPublicKeyBytes(): Uint8Array {
    const raw = this.keyBundle.serialize();
    const prefixed = new Uint8Array(1 + raw.length);
    prefixed[0] = 0x05;
    prefixed.set(raw, 1);
    return prefixed;
  }

  /** Alias for getPublicKeyBytes - matches ECKey API */
  getPubKey(): Uint8Array {
    return this.getPublicKeyBytes();
  }

  /** Alias for getPublicKeyBytes */
  getPubKeyBytes(): Uint8Array {
    return this.getPublicKeyBytes();
  }

  getPrivateKeyBytes(): Uint8Array {
    const mlLen = this.mlDsaPrivateKey.length;
    const slLen = this.slhDsaPrivateKey.length;
    const result = new Uint8Array(4 + mlLen + 4 + slLen);
    const dv = new DataView(result.buffer);
    dv.setUint32(0, mlLen, false);
    result.set(this.mlDsaPrivateKey, 4);
    dv.setUint32(4 + mlLen, slLen, false);
    result.set(this.slhDsaPrivateKey, 8 + mlLen);
    return result;
  }

  static fromPrivateKey(encoded: Uint8Array, network: number = PQConstants.NETWORK_TESTNET): PQKey {
    if (encoded.length < 8) throw new Error('invalid encoded private key');
    const dv = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);
    let offset = 0;
    const mlLen = dv.getUint32(offset, false);
    offset += 4;
    if (offset + mlLen > encoded.length) throw new Error('truncated ML-DSA private key');
    const mlPriv = encoded.slice(offset, offset + mlLen);
    offset += mlLen;
    const slLen = dv.getUint32(offset, false);
    offset += 4;
    const slPriv = offset + slLen <= encoded.length
      ? encoded.slice(offset, offset + slLen)
      : new Uint8Array(0);

    const mlPub = ml_dsa87.getPublicKey(mlPriv);
    const entries: KeyBundleEntry[] = [
      new KeyBundleEntry(PQConstants.ALG_ML_DSA_87, mlPub),
    ];
    if (slPriv.length > 0) {
      const slPub = slh_dsa_sha2_256s.getPublicKey(slPriv);
      entries.push(new KeyBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slPub));
    }
    const bundle = new KeyBundle(entries);

    return new PQKey(mlPriv, slPriv, bundle, network);
  }

  sign(data: Sha256Hash): SignatureBundle {
    const txHash = domainSeparatedHash(data.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);

    const mlSig = ml_dsa87.sign(mlMsg, this.mlDsaPrivateKey);

    // ML-DSA-87 is always included. SLH-DSA-SHA2-256s is only included when
    // this key holds an SLH-DSA private key (dual key), matching Java's
    // PQKey.sign(input, includeSlhDsa) behaviour.
    const entries: SignatureBundleEntry[] = [
      new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, mlSig),
    ];
    if (this.slhDsaPrivateKey.length > 0) {
      const slhMsg = domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);
      const slhSig = slh_dsa_sha2_256s.sign(slhMsg, this.slhDsaPrivateKey);
      entries.push(new SignatureBundleEntry(PQConstants.ALG_SLH_DSA_SHA2_256S, slhSig));
    }
    return new SignatureBundle(entries);
  }

  /** Sign with optional decryption if encrypted */
  async signWithAesKey(data: Sha256Hash, aesKey: KeyParameter | null): Promise<SignatureBundle> {
    if (this.isEncrypted()) {
      if (!aesKey) {
        throw new PQKey.MissingPrivateKeyException('Key is encrypted but no AES key provided');
      }
      const decrypted = await this.decrypt(aesKey);
      return decrypted.sign(data);
    }
    return this.sign(data);
  }

  isEncrypted(): boolean {
    return this.encryptedPrivateKey != null && this.encryptedPrivateKey.encryptedBytes.length > 0;
  }

  isWatching(): boolean {
    return !this.hasPrivateKey();
  }

  hasPrivateKey(): boolean {
    return this.mlDsaPrivateKey.length > 0;
  }

  async encrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<PQKey> {
    const secret = this.encodePrivateKeys();
    const enc = await keyCrypter.encrypt(secret, aesKey);
    const result = PQKey.fromPublicOnly(this.getPublicKeyBytes(), this.network);
    result.encryptedPrivateKey = enc;
    result.keyCrypter = keyCrypter;
    result.creationTimeSeconds = this.creationTimeSeconds;
    return result;
  }

  async decrypt(aesKey: KeyParameter): Promise<PQKey>;
  async decrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<PQKey>;
  async decrypt(keyCrypterOrKey: KeyCrypter | KeyParameter, aesKey?: KeyParameter): Promise<PQKey> {
    let crypter: KeyCrypter;
    let key: KeyParameter;
    if (aesKey !== undefined) {
      crypter = keyCrypterOrKey as KeyCrypter;
      key = aesKey;
    } else {
      if (!this.keyCrypter) throw new Error('Key is not encrypted or no key crypter available');
      crypter = this.keyCrypter;
      key = keyCrypterOrKey as KeyParameter;
    }
    if (!this.encryptedPrivateKey) throw new Error('Key is not encrypted');
    const decrypted = await crypter.decrypt(this.encryptedPrivateKey, key);
    const decoded = PQKey.decodePrivateKeys(decrypted);
    const result = PQKey.fromPrivateKey(decoded, this.network);
    result.creationTimeSeconds = this.creationTimeSeconds;
    return result;
  }

  toAddress(): PQAddress {
    // Matches Java PQKey.toAddress: the suite depends on whether the key
    // bundle holds an SLH-DSA entry (dual) or is ML-DSA-87 only.
    const suite = this.keyBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S) != null
      ? PQConstants.SUITE_CAT5_DUAL_1
      : PQConstants.SUITE_ML_DSA_ONLY;
    return PQAddress.fromKeyBundle(this.network, suite, this.keyBundle);
  }

  /** Convenience method matching ECKey's toAddress(params) pattern */
  toAddressWithParams(params: NetworkParameters): PQAddress {
    return this.toAddress();
  }

  toAddressHex(): string {
    return this.toAddress().toHex();
  }

  getPrivateKeyHex(): string {
    return Utils.HEX.encode(this.getPrivateKeyBytes());
  }

  getPublicKeyAsHex(): string {
    // Matches Java PQKey.getPublicKeyAsHex() which returns the prefixed
    // (0x05 + bundle) public key.
    return Utils.HEX.encode(this.getPrefixedPublicKeyBytes());
  }

  /** Returns RIPE160(SHA256(pubKey)) - matches ECKey.getPubKeyHash() */
  getPubKeyHash(): Uint8Array {
    return Utils.sha256hash160(this.getPrefixedPublicKeyBytes());
  }

  /** Format key information for display */
  formatKeyWithAddress(includePrivateKeys: boolean, builder: string[]): void {
    builder.push(`  addr:${this.toAddress().toHex()}`);
    builder.push(`  hash160:${Utils.HEX.encode(this.getPubKeyHash())}`);
    builder.push('\n');
  }

  getCreationTimeSeconds(): number { return this.creationTimeSeconds; }
  setCreationTimeSeconds(t: number): void { this.creationTimeSeconds = t; }

  getKeyCrypter(): KeyCrypter | null { return this.keyCrypter; }
  getEncryptedData(): EncryptedData | null { return this.encryptedPrivateKey; }
  getEncryptionType(): EncryptionType {
    return this.keyCrypter ? this.keyCrypter.getUnderstoodEncryptionType() : EncryptionType.UNENCRYPTED;
  }
  getSecretBytes(): Uint8Array | null {
    return this.hasPrivateKey() ? this.encodePrivateKeys() : null;
  }

  /** ECKey-compat: returns empty - PQKey doesn't support this */
  getPrivKeyBytes(): Uint8Array {
    return this.encodePrivateKeys();
  }

  protected encodePrivateKeys(): Uint8Array {
    const mlBytes = this.mlDsaPrivateKey;
    const slhBytes = this.slhDsaPrivateKey;
    const result = new Uint8Array(4 + mlBytes.length + 4 + slhBytes.length);
    const dv = new DataView(result.buffer);
    dv.setUint32(0, mlBytes.length, false);
    result.set(mlBytes, 4);
    dv.setUint32(4 + mlBytes.length, slhBytes.length, false);
    result.set(slhBytes, 8 + mlBytes.length);
    return result;
  }

  private static decodePrivateKeys(data: Uint8Array): Uint8Array {
    return data;
  }

  static readonly PUBKEY_COMPARATOR = (k1: PQKey, k2: PQKey): number => {
    const b1 = k1.getPublicKeyBytes();
    const b2 = k2.getPublicKeyBytes();
    const len = Math.min(b1.length, b2.length);
    for (let i = 0; i < len; i++) {
      const cmp = (b1[i] & 0xFF) - (b2[i] & 0xFF);
      if (cmp !== 0) return cmp;
    }
    return b1.length - b2.length;
  };

  static readonly AGE_COMPARATOR = (k1: PQKey, k2: PQKey): number => {
    return k1.creationTimeSeconds - k2.creationTimeSeconds;
  };

  static verify(data: Sha256Hash, sigBundle: SignatureBundle, pubBytes: Uint8Array): boolean {
    // Accept both prefixed (0x05 + bundle) and raw (bundle) public key bytes
    const bundleBytes = (pubBytes.length > 0 && pubBytes[0] === 0x05) ? pubBytes.slice(1) : pubBytes;
    const bundle = KeyBundle.deserialize(bundleBytes);
    return PQKey.verifyWithBundle(data, sigBundle, bundle);
  }

  static verifyWithBundle(data: Sha256Hash, sigBundle: SignatureBundle, keyBundle: KeyBundle): boolean {
    const txHash = domainSeparatedHash(data.getBytes(), PQConstants.TX_DOMAIN);
    const mlMsg = domainSeparatedHash(txHash, PQConstants.MLDSA_SIG_DOMAIN);

    // ML-DSA-87 is always required (matches Java PQScriptUtils.verifyPQ).
    const mlEntry = keyBundle.getEntry(PQConstants.ALG_ML_DSA_87);
    const mlSigEntry = sigBundle.getEntry(PQConstants.ALG_ML_DSA_87);
    if (!mlEntry || !mlSigEntry) return false;

    try {
      if (!ml_dsa87.verify(mlSigEntry.signature, mlMsg, mlEntry.publicKey)) return false;
      // SLH-DSA-SHA2-256s is required only if the key bundle holds an SLH-DSA
      // entry (dual key); absent for ML-DSA-87-only keys.
      const slhEntry = keyBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
      if (slhEntry) {
        const slhMsg = domainSeparatedHash(txHash, PQConstants.SLHDSA_SIG_DOMAIN);
        const slhSigEntry = sigBundle.getEntry(PQConstants.ALG_SLH_DSA_SHA2_256S);
        if (!slhSigEntry) return false;
        if (!slh_dsa_sha2_256s.verify(slhSigEntry.signature, slhMsg, slhEntry.publicKey)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  equals(other: PQKey): boolean {
    const b1 = this.getPublicKeyBytes();
    const b2 = other.getPublicKeyBytes();
    if (b1.length !== b2.length) return false;
    for (let i = 0; i < b1.length; i++) {
      if (b1[i] !== b2[i]) return false;
    }
    return true;
  }

  static createNewKey(compressed?: boolean): PQKey {
    return PQKey.createNew();
  }
}

export namespace PQKey {
  export class MissingPrivateKeyException extends Error {
    constructor(message?: string) {
      super(message ?? 'Private key missing');
      this.name = 'MissingPrivateKeyException';
    }
  }

  export class KeyIsEncryptedException extends MissingPrivateKeyException {
    constructor(message?: string) {
      super(message ?? 'Key is encrypted');
      this.name = 'KeyIsEncryptedException';
    }
  }
}

function domainSeparatedHash(data: Uint8Array, domain: string): Uint8Array {
  const domainBytes = new TextEncoder().encode(domain);
  const combined = new Uint8Array(domainBytes.length + data.length);
  combined.set(domainBytes);
  combined.set(data, domainBytes.length);
  return Sha256Hash.hash(combined);
}

function sha256Drbg(seed: Uint8Array, outputLen: number): Uint8Array {
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
