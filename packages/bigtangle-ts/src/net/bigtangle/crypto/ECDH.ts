import * as secp256k1 from 'secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import crypto from 'crypto';
import { DidKey } from './DidKey';

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

export interface ECDHEncryptedData {
  ephemeralPubKey: Uint8Array;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export class ECDH {
  public static deriveSharedSecret(
    myPrivKey: Uint8Array,
    peerPubKey: Uint8Array
  ): Uint8Array {
    try {
      return secp256k1.ecdh(peerPubKey, myPrivKey);
    } catch (e) {
      throw new Error('ECDH failed: ' + e);
    }
  }

  public static deriveSharedSecretFromDid(
    myPrivKey: Uint8Array,
    peerDid: string
  ): Uint8Array {
    const peerPubKey = DidKey.getPublicKeyBytes(peerDid);
    return ECDH.deriveSharedSecret(myPrivKey, peerPubKey);
  }

  public static encrypt(
    recipientPubKey: Uint8Array,
    data: Uint8Array
  ): ECDHEncryptedData {
    let ephemeralPriv = getRandomBytes(32);

    let privValid = false;
    let attempts = 0;
    while (!privValid && attempts < 100) {
      ephemeralPriv = getRandomBytes(32);
      if (secp256k1.privateKeyVerify(ephemeralPriv)) {
        privValid = true;
      }
      attempts++;
    }
    if (!privValid) {
      throw new Error('Failed to generate valid ephemeral private key');
    }

    const ephemeralPubKey = secp256k1.publicKeyCreate(ephemeralPriv, true);

    const sharedSecret = ECDH.deriveSharedSecret(ephemeralPriv, recipientPubKey);

    const info = new TextEncoder().encode('bigtangle-ts-ecdh-aes-256-gcm');
    const keyMaterial = hkdf(sha256, sharedSecret, undefined, info, 32);

    const iv = getRandomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', keyMaterial, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      ephemeralPubKey: new Uint8Array(ephemeralPubKey),
      iv,
      ciphertext: new Uint8Array(Buffer.concat([encrypted, authTag])),
    };
  }

  public static decrypt(
    myPrivKey: Uint8Array,
    encrypted: ECDHEncryptedData
  ): Uint8Array {
    const sharedSecret = ECDH.deriveSharedSecret(
      myPrivKey,
      encrypted.ephemeralPubKey
    );

    const info = new TextEncoder().encode('bigtangle-ts-ecdh-aes-256-gcm');
    const keyMaterial = hkdf(sha256, sharedSecret, undefined, info, 32);

    const authTag = encrypted.ciphertext.slice(-16);
    const ciphertext = encrypted.ciphertext.slice(0, -16);

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyMaterial, encrypted.iv);
    decipher.setAuthTag(Buffer.from(authTag));
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return new Uint8Array(decrypted);
  }

  public static serialize(encrypted: ECDHEncryptedData): Uint8Array {
    return concat(concat(encrypted.ephemeralPubKey, encrypted.iv), encrypted.ciphertext);
  }

  public static deserialize(data: Uint8Array): ECDHEncryptedData {
    if (data.length < 45) {
      throw new Error('Invalid encrypted data: too short');
    }
    const ephemeralPubKey = data.slice(0, 33);
    const iv = data.slice(33, 45);
    const ciphertext = data.slice(45);
    return { ephemeralPubKey, iv, ciphertext };
  }

  public static serializeToHex(encrypted: ECDHEncryptedData): string {
    const bytes = ECDH.serialize(encrypted);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  public static deserializeFromHex(hex: string): ECDHEncryptedData {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return ECDH.deserialize(bytes);
  }
}
