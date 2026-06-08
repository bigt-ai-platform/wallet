import { DeterministicSeed } from './DeterministicSeed';
import { DeterministicHierarchy } from '../crypto/DeterministicHierarchy';
import { DeterministicKey } from '../crypto/DeterministicKey';
import { ChildNumber } from '../crypto/ChildNumber';
import { BasicKeyChain } from './BasicKeyChain';
import { HDKeyDerivation } from '../crypto/HDKeyDerivation';
import { NetworkParameters } from '../params/NetworkParameters';
import { KeyPurpose } from './KeyChain';
import * as Protos from './Protos';
import { Preconditions } from '../utils/Preconditions';

export class DeterministicKeyChain {
    private static readonly DEFAULT_PASSPHRASE_FOR_MNEMONIC = "";

    public static readonly ACCOUNT_ZERO_PATH: ChildNumber[] = [ChildNumber.ZERO_HARDENED];
    public static readonly EXTERNAL_SUBPATH: ChildNumber[] = [ChildNumber.ZERO];
    public static readonly INTERNAL_SUBPATH: ChildNumber[] = [ChildNumber.ONE];
    public static readonly EXTERNAL_PATH: ChildNumber[] = [...DeterministicKeyChain.ACCOUNT_ZERO_PATH, ...DeterministicKeyChain.EXTERNAL_SUBPATH];
    public static readonly INTERNAL_PATH: ChildNumber[] = [...DeterministicKeyChain.ACCOUNT_ZERO_PATH, ...DeterministicKeyChain.INTERNAL_SUBPATH];
    public static readonly BIP44_ACCOUNT_ZERO_PATH: ChildNumber[] = [
        new ChildNumber(44, true), ChildNumber.ZERO_HARDENED, ChildNumber.ZERO_HARDENED
    ];

    private hierarchy!: DeterministicHierarchy;
    private rootKey: DeterministicKey | null = null;
    private seed: DeterministicSeed | null = null;
    protected lookaheadSize = 100;
    private lookaheadThreshold: number;
    private externalParentKey!: DeterministicKey;
    private internalParentKey!: DeterministicKey;
    private issuedExternalKeys = 0;
    private issuedInternalKeys = 0;
    private keyLookaheadEpoch = 0;
    private basicKeyChain: BasicKeyChain;
    private isFollowing = false;
    protected sigsRequiredToSpend = 1;
    protected params: NetworkParameters;

    // Simplified constructor to accept a single union type for seedOrKey
    constructor(params: NetworkParameters, seedOrKey: DeterministicSeed | DeterministicKey) {
        this.params = params;
        this.basicKeyChain = new BasicKeyChain(this.params);
        this.lookaheadThreshold = this.calcDefaultLookaheadThreshold();

        if (seedOrKey instanceof DeterministicSeed) {
            this.seed = seedOrKey;
            if (!this.seed.isEncrypted()) {
                const seedBytes = this.seed.getSeedBytes();
                if (!seedBytes) throw new Error("Seed bytes are null");

                this.rootKey = HDKeyDerivation.createMasterPrivateKey(seedBytes);
                this.rootKey.setCreationTimeSeconds(this.seed.getCreationTimeSeconds());
                this.addToBasicChain(this.rootKey);
                this.hierarchy = new DeterministicHierarchy(this.rootKey);
                this.initializeHierarchyUnencrypted();
            }
        } else { // It's a DeterministicKey
            const watchingKey = seedOrKey;
            if (watchingKey.isPubKeyOnly() !== true) {
                throw new Error("Private subtrees not currently supported");
            }
            if (watchingKey.getPath().length !== this.getAccountPath().length) {
                throw new Error("You can only watch an account key currently");
            }

            this.seed = null;
            this.rootKey = null;
            this.addToBasicChain(watchingKey);
            this.hierarchy = new DeterministicHierarchy(watchingKey);
            this.initializeHierarchyUnencrypted();
        }
    }

    private calcDefaultLookaheadThreshold(): number {
        return Math.floor(this.lookaheadSize / 3);
    }

    protected getAccountPath(): ChildNumber[] {
        return DeterministicKeyChain.ACCOUNT_ZERO_PATH;
    }

