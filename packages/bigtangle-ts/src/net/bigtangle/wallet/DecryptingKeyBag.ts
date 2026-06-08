import { ECKey } from '../core/ECKey';
import { KeyParameter } from '../crypto/KeyCrypter';
import { KeyBag } from './KeyBag';
import { RedeemData } from './RedeemData';

/**
 * A DecryptingKeyBag filters a pre-existing key bag, decrypting keys as they are requested using the provided
 * AES key. If the keys are encrypted and no AES key provided, {@link net.bigtangle.core.ECKey.KeyIsEncryptedException}
 * will be thrown.
 */
export class DecryptingKeyBag implements KeyBag {
    protected readonly target: KeyBag;
    protected readonly aesKey: KeyParameter | null;

    constructor(target: KeyBag, aesKey: KeyParameter | null) {
        this.target = target;
        this.aesKey = aesKey;
    }

    public async maybeDecrypt(key: ECKey | null): Promise<ECKey | null> {
        if (key === null) {
            return null;
        } else if (key.isEncrypted()) {
            if (this.aesKey === null) {
                throw new Error("KeyIsEncryptedException: Key is encrypted but no AES key provided.");
            }
            // Use the key's crypter if available, otherwise use default implementation
            const crypter = (key as any).getKeyCrypter?.() || null;
            return await key.decrypt(crypter, this.aesKey);
        } else {
            return key;
        }
    }

    private async maybeDecryptRedeemData(redeemData: RedeemData | null): Promise<RedeemData | null> {
        if (redeemData === null) return null;
        const decryptedKeys: ECKey[] = [];
        for (const key of redeemData.keys) {
            const decryptedKey = await this.maybeDecrypt(key);
            if (decryptedKey) {
                decryptedKeys.push(decryptedKey);
            }
        }
        // Assuming RedeemData.of can take an array of ECKey and a Script
        return RedeemData.of(decryptedKeys, redeemData.redeemScript);
    }

    public async findKeyFromPubHash(pubkeyHash: Uint8Array): Promise<ECKey | null> {
        const key = await this.target.findKeyFromPubHash(pubkeyHash);
        return await this.maybeDecrypt(key);
    }

    public async findKeyFromPubKey(pubkey: Uint8Array): Promise<ECKey | null> {
        const key = await this.target.findKeyFromPubKey(pubkey);
        return await this.maybeDecrypt(key);
    }

    public async findRedeemDataFromScriptHash(scriptHash: Uint8Array): Promise<RedeemData | null> {
        const data = await this.target.findRedeemDataFromScriptHash(scriptHash);
        return await this.maybeDecryptRedeemData(data);
    }
}
