import { MnemonicCode } from '../crypto/MnemonicCode';
import { KeyCrypter, KeyParameter } from '../crypto/KeyCrypter';
import { EncryptedData } from '../crypto/EncryptedData';
import { EncryptionType, EncryptableItem } from '../crypto/EncryptableItem';
import { Utils } from '../utils/Utils';

/**
 * Holds the seed bytes for the BIP32 deterministic wallet algorithm, inside a
 * {@link DeterministicKeyChain}. The purpose of this wrapper is to simplify the encryption
 * code.
 */
export class DeterministicSeed implements EncryptableItem {
    public static readonly DEFAULT_SEED_ENTROPY_BITS = 128;
    public static readonly MAX_SEED_ENTROPY_BITS = 512;

    private readonly seedBytes: Uint8Array | null = null;
    private readonly mnemonicCode: string[] | null = null;
    private readonly encryptedMnemonicCode: EncryptedData | null = null;
    private readonly encryptedSeed: EncryptedData | null = null;
    private creationTimeSeconds: number = 0;

    // Making the constructor public to allow direct instantiation from builders
    constructor(
        mnemonicCode: string[] | null,
        seedBytes: Uint8Array | null,
        encryptedMnemonicCode: EncryptedData | null,
        encryptedSeed: EncryptedData | null,
        creationTimeSeconds: number
    ) {
        this.mnemonicCode = mnemonicCode;
        this.seedBytes = seedBytes;
        this.encryptedMnemonicCode = encryptedMnemonicCode;
        this.encryptedSeed = encryptedSeed;
        this.creationTimeSeconds = creationTimeSeconds;
    }

    public static async fromMnemonicAndPassphrase(
        mnemonicCode: string[],
        passphrase: string,
        creationTimeSeconds: number
    ): Promise<DeterministicSeed> {
        const seedBytes = await MnemonicCode.toSeed(mnemonicCode, passphrase);
        return new DeterministicSeed(mnemonicCode, seedBytes, null, null, creationTimeSeconds);
    }

    public static fromMnemonicAndSeed(
        mnemonicCode: string[],
        seedBytes: Uint8Array,
        creationTimeSeconds: number
    ): DeterministicSeed {
        return new DeterministicSeed(mnemonicCode, seedBytes, null, null, creationTimeSeconds);
    }

    public static fromEncrypted(
        encryptedMnemonic: EncryptedData,
        encryptedSeed: EncryptedData | null,
        creationTimeSeconds: number
    ): DeterministicSeed {
        return new DeterministicSeed(null, null, encryptedMnemonic, encryptedSeed, creationTimeSeconds);
    }

    public static async fromEntropy(
        entropy: Uint8Array,
        passphrase: string,
        creationTimeSeconds: number
    ): Promise<DeterministicSeed> {
        if (entropy.length % 4 !== 0) throw new Error("entropy size in bits not divisible by 32");
        if (entropy.length * 8 < DeterministicSeed.DEFAULT_SEED_ENTROPY_BITS) throw new Error("entropy size too small");
        const mnemonicCode = MnemonicCode.INSTANCE.toMnemonic(entropy);
        const seedBytes = await MnemonicCode.toSeed(mnemonicCode, passphrase);
        return new DeterministicSeed(mnemonicCode, seedBytes, null, null, creationTimeSeconds);
    }

    public static async fromRandom(
        random: any,
        bits: number,
        passphrase: string,
        creationTimeSeconds: number
    ): Promise<DeterministicSeed> {
        const entropy = DeterministicSeed.getEntropy(random, bits);
        const mnemonicCode = MnemonicCode.INSTANCE.toMnemonic(entropy);
        const seedBytes = await MnemonicCode.toSeed(mnemonicCode, passphrase);
        return new DeterministicSeed(mnemonicCode, seedBytes, null, null, creationTimeSeconds);
    }

    public static fromMnemonicStringAndSeed(
        mnemonicString: string,
        seedBytes: Uint8Array,
        creationTimeSeconds: number
    ): DeterministicSeed {
        const mnemonicCode = DeterministicSeed.decodeMnemonicCode(mnemonicString);
        return new DeterministicSeed(mnemonicCode, seedBytes, null, null, creationTimeSeconds);
    }

