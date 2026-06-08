import { DeterministicKeyChain, DeterministicKeyChainBuilder } from './DeterministicKeyChain';
import { DeterministicSeed } from './DeterministicSeed'; // Corrected import
import { DeterministicKey } from '../crypto/DeterministicKey';
import { KeyCrypter } from '../crypto/KeyCrypter';
import { BloomFilter } from '../core/BloomFilter';
import { ECKey } from '../core/ECKey';
import { Utils } from '../utils/Utils';
import { NetworkParameters } from '../params/NetworkParameters';
import { Script } from '../script/Script';
import { ScriptBuilder } from '../script/ScriptBuilder';
import { Preconditions } from '../utils/Preconditions';
import { RedeemData } from './RedeemData';
import { KeyPurpose } from './KeyChain';

/**
 * <p>A multi-signature keychain using synchronized HD keys (a.k.a HDM)</p>
 * <p>This keychain keeps track of following keychains that follow the account key of this keychain.
 * You can get P2SH addresses to receive coins to from this chain. The threshold - sigsRequiredToSpend
 * specifies how many signatures required to spend transactions for this married keychain. This value should not exceed
 * total number of keys involved (one followed key plus number of following keys), otherwise IllegalArgumentException
 * will be thrown.</p>
 * <p>IMPORTANT: As of Bitcoin Core 0.9 all multisig transactions which require more than 3 public keys are non-standard
 * and such spends won't be processed by peers with default settings, essentially making such transactions almost
 * nonspendable</p>
 * <p>This method will throw an IllegalStateException, if the keychain is already married or already has leaf keys
 * issued.</p>
 */
export class MarriedKeyChain extends DeterministicKeyChain {
    private marriedKeysRedeemData: Map<string, RedeemData> = new Map();
    private followingKeyChains: DeterministicKeyChain[] = [];
    public sigsRequiredToSpend: number = 1;

    // Single constructor implementation to handle overloads
    constructor(params: NetworkParameters, arg1: DeterministicKey | DeterministicSeed, arg2?: KeyCrypter) {
        // Call super unconditionally as the first statement.
        // The DeterministicKeyChain constructor already handles the union type for its second argument.
        super(params, arg1);
        // The 'crypter' parameter is not passed to super, as DeterministicKeyChain doesn't use it in its constructor.
        // If crypter is needed for MarriedKeyChain specific logic, it would be handled here.
    }

    /** Builds a {@link MarriedKeyChain} */
    public static builder<T extends MarriedKeyChainBuilder<T>>(): MarriedKeyChainBuilder<any> {
        return new MarriedKeyChainBuilder<any>();
    }

    public setFollowingKeyChains(followingKeyChains: DeterministicKeyChain[]): void {
        Preconditions.checkArgument(followingKeyChains.length > 0);
        this.followingKeyChains = followingKeyChains;
    }

    public isMarried(): boolean {
        return true;
    }

    /** Create a new married key and return the matching output script */
    public freshOutputScript(purpose: KeyPurpose): Script {
        const followedKey = this.getKey(purpose);
        const keys: ECKey[] = [followedKey as unknown as ECKey]; // Cast to ECKey
        for (const keyChain of this.followingKeyChains) {
            const followingKey = keyChain.getKey(purpose);
            Preconditions.checkState(followedKey.getChildNumber().equals(followingKey.getChildNumber()), "Following keychains should be in sync");
            keys.push(followingKey as unknown as ECKey); // Cast to ECKey
        }
        const redeemScript = ScriptBuilder.createRedeemScript(this.sigsRequiredToSpend, keys);
        return ScriptBuilder.createP2SHOutputScript(redeemScript.getProgram());
    }

    private getMarriedKeysWithFollowed(followedKey: DeterministicKey): ECKey[] {
        const keys: ECKey[] = [];
        for (const keyChain of this.followingKeyChains) {
            keyChain.maybeLookAhead();
            keys.push(keyChain.getKeyByPath(followedKey.getPath()) as unknown as ECKey); // Cast to ECKey
        }
        keys.push(followedKey as unknown as ECKey); // Cast to ECKey
        return keys;
    }

    /** Get the redeem data for a key in this married chain */
    public getRedeemData(followedKey: DeterministicKey): RedeemData {
        const marriedKeys = this.getMarriedKeysWithFollowed(followedKey);
        const redeemScript = ScriptBuilder.createRedeemScript(this.sigsRequiredToSpend, marriedKeys);
        return RedeemData.of(marriedKeys, redeemScript);
    }

    public addFollowingAccountKeys(followingAccountKeys: DeterministicKey[], sigsRequiredToSpend: number): void {
        Preconditions.checkArgument(sigsRequiredToSpend <= followingAccountKeys.length + 1, "Multisig threshold can't exceed total number of keys");
        Preconditions.checkState(this.numLeafKeysIssued() === 0, "Active keychain already has keys in use");
        Preconditions.checkState(this.followingKeyChains.length === 0);

        const followingKeyChains: DeterministicKeyChain[] = [];

        for (const key of followingAccountKeys) {
            Preconditions.checkArgument(key.getPath().length === this.getAccountPath().length, "Following keys have to be account keys");
            const chain = DeterministicKeyChain.watchAndFollow(key, this.params);
            if (this.lookaheadSize >= 0) {
                chain.setLookaheadSize(this.lookaheadSize);
            }
            followingKeyChains.push(chain);
        }

        this.sigsRequiredToSpend = sigsRequiredToSpend;
        this.followingKeyChains = followingKeyChains;
    }

