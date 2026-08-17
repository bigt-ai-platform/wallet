import { describe, test, expect } from 'vitest';
import { ECKey, KeyType } from '../../src/net/bigtangle/core/ECKey';
import { TestParams } from '../../src/net/bigtangle/params/TestParams';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import { Address } from '../../src/net/bigtangle/core/Address';
import { TransactionSignature } from '../../src/net/bigtangle/crypto/TransactionSignature';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { TransactionOutPoint } from '../../src/net/bigtangle/core/TransactionOutPoint';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { ScriptBuilder } from '../../src/net/bigtangle/script/ScriptBuilder';
import { Script } from '../../src/net/bigtangle/script/Script';

function hashOf(fill: number): Sha256Hash {
    return new Sha256Hash(new Uint8Array(32).fill(fill));
}

describe('ECKey', () => {
    const params = TestParams.get();

    test('getKeyType returns EC', () => {
        expect(ECKey.createNew().getKeyType()).toBe(KeyType.EC);
    });

    test('creates a new key with private bytes', () => {
        const key = ECKey.createNew();
        expect(key.hasPrivKey()).toBe(true);
        expect(key.hasPrivateKey()).toBe(true);
        expect(key.getPrivKeyBytes().length).toBe(32);
        expect(key.isPubKeyOnly()).toBe(false);
        expect(key.isWatching()).toBe(false);
        expect(key.isCompressed()).toBe(true);
        expect(ECKey.isPubKeyCanonical(key.getPubKey())).toBe(true);
    });

    test('known private key derives known public key', () => {
        // Bitcoin wiki vector: privkey for 1PMycacnJaSqwwJqjawXBErnLsZ7RkXUAs (compressed)
        const privHex = '18e14a7b6a307f426a94f8114701e7c8e774e7f9a47e2c2035db29a206321725';
        const key = ECKey.fromPrivateString(privHex);
        expect(key.getPublicKeyAsHex()).toBe(
            '0250863ad64a87ae8a2fe83c1af1a8403cb53f53e486d8511dad8a04887e5b2352'
        );
    });

    test('signs and verifies', () => {
        const key = ECKey.createNew();
        const hash = hashOf(0xAB);
        const sig = key.sign(hash);
        expect(sig).toBeInstanceOf(TransactionSignature);
        expect(ECKey.verify(hash.getBytes(), sig, key.getPubKey())).toBe(true);
        // Tampered hash must not verify
        expect(ECKey.verify(hashOf(0xCD).getBytes(), sig, key.getPubKey())).toBe(false);
    });

    test('signature is deterministic (RFC6979) and canonical', () => {
        const key = ECKey.fromPrivate(0x1f2f3f4f5f6f7f8f9fafbfcfdfefffn);
        const hash = hashOf(0x11);
        const sig1 = key.sign(hash);
        const sig2 = key.sign(hash);
        expect(sig1.r).toBe(sig2.r);
        expect(sig1.s).toBe(sig2.s);
        expect(sig1.isCanonical()).toBe(true);
    });

    test('address is legacy base58 with 20-byte hash160', () => {
        const key = ECKey.createNew();
        const addr = key.toAddress(params);
        expect(addr.getHash160().length).toBe(20);
        expect(addr.equals(Address.fromP2PKH(params, key.getPubKeyHash()))).toBe(true);
        expect(addr.toBase58()).toBe(key.toAddressString(params));
    });

    test('round trips from private bytes', () => {
        const key = ECKey.createNew();
        const restored = ECKey.fromPrivate(key.getPrivKeyBytes());
        expect(restored.getPublicKeyAsHex()).toBe(key.getPublicKeyAsHex());
        expect(Utils.HEX.encode(restored.getPubKeyHash())).toBe(Utils.HEX.encode(key.getPubKeyHash()));
    });

    test('WIF round trip', () => {
        const key = ECKey.createNew();
        const wif = key.getPrivateKeyAsWiF(params);
        const restored = ECKey.fromWIF(params, wif);
        expect(restored.getPublicKeyAsHex()).toBe(key.getPublicKeyAsHex());
        expect(restored.getPrivKey()).toBe(key.getPrivKey());
        expect(restored.isCompressed()).toBe(key.isCompressed());
    });

    test('fromPublicOnly creates a verification-only key', () => {
        const key = ECKey.createNew();
        const pubOnly = ECKey.fromPublicOnly(key.getPubKey());
        expect(pubOnly.hasPrivKey()).toBe(false);
        expect(pubOnly.isPubKeyOnly()).toBe(true);
        expect(pubOnly.isWatching()).toBe(true);
        expect(Utils.HEX.encode(pubOnly.getPubKeyHash())).toBe(Utils.HEX.encode(key.getPubKeyHash()));

        const hash = hashOf(0xEF);
        const sig = key.sign(hash);
        expect(ECKey.verify(hash.getBytes(), sig, pubOnly.getPubKey())).toBe(true);
    });

    test('instance verify accepts bitcoin-encoded (DER + sighash) signatures', () => {
        const key = ECKey.createNew();
        const hash = hashOf(0x22);
        const sig = key.sign(hash);
        const bitcoinEncoded = sig.encodeToBitcoin();
        expect(key.verify(hash, sig)).toBe(true);
        expect(key.verify(hash.getBytes(), bitcoinEncoded)).toBe(true);
        expect(key.verify(hashOf(0x33).getBytes(), bitcoinEncoded)).toBe(false);
    });

    test('isPubKeyCanonical rejects malformed pubkeys', () => {
        expect(ECKey.isPubKeyCanonical(ECKey.createNew().getPubKey())).toBe(true);
        expect(ECKey.isPubKeyCanonical(new Uint8Array([0x04, 1, 2]))).toBe(false);
        expect(ECKey.isPubKeyCanonical(new Uint8Array([0x05, 1]))).toBe(false);
    });

    test('missing private key throws on sign', () => {
        const pubOnly = ECKey.fromPublicOnly(ECKey.createNew().getPubKey());
        expect(() => pubOnly.sign(hashOf(0x01))).toThrow();
    });

    test('testEcScriptVerify - EC script signing and spending', async () => {
        const key = ECKey.createNew();
        const scriptPubKey = ScriptBuilder.createOutputScript(key);

        const tx = new Transaction(params);
        tx.addOutput(new TransactionOutput(params, tx, Coin.COIN, scriptPubKey.getProgram()));
        const input = await tx.addSignedInput(
            TransactionOutPoint.fromTransactionOutPoint4(params, 0, Sha256Hash.ZERO_HASH, Sha256Hash.ZERO_HASH),
            scriptPubKey,
            key
        );
        expect(input).toBeDefined();
        await input.getScriptSig().correctlySpends(tx, 0, scriptPubKey, new Set<Script.VerifyFlag>());
    });
});