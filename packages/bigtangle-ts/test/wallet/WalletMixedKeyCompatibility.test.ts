import { describe, test, expect } from 'vitest';
import { ECKey, KeyType } from '../../src/net/bigtangle/core/ECKey';
import { PQKey } from '../../src/net/bigtangle/crypto/pq/PQKey';
import { Wallet } from '../../src/net/bigtangle/wallet/Wallet';
import { TestParams } from '../../src/net/bigtangle/params/TestParams';
import { Utils } from '../../src/net/bigtangle/utils/Utils';

/**
 * Compatibility tests for the mixed (EC + PQ) wallet and the legacy WIF
 * ("wallet key file") import/export path.
 *
 * Port of the Java test
 * ../blockchain/bigtangle-core/src/test/java/net/bigtangle/wallet/WalletMixedKeyCompatibilityTest.java
 */
describe('WalletMixedKeyCompatibility', () => {
    const params = TestParams.get();

    test('WIF round trip', () => {
        const key = ECKey.createNew();
        const wif = key.getPrivateKeyAsWiF(params);
        const restored = ECKey.fromWIF(params, wif);
        expect(restored.getPublicKeyAsHex()).toBe(key.getPublicKeyAsHex());
        expect(restored.toAddressString(params)).toBe(key.toAddressString(params));
    });

    test('WIF uncompressed round trip', () => {
        const key = ECKey.fromPrivate(ECKey.createNew().getPrivKeyBytes(), false);
        const wif = key.getPrivateKeyAsWiF(params);
        const restored = ECKey.fromWIF(params, wif);
        expect(Utils.HEX.encode(restored.getPrivKeyBytes())).toBe(Utils.HEX.encode(key.getPrivKeyBytes()));
        expect(restored.getPublicKeyAsHex()).toBe(key.getPublicKeyAsHex());
    });

    test('mixed wallet key management', async () => {
        const ecKey = ECKey.createNew();
        const pqKey = PQKey.createNew();

        // Old (EC-only) wallet
        const wallet = Wallet.fromKeys(params, ecKey);
        // Migration: import a PQ key into the existing wallet
        wallet.importKey(pqKey);

        // Both keys are present and addressable
        expect((await wallet.walletKeysAll(null)).length).toBe(2);

        const ec = await wallet.getECKey(null, ecKey.toAddressString(params));
        expect(ec).not.toBeNull();
        expect((ec as ECKey).getKeyType()).toBe(KeyType.EC);

        const pq = await wallet.getECKey(null, pqKey.toAddressString(params));
        expect(pq).not.toBeNull();
        expect((pq as PQKey).getKeyType()).toBe(KeyType.PQ);

        // Key lookup by pubkey hash works for both types
        expect(await wallet.findKeyFromPubHash(ecKey.getPubKeyHash())).not.toBeNull();
        expect(await wallet.findKeyFromPubHash(pqKey.getPubKeyHash())).not.toBeNull();
    });

    test('migrate legacy WIF wallet to mixed', async () => {
        // Legacy EC wallet: the private key is stored as WIF (the old "wallet key file")
        const legacyKey = ECKey.createNew();
        const wif = legacyKey.getPrivateKeyAsWiF(params);

        // Restore the legacy EC key from WIF into a fresh wallet, then add a PQ key
        const restored = ECKey.fromWIF(params, wif);
        const wallet = Wallet.fromKeys(params, restored);
        const pqKey = PQKey.createNew();
        wallet.importKey(pqKey);

        expect((await wallet.walletKeysAll(null)).length).toBe(2);
        expect(await wallet.findKeyFromPubHash(restored.getPubKeyHash())).not.toBeNull();
        expect(await wallet.findKeyFromPubHash(pqKey.getPubKeyHash())).not.toBeNull();
        expect(await wallet.getECKey(null, restored.toAddressString(params))).not.toBeNull();
        expect(await wallet.getECKey(null, pqKey.toAddressString(params))).not.toBeNull();
    });

    test('PQ key seed round trip', () => {
        const key = PQKey.createNew();
        const seedHex = key.getPrivateKeySeedAsHex();
        expect(seedHex).not.toBeNull();
        expect(seedHex!.length).toBe(64); // 32-byte ML-DSA seed

        const restored = PQKey.fromPrivateKeyHex(seedHex!);
        expect(Utils.HEX.encode(restored.getKeyBundleBytes())).toBe(Utils.HEX.encode(key.getKeyBundleBytes()));
        expect(restored.getPublicKeyAsHex()).toBe(key.getPublicKeyAsHex());
    });

    test('PQ dual key seed round trip', () => {
        const mlSeed = new Uint8Array(32);
        mlSeed[0] = 1;
        const slhSeed = new Uint8Array(32);
        slhSeed[0] = 2;
        const key = PQKey.fromSeeds(mlSeed, slhSeed);
        const seedHex = key.getPrivateKeySeedAsHex();
        expect(seedHex).not.toBeNull();
        expect(seedHex!.length).toBe(128); // 64-byte dual seed

        const restored = PQKey.fromPrivateKeyHex(seedHex!);
        expect(Utils.HEX.encode(restored.getKeyBundleBytes())).toBe(Utils.HEX.encode(key.getKeyBundleBytes()));
        expect(restored.getPublicKeyAsHex()).toBe(key.getPublicKeyAsHex());
    });
});