    public setLookaheadSize(lookaheadSize: number): void {
        super.setLookaheadSize(lookaheadSize);
        if (this.followingKeyChains != null) {
            for (const followingChain of this.followingKeyChains) {
                followingChain.setLookaheadSize(lookaheadSize);
            }
        }
    }

    public serializeToProtobuf(): any[] { // Should be Protos.Key[]
        const result: any[] = [];
        for (const chain of this.followingKeyChains) {
            result.push(...(chain as any).serializeMyselfToProtobuf());
        }
        result.push(...(this as any).serializeMyselfToProtobuf());
        return result;
    }

    protected formatAddresses(includePrivateKeys: boolean, params: NetworkParameters, builder: string[]): void {
        for (const followingChain of this.followingKeyChains) {
            builder.push(`Following chain:  ${followingChain.getWatchingKey().serializePubB58(params)}\n`);
        }
        builder.push('\n');
        for (const redeemData of this.marriedKeysRedeemData.values()) {
            this.formatScript(ScriptBuilder.createP2SHOutputScript(redeemData.redeemScript.getProgram()), builder, params);
        }
    }

    private formatScript(script: Script, builder: string[], params: NetworkParameters): void {
        builder.push("  addr:");
        builder.push(script.getToAddress(params).toString());
        builder.push("  hash160:");
        builder.push(Utils.HEX.encode(script.getPubKeyHash()));
        if ((script as any).getCreationTimeSeconds && (script as any).getCreationTimeSeconds() > 0) {
            builder.push(`  creationTimeSeconds:${(script as any).getCreationTimeSeconds()}`);
        }
        builder.push('\n');
    }

    public maybeLookAheadScripts(): void {
        super.maybeLookAhead();
        const numLeafKeys = this.getLeafKeys().length;

        Preconditions.checkState(this.marriedKeysRedeemData.size <= numLeafKeys, "Number of scripts is greater than number of leaf keys");
        if (this.marriedKeysRedeemData.size === numLeafKeys) {
            return;
        }

        this.maybeLookAhead();
        for (const followedKey of this.getLeafKeys()) {
            const redeemData = this.getRedeemData(followedKey);
            const scriptPubKey = ScriptBuilder.createP2SHOutputScript(redeemData.redeemScript.getProgram());
            this.marriedKeysRedeemData.set(Array.from(new Uint8Array(scriptPubKey.getPubKeyHash())).map(b => b.toString(16).padStart(2, '0')).join(''), redeemData);
        }
    }

    public findRedeemDataByScriptHash(bytes: Uint8Array): RedeemData | null {
        const hex = Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
        return this.marriedKeysRedeemData.get(hex) || null;
    }

    public getFilter(size: number, falsePositiveRate: number, tweak: number): BloomFilter {
        const filter = new BloomFilter(this.params, size, falsePositiveRate, tweak);
        for (const [key, redeemData] of this.marriedKeysRedeemData.entries()) {
            const keyBytes = new Uint8Array(key.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
            filter.insert(keyBytes);
            filter.insert(redeemData.redeemScript.getProgram());
        }
        return filter;
    }

    public numBloomFilterEntries(): number {
        this.maybeLookAhead();
        return this.getLeafKeys().length * 2;
    }
}

// Builder class for MarriedKeyChain
export class MarriedKeyChainBuilder<T extends MarriedKeyChainBuilder<T>> extends DeterministicKeyChainBuilder<T> {
    // Removed duplicate protected properties as they are inherited from DeterministicKeyChainBuilder
    // These properties are now managed by the superclass's methods or passed directly to build.
    private _followingKeys: DeterministicKey[] = []; // Renamed to avoid conflict
    private _threshold: number = 0; // Renamed to avoid conflict

    public followingKeys(followingKeys: DeterministicKey[]): T {
        this._followingKeys = followingKeys;
        return this.self();
    }

    public followingKeysSingle(followingKey: DeterministicKey, ...followingKeys: DeterministicKey[]): T {
        this._followingKeys = [followingKey, ...followingKeys];
        return this.self();
    }

    /**
     * Threshold, or <code>(followingKeys.size() + 1) / 2 + 1)</code> (majority) if unspecified.</p>
     * <p>IMPORTANT: As of Bitcoin Core 0.9 all multisig transactions which require more than 3 public keys are non-standard
     * and such spends won't be processed by peers with default settings, essentially making such transactions almost
     * nonspendable</p>
     */
    public threshold(threshold: number): T {
        this._threshold = threshold;
        return this.self();
    }

    public build(params: NetworkParameters): MarriedKeyChain {
        // Access inherited properties via their protected names (e.g., this._random)
        Preconditions.checkState(this._random != null || this._entropy != null || this._seed != null || this._watchingKey != null, "Must provide either entropy or random or seed or watchingKey");
        Preconditions.checkNotNull(this._followingKeys, "followingKeys must be provided");
        let chain: MarriedKeyChain;
        if (this._threshold === 0) {
            this._threshold = Math.floor((this._followingKeys.length + 1) / 2) + 1;
        }

        if (this._random != null) {
            throw new Error("SecureRandom constructor not yet implemented for MarriedKeyChain");
        } else if (this._entropy != null) {
            throw new Error("Entropy constructor not yet implemented for MarriedKeyChain");
        } else if (this._seed != null) {
            this._seed.setCreationTimeSeconds(this._seedCreationTimeSecs);
            chain = new MarriedKeyChain(params, this._seed);
        } else if (this._watchingKey != null) {
            chain = new MarriedKeyChain(params, this._watchingKey);
        } else {
            throw new Error("Invalid builder state");
        }
        chain.addFollowingAccountKeys(this._followingKeys, this._threshold);
        return chain;
    }
}
