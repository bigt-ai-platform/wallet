
import * as secp256k1 from 'secp256k1';
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
;
import { ECDSASignature } from "../core/ECDSASignature";
import { TransactionSignature } from "../crypto/TransactionSignature";
import { SigHash } from "../core/SigHash";

// Define curve order constant
// secp256k1 curve order is hardcoded since secp256k1 library doesn't expose it directly
const CURVE_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const HALF_CURVE_ORDER = CURVE_N >> 1n;
import { ECPoint } from "./ECPoint";
import { NetworkParameters } from "../params/NetworkParameters";
import * as Address from "./Address";
import { KeyParameter, KeyCrypter } from "../crypto/KeyCrypter";
import { EncryptedData } from "../crypto/EncryptedData";
import { DumpedPrivateKey } from "./DumpedPrivateKey";
import { VarInt } from "./VarInt";
import { Utils } from "../utils/Utils";
// Export ECDSASignature from this module
export { ECDSASignature };

export class ECKey {
    // Add HALF_CURVE_ORDER as static property
    static readonly HALF_CURVE_ORDER = HALF_CURVE_ORDER;
    
  // Not using CURVE from secp256k1 library directly

  public static createNewKey(compressed: boolean = true): ECKey {

    // Using crypto to generate random bytes instead
    const randomBytes = new Uint8Array(32);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(randomBytes);
    } else {
      // Fallback for environments without crypto
      for (let i = 0; i < 32; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    const hex = Utils.HEX.encode(randomBytes);
    const privateKey = BigInt('0x' + hex);
    return ECKey.fromPrivate(privateKey, compressed);
  }

  // Helper to convert bigint to 32-byte Uint8Array
  public static bigIntToBytes(
    bi: bigint,
    length: number = 32
  ): Uint8Array {
    let hex: string;

    hex = bi.toString(16);

    // Pad with leading zeros if necessary to match the desired byte length
    // Each byte is 2 hex characters, so length * 2
    hex = hex.padStart(length * 2, "0");
    // Ensure we don't exceed the desired length
    if (hex.length > length * 2) {
      hex = hex.substring(hex.length - length * 2);
    }
    // Convert hex string to Uint8Array
    return Uint8Array.from(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  }

  // Helper to convert Buffer or Uint8Array to hex string
  private static bufferToHex(buf:   Uint8Array): string {
    return Utils.HEX.encode(buf);
  }

  public priv: bigint | null;
  public pub: ECPoint | null;
  private pubKeyHash: Uint8Array | null = null;
  public creationTimeSeconds: number = Math.floor(Date.now() / 1000);
  public encryptedPrivateKey: EncryptedData | null = null;
  public keyCrypter: KeyCrypter | null = null;

  constructor(
    priv: bigint | null,
    pub: ECPoint | null,
    compressed: boolean = true
  ) {
    this.priv = priv;
    this.pub = pub;
    if (pub) {
      pub.setCompressed(compressed);
    }
  }

  public static createBigInteger(signum: number, magnitude: Uint8Array): bigint {
    // Handle zero case
    if (signum === 0 || magnitude.length === 0) {
      return 0n;
    }

    // Convert magnitude bytes to BigInteger
    let result = 0n;
    for (const element of magnitude) {
      result = (result << 8n) + BigInt(element);
    }

    // Apply sign
    return signum < 0 ? -result : result;
  }

  public static fromPrivateByte(privKeyBytes: Uint8Array): ECKey {
  
    return ECKey.fromPrivate(ECKey. createBigInteger(1, privKeyBytes));
  }

  public static fromPrivate(
    privKey: bigint,
    compressed: boolean = true
  ): ECKey {
    const pubPoint = ECKey.publicPointFromPrivate(privKey);
    return new ECKey(privKey, pubPoint, compressed);
  }

  public static fromPrivateString(privKey: string): ECKey {
  
    return ECKey.fromPrivateByte(Utils.HEX.decode( privKey ));
  }

  public static fromPublic(
    pubKeyBytes: Uint8Array,
    compressed: boolean = true
  ): ECKey {
    const pubPoint = ECPoint.decodePoint(pubKeyBytes);
    return new ECKey(null, pubPoint, compressed);
  }

  public static fromPublicOnly(
    pubKeyBytes: Uint8Array,
    compressed: boolean = true
  ): ECKey {
    // This is the same as fromPublic, just a different name
    return ECKey.fromPublic(pubKeyBytes, compressed);
  }

  public static publicPointFromPrivate(privKey: bigint): ECPoint {
    // Ensure the private key is within valid range [1, N-1] where N is the curve order
    if (privKey < 1n || privKey >= CURVE_N) {
    //  console.log(`DEBUG: Private key validation - privKey: ${privKey.toString(16)}, N: ${CURVE_N.toString(16)}`);
    //  console.log(`DEBUG: Comparison - privKey < 1n: ${privKey < 1n}, privKey >= N: ${privKey >= CURVE_N}`);
      throw new Error(`invalid private key: out of range [1..N-1]`);
    }
    
    // Convert directly to Uint8Array
    const privKeyBytes = ECKey.bigIntToBytes(privKey, 32);
    const pubKey = secp256k1.publicKeyCreate(privKeyBytes);
    // Ensure pubKey is Uint8Array format to maintain consistency
    return ECPoint.decodePoint(new Uint8Array(pubKey));
  }

  public getPrivKeyBytes(): Uint8Array {
    if (!this.priv) {
      throw new Error("Private key is not available");
    }
    // Use the BigInteger directly
    return ECKey.bigIntToBytes(this.priv, 32);
  }

  public decompress(): ECKey {
    if (!this.pub) {
      throw new Error("Public key is not available");
    }
    const newPub = this.pub.decompress();
    return new ECKey(this.priv, newPub, false);
  }

  public isCompressed(): boolean {
    return this.pub?.isCompressed() ?? true;
  }

  public getPubKeyBytes(): Uint8Array {
    if (!this.pub) {
      throw new Error("Public key is not available");
    }
    return this.pub.encode(this.isCompressed());
  }

  /**
   * Gets the raw public key value. This appears in transaction scriptSigs.
   * Note: This is not the same as the pubKeyHash/address.
   */
  public getPubKey(): Uint8Array {
    return this.getPubKeyBytes();
  }

  /**
   * Gets the public key in the form of an elliptic curve point object.
   */
  public getPubKeyPoint(): ECPoint | null {
    return this.pub;
  }

  /**
   * Gets the private key as a BigInteger.
   * Throws if the private key is not available.
   */
  public getPrivKey(): bigint {
    if (!this.priv) {
      throw new Error("Private key is not available");
    }
    return this.priv;
  }

  public getPubKeyHash(): Uint8Array {
    this.pubKeyHash ??= ripemd160(sha256(this.getPubKeyBytes()));
    return this.pubKeyHash!;
  }

  public async sign(
    messageHash: Uint8Array |null,
    aesKey?: KeyParameter
  ): Promise<ECDSASignature> {
     if (messageHash== null) {
      throw new Error("Message hash cannot be null");
     }

    if (this.isEncrypted()) {
      if (!aesKey) {
        throw new Error("AES key is required for signing an encrypted key");
      }
      if (!this.keyCrypter || !this.encryptedPrivateKey) {
        throw new Error("KeyCrypter or encrypted private key missing");
      }
      const decryptedPrivKey = await this.keyCrypter.decrypt(
        this.encryptedPrivateKey,
        aesKey
      );
      const hex = ECKey.bufferToHex(decryptedPrivKey);
      // Convert directly to native bigint without intermediate BigInteger
      const nativePrivKey = BigInt("0x" + hex);
      return this.doSign(messageHash, nativePrivKey);
    } else {
      if (!this.priv) {
        throw new Error("Private key is not available for signing");
      }
      return this.doSign(messageHash, this.priv);
    }
  }

  public doSign(messageHash: Uint8Array, privKey: bigint): ECDSASignature {
    const privKeyBytes = ECKey.bigIntToBytes(privKey, 32);
    const sigObj = secp256k1.ecdsaSign(messageHash, privKeyBytes);
    // The secp256k1 library returns signature in compact format (64 bytes)
    // We need to parse r and s from it directly
    const rBytes = sigObj.signature.slice(0, 32);
    const sBytes = sigObj.signature.slice(32, 64);
    const r = ECKey.createBigInteger(1, rBytes);
    const s = ECKey.createBigInteger(1, sBytes);
    const signature = new ECDSASignature(r, s);
    
    // Check if the original signature is already canonical, if not we need to canonicalize
    return signature.toCanonicalised();
  }

    public verify(data: Uint8Array, signature: Uint8Array): boolean {
        if (!this.pub) {
            throw new Error("Public key is not available for verification");
        }
        // Use the same compression setting as was used for creating the public key
        return this.verifyWithPubKey(data, signature, this.pub.encode(this.isCompressed()));
    }

    public verifyWithPubKey(data: Uint8Array, signature: Uint8Array, pub: Uint8Array): boolean {
        try {
            // Convert to Buffer format which secp256k1 expects
            const dataBuffer = new Uint8Array(data);
            const pubBuffer = new Uint8Array(pub);
            
            // Check if this is a DER format signature (starts with 0x30)
            if (signature.length > 0 && signature[0] === 0x30) {
                // Instead of using ecdsaVerify directly with DER, decode the DER signature
                // and verify using the raw r, s values (secp256k1 library can handle this properly)
                try {
                    // Use ECDSASignature to decode the DER format
                    const decodedSig = ECDSASignature.decodeFromDER(signature);
                    
                    // Create a compact signature format (64 bytes: r + s)
                    const rBytes = ECKey.bigIntToBytes(decodedSig.r, 32);
                    const sBytes = ECKey.bigIntToBytes(decodedSig.s, 32);
                    const compactSig = new Uint8Array([...rBytes, ...sBytes]);
                    
                    // Verify using the compact format
                    const compactSigBuffer = new Uint8Array(compactSig);
                    return secp256k1.ecdsaVerify(compactSigBuffer, dataBuffer, pubBuffer);
                } catch (decodeError) {
                    // If DER decoding fails, try direct verification (for backwards compatibility)
                    const signatureBuffer = new Uint8Array(signature);
                    return secp256k1.ecdsaVerify(signatureBuffer, dataBuffer, pubBuffer);
                }
            } else {
                // This is likely a compact format signature
                const signatureBuffer = new Uint8Array(signature);
                return secp256k1.ecdsaVerify(signatureBuffer, dataBuffer, pubBuffer);
            }
        } catch (e) {
            // If verification fails, return false
            return false;
        }
    }

  public isPubKeyOnly(): boolean {
    return this.priv === null;
  }

  public isEncrypted(): boolean {
    return this.encryptedPrivateKey !== null;
  }

  public getCreationTimeSeconds(): number {
    return this.creationTimeSeconds;
  }

  public setCreationTimeSeconds(creationTimeSeconds: number): void {
    this.creationTimeSeconds = creationTimeSeconds;
  }

  public async encrypt(
    keyCrypter: KeyCrypter,
    aesKey: KeyParameter
  ): Promise<ECKey> {
    if (!this.priv) {
      throw new Error("Private key is not available for encryption");
    }
    const encryptedData = await keyCrypter.encrypt(
      this.getPrivKeyBytes(),
      aesKey
    );
    const encryptedKey = new ECKey(null, this.pub);
    encryptedKey.encryptedPrivateKey = encryptedData;
    encryptedKey.keyCrypter = keyCrypter;
    encryptedKey.creationTimeSeconds = this.creationTimeSeconds;
    return encryptedKey;
  }

  public async decrypt(
    keyCrypter: KeyCrypter,
    aesKey: KeyParameter
  ): Promise<ECKey> {
    if (!this.encryptedPrivateKey || !this.keyCrypter) {
      throw new Error("Key is not encrypted or keyCrypter is missing");
    }
    if (!this.keyCrypter.equals(keyCrypter)) {
      throw new Error("KeyCrypter mismatch");
    }
    const decryptedPrivKeyBytes = await keyCrypter.decrypt(
      this.encryptedPrivateKey,
      aesKey
    );
    const hex = ECKey.bufferToHex(decryptedPrivKeyBytes);
    // Convert directly to native bigint and then to BigInteger
    const nativePrivKey = BigInt("0x" + hex);
    const decryptedPrivKey = nativePrivKey;
    const decryptedKey = new ECKey(decryptedPrivKey, this.pub);
    decryptedKey.creationTimeSeconds = this.creationTimeSeconds;
    return decryptedKey;
  }

  public equals(other: any): boolean {
    if (this === other) return true;
    if (other === null || !(other instanceof ECKey)) return false;
    const o = other as ECKey;
    return (
      (this.priv === null ||
        o.priv === null ||
        this.priv.toString() === o.priv.toString()) &&
      (this.pub === null || o.pub === null || this.pub.equals(o.pub))
    );
  }

  public hashCode(): number {
    let result = 17;
    if (this.priv) {
      // Use the BigInteger's toString method directly
      const hex = this.priv.toString(16);
      for (let i = 0; i < hex.length; i++) {
        result = 31 * result + hex.charCodeAt(i);
      }
    }
    if (this.pub) {
      result = 31 * result + this.pub.hashCode();
    }
    return result;
  }

  public getPrivateKeyAsHex(): string {
    if (!this.priv) {
      throw new Error("Private key is not available");
    }
    return ECKey.bufferToHex(this.getPrivKeyBytes());
  }

  public getPublicKeyAsHex(): string {
    return ECKey.bufferToHex(this.getPubKeyBytes());
  }

  public toString(): string {
    return `ECKey{pub HEX=${this.getPublicKeyAsHex()}, isEncrypted=${this.isEncrypted()}, isPubKeyOnly=${this.isPubKeyOnly()}}`;
  }

  public toStringWithPrivate(params: NetworkParameters): string {
    let privHex = "";
    let privWIF = "";
    if (this.priv) {
      privHex = this.getPrivateKeyAsHex();
      try {
        const dumpedPrivKey = this.getPrivateKeyEncoded(params);
        privWIF = dumpedPrivKey.toString();
      } catch {
        privWIF = "N/A";
      }
    }
    return `ECKey{pub HEX=${this.getPublicKeyAsHex()}, priv HEX=${privHex}, priv WIF=${privWIF}, isEncrypted=${this.isEncrypted()}, isPubKeyOnly=${this.isPubKeyOnly()}}`;
  }

  public getPrivateKeyEncoded(params: NetworkParameters): DumpedPrivateKey {
    if (!this.priv) {
      throw new Error("Private key is not available");
    }
    const privBytes = this.getPrivKeyBytes();
    const compressed = this.isCompressed();
    return DumpedPrivateKey.encodePrivateKey(params, privBytes, compressed);
  }

  public async signMessage(message: string): Promise<Uint8Array> {
    // Sign a message following Bitcoin's message signing standard
    const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
    const messageBuffer = new TextEncoder().encode(message);

    // Create a buffer to write the VarInt
    const varInt = new VarInt(messageBuffer.length);
    const varIntBuffer = varInt.encode();

    const bufferLength = prefix.length + varIntBuffer.length + messageBuffer.length;
    const buffer = new Uint8Array(bufferLength);
    buffer.set(prefix, 0);
    buffer.set(varIntBuffer, prefix.length);
    buffer.set(messageBuffer, prefix.length + varIntBuffer.length);
    const hash = sha256(sha256(buffer));
    const signature = await this.sign(Uint8Array.from(hash));
    return signature.encodeToDER();
  }

  public static signedMessageToKey(
    message: string,
    signatureBase64: string
  ): ECKey {
    // Implementation of message recovery
    const prefix = new TextEncoder().encode("\x18Bitcoin Signed Message:\n");
    const messageBuffer = new TextEncoder().encode(message);

    // Create a buffer to write the VarInt
    const varInt = new VarInt(messageBuffer.length);
    const varIntBuffer = varInt.encode();

    const bufferLength = prefix.length + varIntBuffer.length + messageBuffer.length;
    const buffer = new Uint8Array(bufferLength);
    buffer.set(prefix, 0);
    buffer.set(varIntBuffer, prefix.length);
    buffer.set(messageBuffer, prefix.length + varIntBuffer.length);
    const messageHash = sha256(sha256(buffer));

    const signatureBuffer = new Uint8Array(atob(signatureBase64).split('').map(c => c.charCodeAt(0)));
    if (signatureBuffer.length !== 65) {
      throw new Error("Invalid signature length");
    }

    const headerByte = signatureBuffer[0];
    const recoveryId = (headerByte - 27) & 0x03; // Ensure recoveryId is 0-3
    const r = BigInt("0x" + Array.from(signatureBuffer.slice(1, 33)).map(b => b.toString(16).padStart(2, '0')).join(''));
    const s = BigInt("0x" + Array.from(signatureBuffer.slice(33, 65)).map(b => b.toString(16).padStart(2, '0')).join(''));

    // Create a signature object
    new ECDSASignature(r, s);

    // Recover public key using secp256k1 library
    const publicKey = secp256k1.ecdsaRecover(signatureBuffer.slice(1, 65), recoveryId, messageHash, false);
    const publicKeyBytes = publicKey;

    return ECKey.fromPublic(publicKeyBytes);
  }

  /**
   * Signs a transaction input with the given private key and returns a TransactionSignature.
   * This method creates a signature compatible with Bitcoin transaction format.
   *
   * @param hash The precalculated hash of the transaction to sign
   * @param aesKey Optional AES key for encrypted private keys
   * @param sigHashType The signature hash type (ALL, NONE, SINGLE)
   * @param anyoneCanPay Whether the signature allows other inputs to be added (ANYONECANPAY)
   * @returns A TransactionSignature object that can be used in transaction input scripts
   */
  public async signTransactionInput(
    hash: Uint8Array,
    aesKey?: KeyParameter,
    sigHashType: SigHash = SigHash.ALL,
    anyoneCanPay: boolean = false
  ): Promise<TransactionSignature> {
    const signature = await this.sign(hash, aesKey);
    return new TransactionSignature(signature, sigHashType, anyoneCanPay);
  }

  public toAddress(params: NetworkParameters): Address.Address {
    const version = params.getAddressHeader();
    return new Address.Address(
      params,
      version,
      new Uint8Array(this.getPubKeyHash())
    );
  }

  public static async encryptionIsReversible(
    originalKey: ECKey,
    encryptedKey: ECKey,
    keyCrypter: KeyCrypter,
    aesKey: KeyParameter
  ): Promise<boolean> {
    try {
      const decryptedKey = await encryptedKey.decrypt(keyCrypter, aesKey);
      return originalKey.equals(decryptedKey);
    } catch {
      // Exception intentionally caught for reversibility check; do not rethrow.
      return false;
    }
  }

  // Helper to convert native BigInt to big-integer BigInteger

  public isWatching(): boolean {
    // Placeholder for isWatching logic
    return this.isPubKeyOnly();
  }
}
