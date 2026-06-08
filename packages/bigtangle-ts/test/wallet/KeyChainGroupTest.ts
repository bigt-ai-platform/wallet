import { KeyChainGroup } from '../../src/net/bigtangle/wallet/KeyChainGroup';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { KeyPurpose } from '../../src/net/bigtangle/wallet/KeyChain';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { KeyCrypterScrypt } from '../../src/net/bigtangle/crypto/KeyCrypterScrypt';
import { DeterministicKey } from '../../src/net/bigtangle/crypto/DeterministicKey';
import { describe, beforeEach, test, expect } from 'vitest';

describe('KeyChainGroupTest', () => {
    const LOOKAHEAD_SIZE = 5;
    const NETWORK_PARAMS = MainNetParams.get();
    let group: KeyChainGroup;

    // Valid private key (1 < key < N-1)
    const VALID_PRIVATE_KEY = BigInt('1234567890123456789012345678901234567890');

    beforeEach(() => {
        group = new KeyChainGroup(NETWORK_PARAMS);
        // Set lookahead size directly since setLookaheadSize() doesn't exist
        group.lookaheadSize = LOOKAHEAD_SIZE;
    });

    test('basic', () => {
        expect(group.numKeys()).toBe(0);
        group = new KeyChainGroup(NETWORK_PARAMS);
        group.lookaheadSize = LOOKAHEAD_SIZE;
        expect(group.numKeys()).toBe(0);
    });

    test('createBasic', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);
        group.importKeys(key);
        group.importKeys(key);
        expect(group.numKeys()).toBe(1);
    });

    test('currentKeys', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);
        expect(group.currentKey(KeyPurpose.RECEIVE_FUNDS)).toEqual(key);
        expect(group.currentKey(KeyPurpose.CHANGE)).toEqual(key);
    });

    test('freshKeys', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);
        group.importKeys(key);
        const key2 = group.freshKey(KeyPurpose.RECEIVE_FUNDS);
        expect(key2).not.toEqual(key);
        expect(group.currentKey(KeyPurpose.RECEIVE_FUNDS)).toEqual(key2);
    });

    test('freshAddresses', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);
        const addr = group.freshAddress(KeyPurpose.RECEIVE_FUNDS);
        expect(group.currentAddress(KeyPurpose.RECEIVE_FUNDS)).toEqual(addr);
    });

    test('importKeys', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        const num = group.importKeys(key);
        expect(num).toBe(1);
        expect(group.findKeyFromPubKey(key.getPubKey())).toEqual(key);
    });

    test('importKeysDuplicate', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);
        const num = group.importKeys(key);
        expect(num).toBe(0);
    });

    test('encryption', async () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);

        const scrypt = new KeyCrypterScrypt({ N: 2 });
        const aesKey = await scrypt.deriveKey('password');
        
        await group.encrypt(scrypt, aesKey);

        expect(group.isEncrypted()).toBe(true);
        const encryptedKey = group.getImportedKeys()[0];
        expect(encryptedKey.isEncrypted()).toBe(true);

        await group.decrypt(aesKey);
        
        expect(group.isEncrypted()).toBe(false);
        const decryptedKey = group.getImportedKeys()[0];
        expect(decryptedKey.isEncrypted()).toBe(false);
        expect(decryptedKey.getPrivKey()).toEqual(key.getPrivKey());
    });

    test('encryptionDecryptionFail', async () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);

        const scrypt = new KeyCrypterScrypt({ N: 2 });
        const aesKey = await scrypt.deriveKey('password');
        
        await group.encrypt(scrypt, aesKey);

        const wrongKey = await scrypt.deriveKey('WRONG PASSWORD');
        await expect(group.decrypt(wrongKey)).rejects.toThrow('bad decrypt');
    });

    test('removeImportedKey', () => {
        const key = ECKey.fromPrivate(VALID_PRIVATE_KEY);
        group.importKeys(key);
        expect(group.removeImportedKey(key)).toBe(true);
        expect(group.removeImportedKey(key)).toBe(false);
    });

    test('getKeyCrypter', async () => {
        const scrypt = new KeyCrypterScrypt({ N: 2 });
        const aesKey = await scrypt.deriveKey('password');
        
        await group.encrypt(scrypt, aesKey);
        
        expect(group.getKeyCrypter()).toEqual(scrypt);
    });

    test('findKeyFromPubKey', () => {
        const key = group.freshKey(KeyPurpose.RECEIVE_FUNDS) as ECKey;
        expect(group.findKeyFromPubKey(key.getPubKey())).toEqual(key);
    });

    test('findKeyFromPubKeyHash', () => {
        const key = group.freshKey(KeyPurpose.RECEIVE_FUNDS) as DeterministicKey;
        expect(group.findKeyFromPubHash(key.getPubKeyHash())).toEqual(key);
    });
});
