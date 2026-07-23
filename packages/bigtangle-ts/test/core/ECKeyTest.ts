import { Sha256Hash } from "../../src/net/bigtangle/core/Sha256Hash";
import { MainNetParams } from "../../src/net/bigtangle/params/MainNetParams";
import { PQKey } from "../../src/net/bigtangle/crypto/pq/PQKey";
import { SignatureBundle } from "../../src/net/bigtangle/crypto/pq/SignatureBundle";
import { Utils } from "../../src/net/bigtangle/utils/Utils";
import { Address } from "../../src/net/bigtangle/core/Address";
import { KeyCrypterScrypt } from "../../src/net/bigtangle/crypto/KeyCrypterScrypt";
import { KeyCrypter } from "../../src/net/bigtangle/crypto/KeyCrypter";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";
import { describe, beforeEach, test, expect } from "vitest";

function createTestKey(seedByte: number): PQKey {
  const seed = new Uint8Array(64);
  seed[63] = seedByte;
  return PQKey.fromKeyMaterial(seed);
}

describe("PQKeyTest", () => {
  const PASSWORD1 = "my hovercraft has eels";
  const WRONG_PASSWORD = "it is a snowy day today";
  let keyCrypter: KeyCrypter;

  beforeEach(() => {
    keyCrypter = new KeyCrypterScrypt();
  });

  test("testSignatures", async () => {
    const key = createTestKey(1);
    const hash = Sha256Hash.ZERO_HASH;
    const sig = await key.signWithAesKey(hash, null);
    expect(PQKey.verify(hash, sig, key.getPublicKeyBytes())).toBe(true);
  }, 30000);

  test("testAddress", async () => {
    const key = createTestKey(10);
    const addrHex = key.toAddressWithParams(MainNetParams.get()).toHex();
    expect(addrHex.length).toBe(70);
  });

  test("testUnencryptedCreate", async () => {
    const key = PQKey.createNew();
    const time = key.getCreationTimeSeconds();
    expect(time).not.toBe(0);
    expect(key.isEncrypted()).toBe(false);
    const originalPrivateKeyBytes = key.getSecretBytes();
    expect(originalPrivateKeyBytes).not.toBeNull();
    const aesKey = await keyCrypter.deriveKey(PASSWORD1);
    const encryptedKey = await key.encrypt(keyCrypter, aesKey);
    expect(encryptedKey.getCreationTimeSeconds()).toBe(time);
    expect(encryptedKey.isEncrypted()).toBe(true);
    const decryptedKey = await encryptedKey.decrypt(keyCrypter, aesKey);
    expect(decryptedKey.isEncrypted()).toBe(false);
    expect(
      Utils.arraysEqual(originalPrivateKeyBytes!, decryptedKey.getSecretBytes()!)
    ).toBe(true);
  });

  test("testEncryptedCreate", async () => {
    const unencryptedKey = PQKey.createNew();
    const originalPrivateKeyBytes = unencryptedKey.getSecretBytes();
    expect(originalPrivateKeyBytes).not.toBeNull();
    const aesKey = await keyCrypter.deriveKey(PASSWORD1);
    const encryptedKey = await unencryptedKey.encrypt(keyCrypter, aesKey);
    expect(encryptedKey.isEncrypted()).toBe(true);
    const rebornUnencryptedKey = await encryptedKey.decrypt(keyCrypter, aesKey);
    expect(rebornUnencryptedKey.isEncrypted()).toBe(false);
    expect(
      Utils.arraysEqual(
        originalPrivateKeyBytes!,
        rebornUnencryptedKey.getSecretBytes()!
      )
    ).toBe(true);
  });

  test("testEncryptionIsReversible", async () => {
    const originalUnencryptedKey = PQKey.createNew();
    const aesKey1 = await keyCrypter.deriveKey(PASSWORD1);
    const encryptedKey = await originalUnencryptedKey.encrypt(
      keyCrypter,
      aesKey1
    );
    expect(encryptedKey.isEncrypted()).toBe(true);

    const decrypted = await encryptedKey.decrypt(keyCrypter, aesKey1);
    expect(decrypted.isEncrypted()).toBe(false);
    expect(
      Utils.arraysEqual(
        originalUnencryptedKey.getSecretBytes()!,
        decrypted.getSecretBytes()!
      )
    ).toBe(true);

    const aesKey2 = await keyCrypter.deriveKey(WRONG_PASSWORD);
    await expect(encryptedKey.decrypt(keyCrypter, aesKey2)).rejects.toThrow();
  });

  test("testGetPublicKeyAsHex", () => {
    const key = createTestKey(10);
    const hex = key.getPublicKeyAsHex();
    expect(hex.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(hex)).toBe(true);
  });
});
