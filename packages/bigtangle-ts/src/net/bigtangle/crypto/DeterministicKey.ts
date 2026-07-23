import { PQKey } from './pq/PQKey';
import { ChildNumber } from './ChildNumber';
import { ECPoint } from '../core/ECPoint';
import { Sha256Hash } from '../core/Sha256Hash';
import { HDKeyDerivation } from './HDKeyDerivation';
import { NetworkParameters } from '../params/NetworkParameters';
import { Utils } from '../utils/Utils';
import { Base58 } from '../utils/Base58';
import { HDUtils } from './HDUtils';
import { MissingPrivateKeyException } from './MissingPrivateKeyException';
import { KeyCrypter, KeyParameter } from './KeyCrypter';
import { EncryptedData } from './EncryptedData';
import { SignatureBundle, SignatureBundleEntry } from './pq/SignatureBundle';
import { PQConstants } from './pq/PQConstants';

export class DeterministicKey extends PQKey {
    public static readonly CHILDNUM_ORDER = (k1: PQKey, k2: PQKey) => {
        const cn1 = (k1 as unknown as DeterministicKey).getChildNumber();
        const cn2 = (k2 as unknown as DeterministicKey).getChildNumber();
        return cn1.compareTo(cn2);
    };

    private readonly parent: DeterministicKey | null;
    private readonly childNumberPath: ChildNumber[];
    private readonly depth: number;
    private parentFingerprint: number;
    private readonly chainCode: Uint8Array;
    private readonly _priv: bigint | null;
    private readonly _pub: ECPoint | null;

    private static bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    private static bigIntegerToBytes(bi: bigint, length: number = 32): Uint8Array {
        const bytes = new Uint8Array(length);
        let value = bi;
        for (let i = length - 1; i >= 0 && value > 0n; i--) {
            bytes[i] = Number(value & 0xFFn);
            value = value >> 8n;
        }
        return bytes;
    }

    constructor(
        childNumberPath: ChildNumber[],
        chainCode: Uint8Array,
        publicAsPoint: ECPoint | null,
        priv: bigint | null,
        parent: DeterministicKey | null,
        depth?: number,
        parentFingerprint?: number,
        keyCrypter?: KeyCrypter,
        encryptedPrivateKey?: EncryptedData
    ) {
        super();
        if (chainCode.length !== 32) throw new Error('Chain code must be 32 bytes');
        this.parent = parent;
        this.childNumberPath = [...childNumberPath];
        this.chainCode = new Uint8Array(chainCode);
        this.depth = depth ?? (parent ? parent.depth + 1 : 0);
        this.parentFingerprint = parentFingerprint ?? (parent ? parent.getFingerprint() : 0);
        this._priv = priv;
        this._pub = priv !== null ? ECPoint.fromPrivate(priv) : publicAsPoint;
        if (keyCrypter && encryptedPrivateKey) {
            this.keyCrypter = keyCrypter;
            this.encryptedPrivateKey = encryptedPrivateKey;
        }
    }

    get priv(): bigint | null { return this._priv; }

    get pub(): ECPoint | null { return this._pub; }

    public static fromOtherKey(keyToClone: DeterministicKey, newParent: DeterministicKey): DeterministicKey {
        const newKey = new DeterministicKey(
            keyToClone.childNumberPath,
            keyToClone.chainCode,
            keyToClone._pub,
            keyToClone._priv,
            newParent,
            keyToClone.childNumberPath.length,
            newParent.getFingerprint(),
            keyToClone.keyCrypter || undefined,
            keyToClone.encryptedPrivateKey || undefined
        );
        newKey.setCreationTimeSeconds(keyToClone.getCreationTimeSeconds());
        return newKey;
    }

    public getPath(): ChildNumber[] {
        return [...this.childNumberPath];
    }

    public getPathAsString(): string {
        return HDUtils.formatPath(this.getPath());
    }

    public getDepth(): number {
        return this.depth;
    }

    public getChildNumber(): ChildNumber {
        return this.childNumberPath.length === 0 ?
            ChildNumber.ZERO :
            this.childNumberPath[this.childNumberPath.length - 1];
    }

    public getChainCode(): Uint8Array {
        return new Uint8Array(this.chainCode);
    }

