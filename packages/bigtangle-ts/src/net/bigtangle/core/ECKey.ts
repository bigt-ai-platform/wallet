import * as secp256k1 from 'secp256k1';
import { ECPoint } from './ECPoint';
import { ECDSASignature } from './ECDSASignature';
import { TransactionSignature } from '../crypto/TransactionSignature';
import { Address } from './Address';
import { Sha256Hash } from './Sha256Hash';
import { NetworkParameters } from '../params/NetworkParameters';
import { KeyCrypter, KeyParameter, KeyCrypterException } from '../crypto/KeyCrypter';
import { EncryptedData } from '../crypto/EncryptedData';
import { EncryptionType, EncryptableItem } from '../crypto/EncryptableItem';
import { DumpedPrivateKey } from './DumpedPrivateKey';
import { Utils } from '../utils/Utils';

/**
 * The type of key material backing a {@link Key}. EC keys are legacy
 * ECDSA/secp256k1; PQ keys are post-quantum (ML-DSA-87 / SLH-DSA).
 */
export enum KeyType {
    EC = 'EC',
    PQ = 'PQ',
}

/**
 * The order of the secp256k1 curve.
 */
const CURVE_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

/**
 * Represents a legacy elliptic curve (secp256k1/ECDSA) public and (optionally) private key.
 * Re-introduced alongside {@link PQKey} so legacy addresses can be spent (migrating funds to PQ).
 * This is the TypeScript port of {@link net.bigtangle.core.ECKey}.
 */
export class ECKey implements EncryptableItem {
    /** Sorts oldest keys first, newest last. */
    public static readonly AGE_COMPARATOR = (k1: ECKey, k2: ECKey): number => {
        return k1.creationTimeSeconds - k2.creationTimeSeconds;
    };

    /** Compares pub key bytes lexicographically. */
    public static readonly PUBKEY_COMPARATOR = (k1: ECKey, k2: ECKey): number => {
        const b1 = k1.getPubKey();
        const b2 = k2.getPubKey();
        const len = Math.min(b1.length, b2.length);
        for (let i = 0; i < len; i++) {
            const cmp = (b1[i] & 0xFF) - (b2[i] & 0xFF);
            if (cmp !== 0) return cmp;
        }
        return b1.length - b2.length;
    };

    /** The half order of the secp256k1 curve, used for canonicalising the S value. */
    public static readonly HALF_CURVE_ORDER = CURVE_N >> 1n;

    // The two parts of the key. If "priv" is set, "pub" can always be calculated.
    protected priv: bigint | null;
    protected pub: ECPoint | null;
    protected creationTimeSeconds: number;
    protected keyCrypter: KeyCrypter | null;
    protected encryptedPrivateKey: EncryptedData | null;
    private pubKeyHash: Uint8Array | null = null;

