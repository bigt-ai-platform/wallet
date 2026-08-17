import { KeyChainGroup } from './KeyChainGroup';
import { NetworkParameters } from '../params/NetworkParameters';
import { PQKey } from '../crypto/pq/PQKey';
import { ECKey } from '../core/ECKey';
import { KeyCrypter, KeyParameter } from '../crypto/KeyCrypter';
import { KeyCrypterScrypt } from '../crypto/KeyCrypterScrypt';
import { TransactionSigner } from '../signers/TransactionSigner';
import { DecryptingKeyBag } from './DecryptingKeyBag';
import { MissingSigResolutionSigner } from '../signers/MissingSigResolutionSigner';
import { Key as ProtosKey } from './Protos';
import { RedeemData } from './RedeemData';
import { Transaction } from '../core/Transaction';
import { KeyBag } from './KeyBag';
import { EncryptionType } from '../crypto/EncryptableItem';
import { DeterministicKey } from '../crypto/DeterministicKey';
import { Mutex } from '../utils/Mutex';

export abstract class WalletBase implements KeyBag {
    protected readonly lock = new Mutex();
    protected readonly keyChainGroupLock = new Mutex();

    protected serverURL: string | null = null;
    protected static readonly SPENTPENDINGTIMEOUT = 120000;
    protected fee: boolean = true;

    protected keyChainGroup!: KeyChainGroup;
    public params!: NetworkParameters;
    protected version: number = 0;
    protected signers: TransactionSigner[] = [];
	 
    public getNetworkParameters(): NetworkParameters {
        return this.params;
    }

    public addTransactionSigner(signer: TransactionSigner): void {
        this.lock.lock();
        try {
            if (signer.isReady()) {
                this.signers.push(signer);
            } else {
                throw new Error(`Signer instance is not ready to be added into Wallet: ${signer.constructor.name}`);
            }
        } finally {
            this.lock.unlock();
        }
    }

    public getTransactionSigners(): TransactionSigner[] {
        this.lock.lock();
        try {
            return [...this.signers];
        } finally {
            this.lock.unlock();
        }
    }

  
  public removeImportedKey(key: ECKey | PQKey): boolean {
    this.keyChainGroupLock.lock();
    try {
      return this.keyChainGroup.removeImportedKey(key);
    } finally {
      this.keyChainGroupLock.unlock();
    }
  }

    /**
     * Returns the imported PQ keys only (legacy EC keys excluded). Prefer
     * {@link #getAllImportedKeys()} when both key types must be considered.
     */
    public getImportedPQKeys(): PQKey[] {
        return this.getImportedKeys().filter(k => k instanceof PQKey);
    }

    /**
     * @deprecated Ambiguous name — returns PQ keys only. Use
     *             {@link #getImportedPQKeys()} (PQ only) or
     *             {@link #getAllImportedKeys()} (both key types).
     */
    public getImportedKeys(): PQKey[] {
        return this.getImportedPQKeys();
    }