    public getIdentifier(): Uint8Array {
        return Utils.sha256hash160(this.getPubKeyBytes());
    }

    public getFingerprint(): number {
        const identifier = this.getIdentifier();
        return new DataView(identifier.buffer, identifier.byteOffset, identifier.byteLength).getUint32(0, false);
    }

    public getParent(): DeterministicKey | null {
        return this.parent;
    }

    public getParentFingerprint(): number {
        return this.parentFingerprint;
    }

    public getPrivKeyBytes33(): Uint8Array {
        const privBytes = this.getPrivKeyBytes();
        if (!privBytes) throw new Error("Private key bytes are missing.");
        const bytes33 = new Uint8Array(33);
        bytes33.set(privBytes, 33 - privBytes.length);
        return bytes33;
    }

    public dropPrivateBytes(): DeterministicKey {
        if (this.isPubKeyOnly()) return this;
        return new DeterministicKey(
            this.getPath(),
            this.getChainCode(),
            this._pub,
            null,
            this.parent
        );
    }

    public dropParent(): DeterministicKey {
        const key = new DeterministicKey(
            this.getPath(),
            this.getChainCode(),
            this._pub,
            this._priv,
            null
        );
        key.parentFingerprint = this.parentFingerprint;
        return key;
    }

    static addChecksum(input: Uint8Array): Uint8Array {
        const checksummed = new Uint8Array(input.length + 4);
        checksummed.set(input, 0);
        const checksum = Sha256Hash.hashTwice(new Uint8Array(input));
        checksummed.set(checksum.slice(0, 4), input.length);
        return checksummed;
    }

    public async encryptDeterministic(keyCrypter: KeyCrypter, aesKey: KeyParameter, newParent: DeterministicKey | null = null): Promise<DeterministicKey> {
        if (newParent !== null) {
            if (!newParent.isEncrypted()) {
                throw new Error("New parent must be encrypted.");
            }
        }
        const privKeyBytes = this.getPrivKeyBytes();
        if (!privKeyBytes) throw new Error("Private key is not available");
        const encryptedPrivateKey = await keyCrypter.encrypt(privKeyBytes, aesKey);
        const key = new DeterministicKey(
            this.childNumberPath,
            this.chainCode,
            this._pub,
            null,
            newParent,
            undefined,
            undefined,
            keyCrypter,
            encryptedPrivateKey
        );
        if (!newParent) {
            key.setCreationTimeSeconds(this.getCreationTimeSeconds());
        }
        return key;
    }

    public async encrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<PQKey> {
        return this.encryptDeterministic(keyCrypter, aesKey) as unknown as Promise<PQKey>;
    }

    public isPubKeyOnly(): boolean {
        return this._priv === null && (this.parent === null || this.parent.isPubKeyOnly());
    }

    public hasPrivKey(): boolean {
        return this.findParentWithPrivKey() !== null;
    }

    public getPubKeyPoint(): ECPoint | null {
        return this._pub;
    }

    public getPrivKeyBytes(): Uint8Array | null {
        if (this._priv === null) return null;
        return DeterministicKey.bigIntegerToBytes(this._priv, 32);
    }

    public getPrivKey(): bigint {
        const key = this.findOrDerivePrivateKey();
        if (key === null) {
            throw new Error("Private key bytes not available");
        }
        return key;
    }

    public getPubKey(): Uint8Array {
        return this.getPubKeyBytes();
    }

    public getPubKeyBytes(): Uint8Array {
        if (!this._pub) throw new Error("Public key not available");
        return this._pub.encode(true);
    }

    public getPublicKeyBytes(): Uint8Array {
        return this.getPubKeyBytes();
    }

    public getSecretBytes(): Uint8Array | null {
        return this._priv ? this.getPrivKeyBytes() : null;
    }

    public getPubKeyHash(): Uint8Array {
        return Utils.sha256hash160(this.getPubKeyBytes());
    }

    public isEncrypted(): boolean {
        return this._priv === null && (this.encryptedPrivateKey !== null || !!this.parent?.isEncrypted());
    }

    public getKeyCrypter(): KeyCrypter | null {
        if (this.keyCrypter) {
            return this.keyCrypter;
        } else if (this.parent) {
            return this.parent.getKeyCrypter();
        } else {
            return null;
        }
    }