    /**
     * Generates an entirely new keypair (compressed public key) when called with no
     * arguments; otherwise builds a key from the given private value and public point.
     */
    constructor();
    constructor(priv: bigint | null, pub: ECPoint | null, compressed?: boolean);
    constructor(...args: any[]) {
        this.creationTimeSeconds = Utils.currentTimeSeconds();
        this.keyCrypter = null;
        this.encryptedPrivateKey = null;
        if (args.length === 0) {
            const randomBytes = new Uint8Array(32);
            if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
                crypto.getRandomValues(randomBytes);
            } else {
                for (let i = 0; i < 32; i++) {
                    randomBytes[i] = Math.floor(Math.random() * 256);
                }
            }
            const privKey = ECKey.bytesToBigInteger(randomBytes) % (CURVE_N - 1n);
            this.priv = privKey + 1n;
            this.pub = ECKey.publicPointFromPrivate(this.priv);
        } else {
            const [priv, pub, compressed = true] = args as [bigint | null, ECPoint | null, boolean];
            if (priv !== null && (priv === 0n || priv === 1n)) {
                throw new Error('Private key must not be 0 or 1');
            }
            this.priv = priv;
            this.pub = pub;
            if (pub) {
                pub.setCompressed(compressed);
            }
        }
    }

    public getKeyType(): KeyType {
        return KeyType.EC;
    }

    /** Generates an entirely new keypair (compressed public key). */
    public static createNew(): ECKey {
        return new ECKey();
    }

    /** Legacy alias for {@link #createNew()}. */
    public static createNewKey(compressed: boolean = true): ECKey {
        const key = new ECKey();
        if (!compressed) {
            return key.decompress();
        }
        return key;
    }

    /** Converts a private key (as 32-byte big-endian bytes) to an ECKey. */
    public static fromPrivateByte(privKeyBytes: Uint8Array): ECKey {
        return ECKey.fromPrivate(ECKey.bytesToBigInteger(privKeyBytes), true);
    }

    /** Converts a private key (as hex string) to an ECKey. */
    public static fromPrivateString(privKey: string): ECKey {
        return ECKey.fromPrivateByte(Utils.HEX.decode(privKey));
    }

    /** Converts a private key to an ECKey, deriving the public point. */
    public static fromPrivate(privKey: bigint, compressed?: boolean): ECKey;
    public static fromPrivate(privKeyBytes: Uint8Array, compressed?: boolean): ECKey;
    public static fromPrivate(privKey: bigint | Uint8Array, compressed: boolean = true): ECKey {
        let priv: bigint;
        if (typeof privKey === 'bigint') {
            priv = privKey;
        } else {
            if (privKey.length === 0) throw new Error('Private key bytes are empty');
            priv = ECKey.bytesToBigInteger(privKey);
        }
        const pubPoint = ECKey.publicPointFromPrivate(priv);
        return new ECKey(priv, pubPoint, compressed);
    }

    /** Creates a key from the given private value and a precalculated public point. */
    public static fromPrivateAndPrecalculatedPublic(priv: bigint, pub: ECPoint): ECKey;
    public static fromPrivateAndPrecalculatedPublic(priv: Uint8Array, pub: Uint8Array): ECKey;
    public static fromPrivateAndPrecalculatedPublic(priv: bigint | Uint8Array, pub: ECPoint | Uint8Array): ECKey {
        if (typeof priv === 'bigint') {
            return new ECKey(priv, pub as ECPoint);
        }
        if (priv.length === 0) throw new Error('Private key bytes are empty');
        const pubPoint = pub instanceof ECPoint ? pub : ECPoint.decodePoint(pub);
        return new ECKey(ECKey.bytesToBigInteger(priv), pubPoint);
    }

    /** Creates a public-only key from an elliptic curve point. */
    public static fromPublicOnly(pub: ECPoint): ECKey;
    public static fromPublicOnly(pubKeyBytes: Uint8Array, compressed?: boolean): ECKey;
    public static fromPublicOnly(pubKeyBytesOrPoint: ECPoint | Uint8Array, compressed: boolean = true): ECKey {
        if (pubKeyBytesOrPoint instanceof ECPoint) {
            return new ECKey(null, pubKeyBytesOrPoint, pubKeyBytesOrPoint.isCompressed());
        }
        const pubPoint = ECPoint.decodePoint(pubKeyBytesOrPoint);
        return new ECKey(null, pubPoint, compressed);
    }

    /** Legacy alias for {@link #fromPublicOnly(Uint8Array, boolean)}. */
    public static fromPublic(pubKeyBytes: Uint8Array, compressed: boolean = true): ECKey {
        return ECKey.fromPublicOnly(pubKeyBytes, compressed);
    }

    /** Creates a public-only key carrying an encrypted private key. */
    public static fromEncrypted(encryptedPrivateKey: EncryptedData, keyCrypter: KeyCrypter, pubKey: Uint8Array): ECKey {
        const key = ECKey.fromPublicOnly(pubKey);
        key.encryptedPrivateKey = encryptedPrivateKey;
        key.keyCrypter = keyCrypter;
        return key;
    }

    /** Derives the public point for the given private key. */
    public static publicPointFromPrivate(privKey: bigint): ECPoint {
        if (privKey < 1n || privKey >= CURVE_N) {
            throw new Error('invalid private key: out of range [1..N-1]');
        }
        const privKeyBytes = ECKey.bigIntToBytes(privKey, 32);
        const pubKey = secp256k1.publicKeyCreate(privKeyBytes, true);
        return ECPoint.decodePoint(new Uint8Array(pubKey));
    }

    /** Returns the compressed public key bytes derived from the given private key. */
    public static publicKeyFromPrivate(privKey: bigint, compressed: boolean): Uint8Array {
        return ECKey.publicPointFromPrivate(privKey).encode(compressed);
    }

    /** Imports a private key from its WIF (base58) representation. */
    public static fromWIF(params: NetworkParameters, wif: string): ECKey {
        return DumpedPrivateKey.fromBase58(params, wif).getKey();
    }

    /** Converts a bigint to a fixed-size big-endian byte array. */
    public static bigIntToBytes(bi: bigint, length: number = 32): Uint8Array {
        let hex = bi.toString(16);
        hex = hex.padStart(length * 2, '0');
        if (hex.length > length * 2) {
            hex = hex.substring(hex.length - length * 2);
        }
        return Uint8Array.from(hex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));
    }

    /** Converts an unsigned big-endian byte array to a bigint. */
    public static bytesToBigInteger(bytes: Uint8Array): bigint {
        let result = 0n;
        for (let i = 0; i < bytes.length; i++) {
            result = (result << 8n) + BigInt(bytes[i] & 0xFF);
        }
        return result;
    }

    /** True if the given pubkey bytes have canonical SEC1 encoding. */
    public static isPubKeyCanonical(pubkey: Uint8Array): boolean {
        if (pubkey.length < 33) return false;
        if (pubkey[0] === 0x04) {
            return pubkey.length === 65;
        } else if (pubkey[0] === 0x02 || pubkey[0] === 0x03) {
            return pubkey.length === 33;
        }
        return false;
    }

    /** Verifies the given ECDSA signature against the message hash using the public key bytes. */
    public static verify(data: Uint8Array, signature: TransactionSignature, pub: Uint8Array): boolean;
    /** Verifies the given bitcoin-encoded (DER + sighash byte) ECDSA signature against a hash. */
    public static verify(data: Uint8Array, signature: Uint8Array, pub: Uint8Array): boolean;
    public static verify(data: Uint8Array, signature: TransactionSignature | Uint8Array, pub: Uint8Array): boolean {
        try {
            let r: bigint;
            let s: bigint;
            if (signature instanceof TransactionSignature) {
                r = signature.r;
                s = signature.s;
            } else {
                const sig = TransactionSignature.decodeFromBitcoin(signature, false, false);
                r = sig.r;
                s = sig.s;
            }
            return secp256k1.ecdsaVerify(ECKey.compactSignature(r, s), data, pub);
        } catch {
            return false;
        }
    }

    public getPubKeyHash(): Uint8Array {
        if (this.pubKeyHash === null) {
            this.pubKeyHash = Utils.sha256hash160(this.getPubKeyBytes());
        }
        return this.pubKeyHash;
    }

    public getPubKey(): Uint8Array {
        return this.getPubKeyBytes();
    }

    public getPubKeyBytes(): Uint8Array {
        return this.getPublicKeyBytes();
    }

    public getPublicKeyBytes(): Uint8Array {
        if (!this.pub) {
            throw new Error('Public key is not available');
        }
        return this.pub.encode(this.isCompressed());
    }

    public getPublicKeyAsHex(): string {
        return Utils.HEX.encode(this.getPubKeyBytes());
    }

    public getPubKeyPoint(): ECPoint | null {
        return this.pub;
    }

    public getPrivKey(): bigint {
        if (this.priv === null) {
            throw new ECKey.MissingPrivateKeyException();
        }
        return this.priv;
    }

    public getPrivKeyBytes(): Uint8Array {
        return ECKey.bigIntToBytes(this.getPrivKey(), 32);
    }

    public getPrivateKeyAsHex(): string {
        return Utils.HEX.encode(this.getPrivKeyBytes());
    }

    public isCompressed(): boolean {
        return this.pub?.isCompressed() ?? true;
    }

    /** Returns a copy of this key, but with the public point in uncompressed form. */
    public decompress(): ECKey {
        if (!this.pub || !this.isCompressed()) return this;
        const newPub = this.pub.decompress();
        return new ECKey(this.priv, newPub, false);
    }

    public isPubKeyOnly(): boolean {
        return this.priv === null;
    }

    public hasPrivKey(): boolean {
        return this.priv !== null;
    }

    public hasPrivateKey(): boolean {
        return this.hasPrivKey();
    }

    public isWatching(): boolean {
        return this.isPubKeyOnly() && !this.isEncrypted();
    }

    /** Signs the given hash and returns a canonicalised TransactionSignature (SIGHASH_ALL). */
    public sign(data: Sha256Hash): TransactionSignature {
        if (this.isEncrypted()) {
            throw new ECKey.KeyIsEncryptedException();
        }
        if (this.priv === null) {
            throw new ECKey.MissingPrivateKeyException();
        }
        return this.doSign(data, this.priv);
    }

    /** Sign with optional decryption if the key is encrypted. */
    public async signWithAesKey(data: Sha256Hash, aesKey: KeyParameter | null): Promise<TransactionSignature> {
        if (this.isEncrypted()) {
            if (!aesKey) {
                throw new ECKey.MissingPrivateKeyException('Key is encrypted but no AES key provided');
            }
            const decrypted = await this.decrypt(aesKey);
            return decrypted.sign(data);
        }
        return this.sign(data);
    }

    /** Low-level signing: RFC6979 deterministic ECDSA over secp256k1, then canonicalised. */
    protected doSign(data: Sha256Hash, privateKeyForSigning: bigint): TransactionSignature {
        const privBytes = ECKey.bigIntToBytes(privateKeyForSigning, 32);
        const sigObj = secp256k1.ecdsaSign(data.getBytes(), privBytes);
        const r = ECKey.bytesToBigInteger(sigObj.signature.subarray(0, 32));
        const s = ECKey.bytesToBigInteger(sigObj.signature.subarray(32, 64));
        return new TransactionSignature(r, s).toCanonicalised();
    }

    public verify(hash: Uint8Array, signature: Uint8Array): boolean;
    public verify(sigHash: Sha256Hash, signature: TransactionSignature): boolean;
    public verify(hashOrSigHash: Uint8Array | Sha256Hash, signature: Uint8Array | TransactionSignature): boolean {
        const data = hashOrSigHash instanceof Sha256Hash ? hashOrSigHash.getBytes() : hashOrSigHash;
        const pub = this.getPubKey();
        if (signature instanceof TransactionSignature) {
            return ECKey.verify(data, signature, pub);
        }
        return ECKey.verify(data, signature, pub);
    }

    /** Returns the legacy base58 address (hash160) corresponding to the public part of this key. */
    public toAddress(params: NetworkParameters): Address {
        return Address.fromP2PKH(params, new Uint8Array(this.getPubKeyHash()));
    }

    /** Alias for {@link #toAddress(NetworkParameters)}, matching the PQKey API. */
    public toAddressWithParams(params: NetworkParameters): Address {
        return this.toAddress(params);
    }

    public toAddressString(params: NetworkParameters): string {
        return this.toAddress(params).toBase58();
    }

    public async encrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<ECKey> {
        if (this.priv === null) {
            throw new ECKey.MissingPrivateKeyException('Private key is not available for encryption');
        }
        const encryptedPrivateKey = await keyCrypter.encrypt(this.getPrivKeyBytes(), aesKey);
        const result = ECKey.fromPublicOnly(this.getPubKey(), this.isCompressed());
        result.encryptedPrivateKey = encryptedPrivateKey;
        result.keyCrypter = keyCrypter;
        result.creationTimeSeconds = this.creationTimeSeconds;
        return result;
    }

    public async decrypt(aesKey: KeyParameter): Promise<ECKey>;
    public async decrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<ECKey>;
    public async decrypt(keyCrypterOrKey: KeyCrypter | KeyParameter, aesKey?: KeyParameter): Promise<ECKey> {
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
        if (this.keyCrypter && !this.keyCrypter.equals(crypter)) {
            throw new KeyCrypterException('The keyCrypter being used to decrypt the key is different to the one that was used to encrypt it');
        }
        const decrypted = await crypter.decrypt(this.encryptedPrivateKey, key);
        const result = ECKey.fromPrivate(decrypted, this.isCompressed());
        if (!Utils.arraysEqual(result.getPubKey(), this.getPubKey())) {
            throw new KeyCrypterException('Provided AES key is wrong');
        }
        result.creationTimeSeconds = this.creationTimeSeconds;
        return result;
    }

    /** Decrypts the key if it is encrypted and an AES key is supplied; otherwise returns this. */
    public async maybeDecrypt(aesKey: KeyParameter | null): Promise<ECKey> {
        return this.isEncrypted() && aesKey != null ? this.decrypt(aesKey) : this;
    }

    public isEncrypted(): boolean {
        return this.keyCrypter !== null && this.encryptedPrivateKey !== null && this.encryptedPrivateKey.encryptedBytes.length > 0;
    }

    public getEncryptionType(): EncryptionType {
        return this.keyCrypter !== null ? this.keyCrypter.getUnderstoodEncryptionType() : EncryptionType.UNENCRYPTED;
    }

    public getEncryptedData(): EncryptedData | null {
        return this.encryptedPrivateKey;
    }

    public getEncryptedPrivateKey(): EncryptedData | null {
        return this.encryptedPrivateKey;
    }

    public getKeyCrypter(): KeyCrypter | null {
        return this.keyCrypter;
    }

    public getSecretBytes(): Uint8Array | null {
        return this.hasPrivKey() ? this.getPrivKeyBytes() : null;
    }

    public getCreationTimeSeconds(): number {
        return this.creationTimeSeconds;
    }

    public setCreationTimeSeconds(newCreationTimeSeconds: number): void {
        if (newCreationTimeSeconds < 0) {
            throw new Error('Cannot set creation time to negative value: ' + newCreationTimeSeconds);
        }
        this.creationTimeSeconds = newCreationTimeSeconds;
    }

    /** Exports the private key in WIF (Wallet Import Format, base58). */
    public getPrivateKeyEncoded(params: NetworkParameters): DumpedPrivateKey {
        return DumpedPrivateKey.encodePrivateKey(params, this.getPrivKeyBytes(), this.isCompressed());
    }

    public getPrivateKeyAsWiF(params: NetworkParameters): string {
        return this.getPrivateKeyEncoded(params).toString();
    }

    public equals(other: any): boolean {
        if (this === other) return true;
        if (other === null || !(other instanceof ECKey)) return false;
        return this.priv === other.priv
            && (this.pub === null || other.pub === null || this.pub.equals(other.pub))
            && this.creationTimeSeconds === other.creationTimeSeconds
            && this.keyCrypter === other.keyCrypter
            && ((this.encryptedPrivateKey === null && other.encryptedPrivateKey === null)
                || (this.encryptedPrivateKey !== null && other.encryptedPrivateKey !== null && this.encryptedPrivateKey.equals(other.encryptedPrivateKey)));
    }

    public hashCode(): number {
        const bits = this.getPubKey();
        return ((bits[0] & 0xFF) << 24) | ((bits[1] & 0xFF) << 16) | ((bits[2] & 0xFF) << 8) | (bits[3] & 0xFF);
    }

    public toString(): string {
        return `ECKey{pub=${this.getPublicKeyAsHex().substring(0, 16)}... hasPriv=${this.hasPrivKey()}}`;
    }

    public formatKeyWithAddress(includePrivateKeys: boolean, builder: string[], params?: NetworkParameters): void {
        const address = params ? this.toAddress(params) : null;
        if (address) {
            builder.push(`  addr:${address.toString()}`);
        }
        builder.push(`  hash160:${Utils.HEX.encode(this.getPubKeyHash())}`);
        if (this.creationTimeSeconds > 0) {
            builder.push(`  creationTimeSeconds:${this.creationTimeSeconds}`);
        }
        builder.push('\n');
        if (includePrivateKeys) {
            builder.push(`  priv HEX:${this.getPrivateKeyAsHex()}`);
            builder.push('\n');
        }
    }

    private static compactSignature(r: bigint, s: bigint): Uint8Array {
        const compact = new Uint8Array(64);
        compact.set(ECKey.bigIntToBytes(r, 32), 0);
        compact.set(ECKey.bigIntToBytes(s, 32), 32);
        return compact;
    }
}

export namespace ECKey {
    export class MissingPrivateKeyException extends Error {
        constructor(message?: string) {
            super(message ?? 'Private key is missing');
            this.name = 'MissingPrivateKeyException';
            Object.setPrototypeOf(this, MissingPrivateKeyException.prototype);
        }
    }

    export class KeyIsEncryptedException extends MissingPrivateKeyException {
        constructor(message?: string) {
            super(message ?? 'Key is encrypted');
            this.name = 'KeyIsEncryptedException';
            Object.setPrototypeOf(this, KeyIsEncryptedException.prototype);
        }
    }
}

export { ECDSASignature };