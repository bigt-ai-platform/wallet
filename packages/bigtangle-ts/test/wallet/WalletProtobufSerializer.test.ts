import { describe, test, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { Wallet } from '../../src/net/bigtangle/wallet/Wallet';
import { WalletProtobufSerializer } from '../../src/net/bigtangle/wallet/WalletProtobufSerializer';
import { UnreadableWalletException } from '../../src/net/bigtangle/wallet/UnreadableWalletException';
import { TestParams } from '../../src/net/bigtangle/params/TestParams';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { KeyType } from '../../src/net/bigtangle/wallet/Protos';
import {
    concat,
    encodeLengthDelimitedField,
    encodeMessageField,
    encodeStringField,
    encodeVarintField,
} from '../../src/net/bigtangle/wallet/Protobuf';

/**
 * Port of the Java test
 * ../blockchain/bigtangle-core/src/test/java/net/bigtangle/wallet/WalletProtobufSerializerTest.java
 * (removed from the Java codebase in commit 95a79301c "remove proto").
 */
describe('WalletProtobufSerializer', () => {
    const params: NetworkParameters = TestParams.get();
    const serializer = new WalletProtobufSerializer();

    function roundTrip(wallet: Wallet): Wallet {
        const bytes = serializer.writeWallet(wallet);
        expect(WalletProtobufSerializer.isWallet(bytes)).toBe(true);
        return serializer.readWallet(bytes);
    }

    test('round trip normal wallet', async () => {
        const myKey = new ECKey();
        myKey.setCreationTimeSeconds(123456789);
        const myWallet = Wallet.fromKeys(params, myKey);

        const wallet1 = roundTrip(myWallet);

        const key = await wallet1.findKeyFromPubHash(myKey.getPubKeyHash());
        expect(key).not.toBeNull();
        expect((key as ECKey).getPubKey()).toEqual(myKey.getPubKey());
        expect((key as ECKey).getPrivKeyBytes()).toEqual(myKey.getPrivKeyBytes());
        expect((key as ECKey).getCreationTimeSeconds()).toBe(myKey.getCreationTimeSeconds());
    });

    test('round trip many keys', async () => {
        for (let i = 0; i < 5; i++) {
            const myKey = new ECKey();
            const myWallet = Wallet.fromKeys(params, myKey);

            const wallet1 = roundTrip(myWallet);
            const key = await wallet1.findKeyFromPubHash(myKey.getPubKeyHash());
            expect(key).not.toBeNull();
            expect((key as ECKey).getPubKey()).toEqual(myKey.getPubKey());
            expect((key as ECKey).getPrivKeyBytes()).toEqual(myKey.getPrivKeyBytes());
        }
    });

    test('round trip watched (public-only) key', async () => {
        const privateKey = new ECKey();
        const watchedKey = ECKey.fromPublicOnly(privateKey.getPubKey());
        const myWallet = Wallet.fromKeys(params, watchedKey);

        const wallet1 = roundTrip(myWallet);

        const key = await wallet1.findKeyFromPubHash(watchedKey.getPubKeyHash());
        expect(key).not.toBeNull();
        expect((key as ECKey).getPubKey()).toEqual(watchedKey.getPubKey());
        expect((key as ECKey).hasPrivKey()).toBe(false);
    });

    test('round trip encrypted wallet', async () => {
        const myKey = new ECKey();
        const myWallet = Wallet.fromKeys(params, myKey);
        await myWallet.encrypt('password');

        const wallet1 = roundTrip(myWallet);
        expect(wallet1.isEncrypted()).toBe(true);

        const crypter = wallet1.getKeyCrypter();
        expect(crypter).not.toBeNull();
        const aesKey = await crypter!.deriveKey('password');
        const keys = await wallet1.walletKeysAll(aesKey);
        expect(keys.length).toBe(1);
        expect((keys[0] as ECKey).getPubKey()).toEqual(myKey.getPubKey());
        expect((keys[0] as ECKey).getPrivKeyBytes()).toEqual(myKey.getPrivKeyBytes());
    });

    test('parseToProto returns the protobuf representation', async () => {
        const myKey = new ECKey();
        const myWallet = Wallet.fromKeys(params, myKey);
        const bytes = serializer.writeWallet(myWallet);

        const proto = WalletProtobufSerializer.parseToProto(bytes);
        expect(proto.network_identifier).toBe(params.getId());
        expect(proto.key.length).toBe(1);
        expect(proto.key[0].type).toBe(KeyType.ORIGINAL);
        expect(proto.key[0].public_key).toEqual(myKey.getPubKey());
        expect(proto.key[0].secret_bytes).toEqual(myKey.getPrivKeyBytes());
    });

    test('isWallet', () => {
        const myKey = new ECKey();
        const bytes = serializer.writeWallet(Wallet.fromKeys(params, myKey));
        expect(WalletProtobufSerializer.isWallet(bytes)).toBe(true);
        expect(WalletProtobufSerializer.isWallet(new Uint8Array([1, 2, 3, 4, 5]))).toBe(false);
        expect(WalletProtobufSerializer.isWallet(new Uint8Array(0))).toBe(false);
    });

    test('rejects a future wallet version', () => {
        const bytes = concat(
            encodeStringField(1, params.getId()),
            encodeVarintField(7, WalletProtobufSerializer.CURRENT_WALLET_VERSION + 1),
        );
        expect(() => serializer.readWallet(bytes)).toThrow(UnreadableWalletException.FutureVersion);
    });

    test('rejects an unknown network identifier', () => {
        const bytes = encodeStringField(1, 'not-a-network');
        expect(() => serializer.readWallet(bytes)).toThrow(/Unknown network parameters ID not-a-network/);
    });

    test('rejects a key without a public key', () => {
        const keyMsg = encodeVarintField(1, KeyType.ORIGINAL);
        const bytes = concat(
            encodeStringField(1, params.getId()),
            encodeMessageField(3, keyMsg),
        );
        expect(() => serializer.readWallet(bytes)).toThrow(/Public key missing/);
    });

    test('java-style network identifiers are accepted', async () => {
        const myKey = new ECKey();
        const javaStyleBytes = concat(
            encodeStringField(1, 'Mainnet'),
            encodeMessageField(3, concat(
                encodeVarintField(1, KeyType.ORIGINAL),
                encodeLengthDelimitedField(2, myKey.getPrivKeyBytes()),
                encodeLengthDelimitedField(3, myKey.getPubKey()),
            )),
        );
        const wallet = serializer.readWallet(javaStyleBytes);
        const keys = await wallet.walletKeysAll(null);
        expect(keys.length).toBe(1);
        expect((keys[0] as ECKey).getPubKey()).toEqual(myKey.getPubKey());
        expect((keys[0] as ECKey).getPrivKeyBytes()).toEqual(myKey.getPrivKeyBytes());
    });

    test('imports a real legacy .wallet file', async () => {
        const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '../oldwallet/cui.wallet');
        const bytes = readFileSync(fixturePath);

        expect(WalletProtobufSerializer.isWallet(bytes)).toBe(true);

        const proto = WalletProtobufSerializer.parseToProto(bytes);
        expect(proto.network_identifier).toBe('Mainnet');
        expect(proto.key.length).toBe(1);
        expect(proto.key[0].type).toBe(KeyType.ORIGINAL);

        const wallet = serializer.readWallet(bytes);
        expect(wallet.getParams().getId()).toBe(NetworkParameters.ID_MAINNET);
        expect(wallet.isEncrypted()).toBe(false);

        const keys = await wallet.walletKeysAll(null);
        expect(keys.length).toBe(1);
        const key = keys[0] as ECKey;
        expect(key.getKeyType()).toBe('EC');
        expect(key.hasPrivKey()).toBe(true);
        expect(Buffer.from(key.getPubKey()).toString('hex')).toBe(
            '0313cc12a9aff668892f1819191153ff5ffdb9b295babc38ac3562244468e2c2b8'
        );
        expect(Buffer.from(key.getPrivKeyBytes()).toString('hex')).toBe(
            'f4bd5a6642070308b746941894617ca1a5bdf12d605ae1d9ca9adaf71e52b94f'
        );
    });
});