    public getAllImportedKeys(): (ECKey | PQKey)[] {
        this.keyChainGroupLock.lock();
        try {
            return this.keyChainGroup.getImportedKeys();
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public importKey(key: ECKey | PQKey): boolean {
        return this.importKeys([key]) === 1;
    }

    public importKeys(keys: (ECKey | PQKey)[]): number {
        this.keyChainGroupLock.lock();
        let result: number;
        try {
            this.checkNoDeterministicKeys(keys);
            result = this.keyChainGroup.importKeys(...keys);
        } finally {
            this.keyChainGroupLock.unlock();
        }
        return result;
    }

    private checkNoDeterministicKeys(keys: (ECKey | PQKey)[]): void {
        for (const key of keys) {
            if (key instanceof DeterministicKey) {
                throw new Error("Cannot import HD keys back into the wallet");
            }
        }
    }

    public async importKeysAndEncrypt(keys: PQKey[], password: string): Promise<number> {
        await this.keyChainGroupLock.lock();
        try {
            const crypter = this.getKeyCrypter();
            if (!crypter) {
                throw new Error("Wallet is not encrypted");
            }
            const aesKey = await crypter.deriveKey(password);
            return this.importKeysAndEncryptWithAesKey(keys, aesKey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public importKeysAndEncryptWithAesKey(keys: PQKey[], aesKey: KeyParameter): number {
        this.keyChainGroupLock.lock();
        try {
            this.checkNoDeterministicKeys(keys);
            return this.keyChainGroup.importKeysAndEncrypt(keys, aesKey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public async findKeyFromPubHash(pubkeyHash: Uint8Array): Promise<ECKey | PQKey | null> {
        await this.keyChainGroupLock.lock();
        try {
            return this.keyChainGroup.findKeyFromPubHash(pubkeyHash);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public async findKeyFromPubKey(pubkey: Uint8Array): Promise<ECKey | PQKey | null> {
        await this.keyChainGroupLock.lock();
        try {
            return this.keyChainGroup.findKeyFromPubKey(pubkey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public async findRedeemDataFromScriptHash(payToScriptHash: Uint8Array): Promise<RedeemData | null> {
        await this.keyChainGroupLock.lock();
        try {
            return this.keyChainGroup.findRedeemDataFromScriptHash(payToScriptHash);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public async encrypt(password: string): Promise<void> {
        await this.keyChainGroupLock.lock();
        try {
            const scrypt = new KeyCrypterScrypt();
            const aesKey = await scrypt.deriveKey(password);
            this.keyChainGroup.encrypt(scrypt, aesKey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public encryptWithKey(keyCrypter: KeyCrypter, aesKey: KeyParameter): void {
        this.keyChainGroupLock.lock();
        try {
            this.keyChainGroup.encrypt(keyCrypter, aesKey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public async decrypt(password: string): Promise<void> {
        await this.keyChainGroupLock.lock();
        try {
            const crypter = this.keyChainGroup.getKeyCrypter();
            if (!crypter) {
                throw new Error("Not encrypted");
            }
            const aesKey = await crypter.deriveKey(password);
            this.keyChainGroup.decrypt(aesKey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public decryptWithKey(aesKey: KeyParameter): void {
        this.keyChainGroupLock.lock();
        try {
            this.keyChainGroup.decrypt(aesKey);
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public getKeyCrypter(): KeyCrypter | null {
        this.keyChainGroupLock.lock();
        try {
            return this.keyChainGroup.getKeyCrypter();
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public getEncryptionType(): EncryptionType {
        this.keyChainGroupLock.lock();
        try {
            const crypter = this.keyChainGroup.getKeyCrypter();
            if (crypter !== null) {
                return crypter.getUnderstoodEncryptionType();
            } else {
                return EncryptionType.UNENCRYPTED;
            }
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public isEncrypted(): boolean {
        return this.getEncryptionType() !== EncryptionType.UNENCRYPTED;
    }

    protected async serializeKeyChainGroupToProtobuf(): Promise<ProtosKey[]> {
        await this.keyChainGroupLock.lock();
        try {
            return this.keyChainGroup.toProtobuf();
        } finally {
            this.keyChainGroupLock.unlock();
        }
    }

    public saveToFile(temp: File, destFile: File): void {
        // Not implemented for now
    }

    public saveTo(stream: any): void {
        // Not implemented for now
    }

    public getParams(): NetworkParameters {
        return this.params;
    }

    public getVersion(): number {
        return this.version;
    }

    public setVersion(version: number): void {
        this.version = version;
    }

    public async signTransaction(tx: Transaction, aesKey: KeyParameter, missingSigsMode: any): Promise<void> {
        await this.lock.lock();
        try {
            const inputs = tx.getInputs();
            const outputs = tx.getOutputs();
            if (inputs.length === 0 || outputs.length === 0) {
                throw new Error("Transaction must have inputs and outputs");
            }

            const maybeDecryptingKeyBag = new DecryptingKeyBag(this, aesKey);

            for (const txIn of inputs) {
                const txOut = txIn.getConnectedOutput();
                if (txOut === null) {
                    continue;
                }
            }

            const proposal = new TransactionSigner.ProposedTransaction(tx);
            for (const signer of this.signers) {
                if (!await signer.signInputs(proposal, maybeDecryptingKeyBag)) {
                    // Remove WalletBase.log usage, fallback to console
                    console.info(`${signer.constructor.name} returned false for the tx`);
                }
            }

            await new MissingSigResolutionSigner(missingSigsMode).signInputs(proposal, maybeDecryptingKeyBag);
        } finally {
            this.lock.unlock();
        }
    }

    public async signTransactionWithAesKey(tx: Transaction, aesKey: KeyParameter): Promise<void> {
        // Use string literal for missingSigsMode, or pass null/undefined if not used
        await this.signTransaction(tx, aesKey, 'THROW');
    }

    public async walletKeys(aesKey: KeyParameter | null): Promise<PQKey[]> {
        const all = await this.walletKeysAll(aesKey);
        return all.filter(k => k instanceof PQKey);
    }

    /**
     * @deprecated Ambiguous name — returns PQ keys only. Use
     *             {@link #walletPQKeys(KeyParameter)} (PQ only) or
     *             {@link #walletKeysAll(KeyParameter)} (both key types).
     */
    public async walletPQKeys(aesKey: KeyParameter | null): Promise<PQKey[]> {
        return this.walletKeys(aesKey);
    }

    /**
     * Returns all keys in the wallet (both legacy EC and PQ), matching Java
     * WalletBase.walletKeysAll(KeyParameter).
     */
    public async walletKeysAll(aesKey: KeyParameter | null): Promise<(ECKey | PQKey)[]> {
        const maybeDecryptingKeyBag = new DecryptingKeyBag(this, aesKey);
        const walletKeys: (ECKey | PQKey)[] = [];
        for (const key of this.getAllImportedKeys()) {
            const decrypted = await maybeDecryptingKeyBag.maybeDecrypt(key);
            if (decrypted) {
                walletKeys.push(decrypted);
            }
        }
        return walletKeys;
    }

    public async walletKeysWithoutAesKey(): Promise<PQKey[]> {
        return await this.walletKeys(null);
    }

    public setServerURL(contextRoot: string): void {
        this.serverURL = contextRoot;
    }

    public getFee(): boolean {
        return this.fee;
    }

    public setFee(fee: boolean): void {
        this.fee = fee;
    }

    public getServerURL(): string {
        if (this.serverURL === null || this.serverURL === undefined) {
            throw new Error("No servers available");
        }
        return this.serverURL;
    }

    public getKeyChainGroup(): KeyChainGroup {
        return this.keyChainGroup;
    }
}
