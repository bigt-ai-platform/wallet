
import { Buffer } from 'buffer';
import { KeyCrypterScrypt } from '../../src/net/bigtangle/crypto/KeyCrypterScrypt';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import { describe, beforeEach, test, expect } from 'vitest';

describe('KeyCrypterScryptTest', () => {
    const TEST_BYTES1 = Buffer.from([
        0, -101, 2, 103, -4, 105, 6, 107, 8, -109, 10, 111, -12, 113, 14, -115,
        16, 117, -18, 119, 20, 121, 22, 123, -24, 125, 26, 127, -28, 29, -30, 31,
    ]);

    const PASSWORD1 = 'aTestPassword';
    const PASSWORD2 = '0123456789';
    const WRONG_PASSWORD = 'thisIsTheWrongPassword';

    let keyCrypter: KeyCrypterScrypt;

    beforeEach(() => {
        keyCrypter = new KeyCrypterScrypt();
    });

    test('testKeyCrypterGood1', async () => {
        const key = await keyCrypter.deriveKey(PASSWORD1);
        const data = await keyCrypter.encrypt(TEST_BYTES1, key);
        expect(data).not.toBeNull();

        const reborn = await keyCrypter.decrypt(data, key);
        expect(Utils.HEX.encode(reborn)).toBe(Utils.HEX.encode(TEST_BYTES1));
    });

    test('testKeyCrypterGood2', async () => {
        const numberOfTests = 16;
        for (let i = 0; i < numberOfTests; i++) {
            const plainText =
                Math.random().toString(36).substring(2, 15) +
                Math.random().toString(36).substring(2, 15);
            const password =
                Math.random().toString(36).substring(2, 15) +
                Math.random().toString(36).substring(2, 15);

            const key = await keyCrypter.deriveKey(password);
            const data = await keyCrypter.encrypt(Buffer.from(plainText), key);
            expect(data).not.toBeNull();

            const reconstructedPlainBytes = await keyCrypter.decrypt(data, key);
            expect(Utils.HEX.encode(reconstructedPlainBytes)).toBe(
                Utils.HEX.encode(Buffer.from(plainText))
            );
        }
    }, 30000);

    test('testKeyCrypterWrongPassword', async () => {
        let builder = '';
        for (let i = 0; i < 100; i++) {
            builder += i + ' The quick brown fox';
        }

        const key = await keyCrypter.deriveKey(PASSWORD2);
        const data = await keyCrypter.encrypt(Buffer.from(builder), key);
        expect(data).not.toBeNull();

        try {
            const wrongKey = await keyCrypter.deriveKey(WRONG_PASSWORD);
            await keyCrypter.decrypt(data, wrongKey);
            throw new Error('Decrypt with wrong password did not throw exception');
        } catch (e) {
            expect(e).toBeInstanceOf(Error);
            expect((e as Error).message).toContain('bad decrypt');
        }
    });

    test('testEncryptDecryptBytes1', async () => {
        const key = await keyCrypter.deriveKey(PASSWORD1);
        const data = await keyCrypter.encrypt(TEST_BYTES1, key);
        expect(data).not.toBeNull();

        const rebornPlainBytes = await keyCrypter.decrypt(data, key);
        expect(Utils.HEX.encode(rebornPlainBytes)).toBe(
            Utils.HEX.encode(TEST_BYTES1)
        );
    });

    test('testEncryptDecryptBytes2', async () => {
        for (let i = 0; i < 50; i++) {
            const plainBytes = Buffer.alloc(i);
            for (let j = 0; j < i; j++) {
                plainBytes[j] = Math.floor(Math.random() * 256);
            }

            const key = await keyCrypter.deriveKey(PASSWORD1);
            const data = await keyCrypter.encrypt(plainBytes, key);
            expect(data).not.toBeNull();

            const rebornPlainBytes = await keyCrypter.decrypt(data, key);
            expect(Utils.HEX.encode(rebornPlainBytes)).toBe(
                Utils.HEX.encode(plainBytes)
            );
        }
    }, 30000);
});