    public async sign(data: Uint8Array, aesKey?: KeyParameter): Promise<SignatureBundle> {
        if (this.isEncrypted()) {
            if (!aesKey) {
                throw new MissingPrivateKeyException('Key is encrypted but no AES key provided');
            }
            const decrypted = await this.decrypt(this.getKeyCrypter()!, aesKey);
            if (decrypted instanceof DeterministicKey) {
                return decrypted.sign(data, null);
            }
            return decrypted.signWithAesKey(Sha256Hash.of(data), null);
        }
        const privateKey = this.findOrDerivePrivateKey();
        if (privateKey === null) {
            throw new MissingPrivateKeyException();
        }
        return DeterministicKey.doSign(data, privateKey);
    }

    public async signWithAesKey(data: Sha256Hash, aesKey: KeyParameter | null): Promise<SignatureBundle> {
        if (this.isEncrypted()) {
            if (!aesKey) {
                throw new MissingPrivateKeyException('Key is encrypted but no AES key provided');
            }
            const decrypted = await this.decrypt(this.getKeyCrypter()!, aesKey);
            if (decrypted instanceof DeterministicKey) {
                return decrypted.signWithAesKey(data, null);
            }
            return decrypted.signWithAesKey(data, null);
        }
        const privateKey = this.findOrDerivePrivateKey();
        if (privateKey === null) {
            throw new MissingPrivateKeyException();
        }
        const msg = typeof (data as any).getBytes === 'function' ? (data as any).getBytes() : data as Uint8Array;
        return DeterministicKey.doSign(msg, privateKey);
    }

    private static doSign(message: Uint8Array, privateKey: bigint): Promise<SignatureBundle> {
        const privBytes = DeterministicKey.bigIntegerToBytes(privateKey, 32);
        const secp256k1 = require('secp256k1');
        const { signature } = secp256k1.ecdsaSign(message, privBytes);
        const derBytes = secp256k1.signatureExport(signature);
        const entry = new SignatureBundleEntry(PQConstants.ALG_ML_DSA_87, new Uint8Array(derBytes));
        return Promise.resolve(new SignatureBundle([entry]));
    }

    public async decrypt(aesKey: KeyParameter): Promise<PQKey>;
    public async decrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<PQKey>;
    public async decrypt(keyCrypterOrKey: KeyCrypter | KeyParameter, aesKey?: KeyParameter): Promise<PQKey> {
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
        return this.decryptDeterministic(crypter, key) as unknown as Promise<PQKey>;
    }