    private initializeHierarchyUnencrypted(): void {
        const accountKey = this.hierarchy.get(this.getAccountPath(), false, true);
        const externalPath = [...this.getAccountPath(), ...DeterministicKeyChain.EXTERNAL_SUBPATH];
        this.externalParentKey = this.hierarchy.get(externalPath, false, true);
        const internalPath = [...this.getAccountPath(), ...DeterministicKeyChain.INTERNAL_SUBPATH];
        this.internalParentKey = this.hierarchy.get(internalPath, false, true);
        this.addToBasicChain(this.externalParentKey);
        this.addToBasicChain(this.internalParentKey);
    }

    private addToBasicChain(key: DeterministicKey): void {
        this.basicKeyChain.importKeys(key);
    }

    public getKey(purpose: KeyPurpose): DeterministicKey {
        if (this.rootKey) {
            return this.rootKey;
        }
        throw new Error("No root key available to derive from.");
    }

    public getKeyByPath(path: ChildNumber[]): DeterministicKey {
        if (this.hierarchy) {
            return this.hierarchy.get(path, false, true);
        }
        throw new Error("Hierarchy not initialized.");
    }

    public maybeLookAhead(): void {
        console.log("Performing lookahead...");
    }

    public numLeafKeysIssued(): number {
        return this.issuedExternalKeys + this.issuedInternalKeys;
    }

    public getLeafKeys(): DeterministicKey[] {
        const keys: DeterministicKey[] = [];
        if (this.rootKey) {
            keys.push(this.rootKey);
        }
        return keys;
    }

    public getWatchingKey(): DeterministicKey {
        if (this.rootKey) {
            return this.rootKey.dropPrivateBytes();
        }
        throw new Error("No watching key available.");
    }

    public serializeMyselfToProtobuf(): Protos.Key[] {
        return [];
    }

    public setLookaheadSize(lookaheadSize: number): void {
        this.lookaheadSize = lookaheadSize;
    }

    public static watchAndFollow(key: DeterministicKey, params: NetworkParameters): DeterministicKeyChain {
        const chain = new DeterministicKeyChain(params, key);
        (chain as any).isFollowing = true;
        return chain;
    }
}

export class DeterministicKeyChainBuilder<T extends DeterministicKeyChainBuilder<T>> {
    protected _random: any;
    protected _entropy: Uint8Array | null = null;
    protected _seed: DeterministicSeed | null = null;
    protected _watchingKey: DeterministicKey | null = null;
    protected _passphrase: string = "";
    protected _seedCreationTimeSecs: number = 0;
    protected _bits: number = 128;

    protected self(): T {
        return this as any;
    }

    public random(random: any): T { this._random = random; return this.self(); }
    public entropy(entropy: Uint8Array): T { this._entropy = entropy; return this.self(); }
    public seed(seed: DeterministicSeed): T { this._seed = seed; return this.self(); }
    public watchingKey(watchingKey: DeterministicKey): T { this._watchingKey = watchingKey; return this.self(); }
    public passphrase(passphrase: string): T { this._passphrase = passphrase; return this.self(); }
    public seedCreationTimeSecs(seedCreationTimeSecs: number): T { this._seedCreationTimeSecs = seedCreationTimeSecs; return this.self(); }
    public bits(bits: number): T { this._bits = bits; return this.self(); }

    public build(params: NetworkParameters): DeterministicKeyChain {
        Preconditions.checkState(this._random != null || this._entropy != null || this._seed != null || this._watchingKey != null, "Must provide either entropy or random or seed or watchingKey");
        if (this._seed) {
            return new DeterministicKeyChain(params, this._seed);
        } else if (this._watchingKey) {
            return new DeterministicKeyChain(params, this._watchingKey);
        } else if (this._entropy) {
            const seed = new DeterministicSeed(null, this._entropy, null, null, this._seedCreationTimeSecs);
            return new DeterministicKeyChain(params, seed);
        } else if (this._random) {
            const entropy = new Uint8Array(this._bits / 8);
            for (let i = 0; i < entropy.length; i++) {
                entropy[i] = Math.floor(Math.random() * 256);
            }
            const seed = new DeterministicSeed(null, entropy, null, null, this._seedCreationTimeSecs);
            return new DeterministicKeyChain(params, seed);
        }
        throw new Error("Cannot build DeterministicKeyChain: insufficient parameters.");
    }
}