    private static getEntropy(random: any, bits: number): Uint8Array {
        if (bits > DeterministicSeed.MAX_SEED_ENTROPY_BITS) throw new Error("requested entropy size too large");
        const seed = new Uint8Array(bits / 8);
        // Use crypto.getRandomValues if available, otherwise fallback to Math.random
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            crypto.getRandomValues(seed);
        } else {
            for (let i = 0; i < seed.length; i++) {
                seed[i] = Math.floor(Math.random() * 256);
            }
        }
        return seed;
    }

    public isEncrypted(): boolean {
        if (this.mnemonicCode === null && this.encryptedMnemonicCode === null) {
            throw new Error("MnemonicCode and EncryptedMnemonicCode are both null");
        }
        return this.encryptedMnemonicCode !== null;
    }

    public toString(): string {
        const mnemonicStr = this.mnemonicCode ? this.mnemonicCode.join(" ") : "";
        const hexStr = this.toHexString();
        if (this.isEncrypted()) {
            return "DeterministicSeed [encrypted]";
        } else {
            return `DeterministicSeed ${hexStr} ${mnemonicStr}`;
        }
    }

    public toHexString(): string | null {
        return this.seedBytes !== null ? Utils.HEX.encode(this.seedBytes) : null;
    }

    public getSecretBytes(): Uint8Array | null {
        return this.getMnemonicAsBytes();
    }

    public getSeedBytes(): Uint8Array | null {
        return this.seedBytes;
    }

    public getEncryptedData(): EncryptedData | null {
        return this.encryptedMnemonicCode;
    }

    public getEncryptionType(): EncryptionType {
        return EncryptionType.ENCRYPTED_SCRYPT_AES;
    }

    public getEncryptedSeedData(): EncryptedData | null {
        return this.encryptedSeed;
    }

    public getCreationTimeSeconds(): number {
        return this.creationTimeSeconds;
    }

    public setCreationTimeSeconds(creationTimeSeconds: number): void {
        this.creationTimeSeconds = creationTimeSeconds;
    }

    public async encrypt(keyCrypter: KeyCrypter, aesKey: KeyParameter): Promise<DeterministicSeed> {
        if (this.encryptedMnemonicCode !== null) throw new Error("Trying to encrypt seed twice");
        if (this.mnemonicCode === null) throw new Error("Mnemonic missing so cannot encrypt");
        const encryptedMnemonic = await keyCrypter.encrypt(this.getMnemonicAsBytes()!, aesKey);
        const encryptedSeed = await keyCrypter.encrypt(this.seedBytes!, aesKey);
        return new DeterministicSeed(null, null, encryptedMnemonic, encryptedSeed, this.creationTimeSeconds);
    }

    private getMnemonicAsBytes(): Uint8Array | null {
        return this.mnemonicCode ? new TextEncoder().encode(this.mnemonicCode.join(" ")) : null;
    }

    public async decrypt(crypter: KeyCrypter, passphrase: string, aesKey: KeyParameter): Promise<DeterministicSeed> {
        if (!this.isEncrypted()) throw new Error("Seed is not encrypted");
        if (this.encryptedMnemonicCode === null) throw new Error("Encrypted mnemonic code is null");
        const decryptedMnemonic = await crypter.decrypt(this.encryptedMnemonicCode, aesKey);
        const mnemonic = DeterministicSeed.decodeMnemonicCode(decryptedMnemonic);
        const seed = this.encryptedSeed === null ? null : await crypter.decrypt(this.encryptedSeed, aesKey);
        return new DeterministicSeed(mnemonic, seed, null, null, this.creationTimeSeconds);
    }

    public equals(o: any): boolean {
        if (this === o) return true;
        if (o === null || !(o instanceof DeterministicSeed)) return false;
        return this.creationTimeSeconds === o.creationTimeSeconds &&
               (this.encryptedMnemonicCode === o.encryptedMnemonicCode || (this.encryptedMnemonicCode !== null && o.encryptedMnemonicCode !== null && this.encryptedMnemonicCode.equals(o.encryptedMnemonicCode))) &&
               (this.mnemonicCode === o.mnemonicCode || (this.mnemonicCode !== null && o.mnemonicCode !== null && this.mnemonicCode.every((val, i) => val === o.mnemonicCode![i])));
    }

    public hashCode(): number {
        let result = 17;
        result = 31 * result + this.creationTimeSeconds;
        result = 31 * result + (this.encryptedMnemonicCode ? this.encryptedMnemonicCode.hashCode() : 0);
        result = 31 * result + (this.mnemonicCode ? this.mnemonicCode.reduce((acc, val) => acc + val.length, 0) : 0); // Simple hash for array
        return result;
    }

    public async check(): Promise<void> {
        if (this.mnemonicCode !== null) {
            await MnemonicCode.INSTANCE.check(this.mnemonicCode);
        }
    }

    public async getEntropyBytes(): Promise<Uint8Array> {
        if (this.mnemonicCode === null) throw new Error("Mnemonic code is null");
        return await MnemonicCode.INSTANCE.toEntropy(this.mnemonicCode);
    }

    public getMnemonicCode(): string[] | null {
        return this.mnemonicCode;
    }

    private static decodeMnemonicCode(mnemonicCode: Uint8Array | string): string[] {
        const mnemonicString = typeof mnemonicCode === 'string' ? mnemonicCode : new TextDecoder('utf-8').decode(mnemonicCode);
        return mnemonicString.split(" ");
    }
}