    public async decryptDeterministic(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<DeterministicKey> {
        if (this.keyCrypter && !this.keyCrypter.equals(keyCrypter)) {
            throw new Error("The keyCrypter being used to decrypt the key is different to the one that was used to encrypt it");
        }
        const privKey = await this.findOrDeriveEncryptedPrivateKey(keyCrypter, aesKey);
        const key = new DeterministicKey(
            this.childNumberPath,
            this.chainCode,
            null,
            privKey,
            this.parent
        );
        if (key._pub && this._pub && !key._pub.equals(this._pub)) {
            throw new Error("Provided AES key is wrong");
        }
        if (this.parent === null) {
            key.setCreationTimeSeconds(this.getCreationTimeSeconds());
        }
        return key;
    }

    private async findOrDeriveEncryptedPrivateKey(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<bigint> {
        if (this.encryptedPrivateKey !== null) {
            const decrypted = await keyCrypter.decrypt(this.encryptedPrivateKey, aesKey);
            return BigInt('0x' + Utils.HEX.encode(decrypted));
        }
        let cursor: DeterministicKey | null = this.parent;
        while (cursor !== null) {
            if (cursor.encryptedPrivateKey !== null) break;
            cursor = cursor.parent;
        }
        if (cursor === null) {
            throw new Error("Neither this key nor its parents have an encrypted private key");
        }
        const parentalPrivateKeyBytes = await keyCrypter.decrypt(cursor.encryptedPrivateKey!, aesKey);
        return this.derivePrivateKeyDownwards(cursor, parentalPrivateKeyBytes);
    }

    private findParentWithPrivKey(): DeterministicKey | null {
        let cursor: DeterministicKey | null = this;
        while (cursor !== null) {
            if (cursor._priv !== null) break;
            cursor = cursor.parent;
        }
        return cursor;
    }

    private findOrDerivePrivateKey(): bigint | null {
        const cursor = this.findParentWithPrivKey();
        if (cursor === null) {
            return null;
        }
        if (cursor === this) {
            return this._priv;
        }
        return this.derivePrivateKeyDownwards(cursor, DeterministicKey.bigIntegerToBytes(cursor._priv!, 32));
    }

    private derivePrivateKeyDownwards(cursor: DeterministicKey, parentalPrivateKeyBytes: Uint8Array): bigint {
        const parentalPrivateKey = BigInt('0x' + Utils.HEX.encode(parentalPrivateKeyBytes));
        const downCursor = new DeterministicKey(
            cursor.childNumberPath,
            cursor.chainCode,
            null,
            parentalPrivateKey,
            cursor.parent
        );
        const path = this.childNumberPath.slice(cursor.getPath().length);
        let currentKey = downCursor;
        for (const num of path) {
            currentKey = HDKeyDerivation.deriveChildKey(currentKey, num);
        }
        if (!currentKey._pub?.equals(this._pub!)) {
            throw new Error("Could not decrypt bytes");
        }
        return currentKey._priv!;
    }

    public derive(child: number): DeterministicKey {
        return HDKeyDerivation.deriveChildKey(this, new ChildNumber(child, true));
    }

    public serializePublic(params: NetworkParameters): Uint8Array {
        return this.serialize(params, true);
    }

    public serializePrivate(params: NetworkParameters): Uint8Array {
        return this.serialize(params, false);
    }

    private serialize(params: NetworkParameters, pub: boolean): Uint8Array {
        const buffer = new ArrayBuffer(78);
        const view = new DataView(buffer);
        let offset = 0;

        view.setUint32(offset, pub ? params.getBip32HeaderPub() : params.getBip32HeaderPriv(), false);
        offset += 4;

        view.setUint8(offset, this.depth);
        offset += 1;

        view.setUint32(offset, this.getParentFingerprint(), false);
        offset += 4;

        view.setUint32(offset, this.getChildNumber().getI(), false);
        offset += 4;

        const chainCodeBytes = this.getChainCode();
        new Uint8Array(buffer, offset, 32).set(chainCodeBytes);
        offset += 32;

        const keyBytes = pub ? this.getPubKeyBytes() : this.getPrivKeyBytes33();
        new Uint8Array(buffer, offset, 33).set(keyBytes);
        offset += 33;

        if (offset !== 78) {
            throw new Error("Serialization error: buffer position is not 78");
        }

        return new Uint8Array(buffer);
    }

    public serializePubB58(params: NetworkParameters): string {
        return DeterministicKey.toBase58(this.serialize(params, true));
    }

    public serializePrivB58(params: NetworkParameters): string {
        return DeterministicKey.toBase58(this.serialize(params, false));
    }

    static toBase58(data: Uint8Array): string {
        return Base58.encode(DeterministicKey.addChecksum(data));
    }

    public static deserializeB58(base58: string, params: NetworkParameters): DeterministicKey;
    public static deserializeB58(parent: DeterministicKey | null, base58: string, params: NetworkParameters): DeterministicKey;
    public static deserializeB58(...args: any[]): DeterministicKey {
        let parent: DeterministicKey | null = null;
        let base58: string;
        let params: NetworkParameters;

        if (args.length === 2) {
            [base58, params] = args;
        } else if (args.length === 3) {
            [parent, base58, params] = args;
        } else {
            throw new Error("Invalid number of arguments");
        }

        const decoded = Base58.decodeChecked(base58);
        return DeterministicKey.deserialize(params, decoded, parent);
    }

    public static deserialize(params: NetworkParameters, serializedKey: Uint8Array): DeterministicKey;
    public static deserialize(params: NetworkParameters, serializedKey: Uint8Array, parent: DeterministicKey | null): DeterministicKey;
    public static deserialize(...args: any[]): DeterministicKey {
        let params: NetworkParameters;
        let serializedKey: Uint8Array;
        let parent: DeterministicKey | null = null;

        if (args.length === 2) {
            [params, serializedKey] = args;
        } else if (args.length === 3) {
            [params, serializedKey, parent] = args;
        } else {
            throw new Error("Invalid number of arguments");
        }

        const buffer = serializedKey.buffer;
        const view = new DataView(buffer, serializedKey.byteOffset, serializedKey.byteLength);
        let offset = 0;

        const header = view.getUint32(offset, false);
        offset += 4;

        const pub = header === params.getBip32HeaderPub();

        const depth = view.getUint8(offset);
        offset += 1;

        const parentFingerprint = view.getUint32(offset, false);
        offset += 4;

        const i = view.getUint32(offset, false);
        const childNumber = new ChildNumber(i);
        offset += 4;

        let path: ChildNumber[];
        if (parent !== null) {
            if (parentFingerprint === 0) {
                throw new Error("Parent was provided but this key doesn't have one");
            }
            if (parent.getFingerprint() !== parentFingerprint) {
                throw new Error("Parent fingerprints don't match");
            }
            path = HDUtils.append(parent.getPath(), childNumber);
            if (path.length !== depth) {
                throw new Error("Depth does not match");
            }
        } else {
            if (depth >= 1) {
                path = [childNumber];
            } else {
                path = [];
            }
        }
        const chainCode = new Uint8Array(buffer, serializedKey.byteOffset + offset, 32);
        offset += 32;
        const keyData = new Uint8Array(buffer, serializedKey.byteOffset + offset, 33);
        offset += 33;

        if (offset !== serializedKey.byteLength) {
            throw new Error("Found unexpected data in key");
        }

        if (pub) {
            return new DeterministicKey(path, chainCode, ECPoint.decodePoint(keyData), null, parent, depth, parentFingerprint);
        } else {
            const privBI = BigInt('0x' + Utils.HEX.encode(keyData));
            return new DeterministicKey(path, chainCode, null, privBI, parent, depth, parentFingerprint);
        }
    }

    public getCreationTimeSeconds(): number {
        if (this.parent !== null) {
            return this.parent.getCreationTimeSeconds();
        } else {
            return super.getCreationTimeSeconds();
        }
    }

    public setCreationTimeSeconds(newCreationTimeSeconds: number): void {
        if (this.parent !== null) {
            throw new Error("Creation time can only be set on root keys.");
        } else {
            super.setCreationTimeSeconds(newCreationTimeSeconds);
        }
    }

    public hasPrivateKey(): boolean {
        return this.hasPrivKey();
    }

    public equals(o: any): boolean {
        if (this === o) return true;
        if (!(o instanceof DeterministicKey)) return false;
        const pubEqual = this._pub === o._pub || (this._pub !== null && o._pub !== null && this._pub.equals(o._pub));
        return pubEqual &&
            DeterministicKey.bytesEqual(this.chainCode, o.chainCode) &&
            this.childNumberPath.length === o.childNumberPath.length &&
            this.childNumberPath.every((cn, i) => cn.equals(o.childNumberPath[i]));
    }

    public hashCode(): number {
        let result = this._pub?.hashCode() ?? 0;
        result = 31 * result + this.chainCode.reduce((acc, byte) => acc + byte, 0);
        result = 31 * result + this.childNumberPath.reduce((acc, cn) => acc + cn.hashCode(), 0);
        return result;
    }

    public toString(): string {
        let s = `DeterministicKey{pub=${Utils.HEX.encode(this.getPubKeyBytes())}, ` +
                `chainCode=${Utils.HEX.encode(this.chainCode)}, path=${this.getPathAsString()}`;
        if (this.creationTimeSeconds > 0) {
            s += `, creationTimeSeconds=${this.creationTimeSeconds}`;
        }
        s += `, isEncrypted=${this.isEncrypted()}, isPubKeyOnly=${this.isPubKeyOnly()}}`;
        return s;
    }

    public formatKeyWithAddress(
        includePrivateKeys: boolean,
        builder: string[]
    ): void {
        builder.push(`  (${this.getPathAsString()})`);
        if (includePrivateKeys) {
            builder.push(`  Private key not available`);
        }
    }

    static publicPointFromPrivate(priv: bigint): ECPoint {
        return ECPoint.fromPrivate(priv);
    }
}
