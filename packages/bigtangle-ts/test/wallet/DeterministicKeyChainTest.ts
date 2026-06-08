import { Buffer } from 'buffer';
import { DeterministicKeyChain } from '../../src/net/bigtangle/wallet/DeterministicKeyChain';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { KeyPurpose } from '../../src/net/bigtangle/wallet/KeyChain';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { DeterministicKey } from '../../src/net/bigtangle/crypto/DeterministicKey';
import { ChildNumber } from '../../src/net/bigtangle/crypto/ChildNumber';
import { DeterministicSeed } from '../../src/net/bigtangle/wallet/DeterministicSeed';
import { describe, beforeEach, test, expect } from 'vitest';

describe('DeterministicKeyChainTest', () => {
    let chain: DeterministicKeyChain;
    const ENTROPY = Sha256Hash.hash(
        Buffer.from("don't use a string seed like this in real life"),
    )  ;

    beforeEach(async () => {
        const secs = 1389353062;
        const seed = await DeterministicSeed.fromEntropy(ENTROPY, "", secs);
        chain = new DeterministicKeyChain(MainNetParams.get(), seed);
        chain.setLookaheadSize(10);
    });

    test('derive', () => {
        const key1 = chain.getKey(KeyPurpose.RECEIVE_FUNDS);
        expect(key1.isPubKeyOnly()).toBe(false);
        const key2 = chain.getKey(KeyPurpose.RECEIVE_FUNDS);
        expect(key2.isPubKeyOnly()).toBe(false);

        // Verify keys can sign
        const hashBytes = new Uint8Array(32); // 32 zero bytes for hash simulation
        key1.sign(hashBytes);
        expect(key1.isPubKeyOnly()).toBe(false);
        key2.sign(hashBytes);
        expect(key2.isPubKeyOnly()).toBe(false);

        const key3 = chain.getKey(KeyPurpose.CHANGE);
        expect(key3.isPubKeyOnly()).toBe(false);
        key3.sign(hashBytes);
        expect(key3.isPubKeyOnly()).toBe(false);
    });

    test('random', async () => {
        const random = new Uint8Array(32); // 32 random bytes
        const seed = await DeterministicSeed.fromEntropy(random, "", Date.now() / 1000);
        chain = new DeterministicKeyChain(MainNetParams.get(), seed);
        chain.setLookaheadSize(10);
        
        const hashBytes = new Uint8Array(32); // 32 zero bytes for hash simulation
        chain.getKey(KeyPurpose.RECEIVE_FUNDS).sign(hashBytes);
        chain.getKey(KeyPurpose.CHANGE).sign(hashBytes);
    });

    test('hierarchy', async () => {
        const key = chain.getKeyByPath([
            ChildNumber.ZERO_HARDENED,
            ChildNumber.ZERO,
            ChildNumber.ZERO
        ]);
        expect(key).toBeInstanceOf(DeterministicKey);
    });
});
