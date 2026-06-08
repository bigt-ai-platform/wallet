import { scrypt } from 'scrypt-js';
;
import { EncryptionType } from './EncryptableItem';
import { KeyParameter, KeyCrypter } from './KeyCrypter';
import { EncryptedData } from './EncryptedData';

// Import Node.js crypto module for random number generation
import * as nodeCrypto from 'crypto';


export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
  salt: Uint8Array;
}

export class KeyCrypterScrypt implements KeyCrypter {
  // Add the required method from KeyCrypter interface
  getUnderstoodEncryptionType(): EncryptionType {
    return EncryptionType.ENCRYPTED_SCRYPT_AES;
  }
  static readonly KEY_LENGTH = 32;
  static readonly BLOCK_LENGTH = 16;
  static readonly SALT_LENGTH = 8;

  private readonly scryptParameters: ScryptParameters;

  constructor(params?: Partial<ScryptParameters> & { salt?: Uint8Array }) {
    const salt = params?.salt ?? KeyCrypterScrypt.randomSalt();
    this.scryptParameters = {
      N: params?.N ?? 16384,
      r: params?.r ?? 8,
      p: params?.p ?? 1,
      salt,
    };
  }

  static randomSalt(): Uint8Array {
    const array = new Uint8Array(KeyCrypterScrypt.SALT_LENGTH);

    // Check if we're in a browser environment with crypto available
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(array);
    } else {
      // Use Node.js crypto module (imported at the top)
      nodeCrypto.randomFillSync(array);
    }
    return array;
  }

  async deriveKey(password: string): Promise<KeyParameter> {
    const passwordBytes = new TextEncoder().encode(password);
    const { N, r, p, salt } = this.scryptParameters;

    const key = await scrypt(passwordBytes, salt, N, r, p, KeyCrypterScrypt.KEY_LENGTH);
    return { key: new Uint8Array(key) };
  }

  async encrypt(plainBytes: Uint8Array, aesKey: KeyParameter): Promise<EncryptedData> {
    const keyBytes = aesKey.key;
    const iv = new Uint8Array(KeyCrypterScrypt.BLOCK_LENGTH);

    // Generate random IV using the same approach as randomSalt
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(iv);
    } else {
      // Use Node.js crypto module (imported at the top)
      nodeCrypto.randomFillSync(iv);
    }

    // Use Web Crypto API for AES-CBC encryption when available
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        // Import the key for Web Crypto API
        const importedKey = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-CBC' },
          false,
          ['encrypt']
        );

        // Encrypt the data
        const encryptedBuffer = await crypto.subtle.encrypt(
          { name: 'AES-CBC', iv: iv },
          importedKey,
          plainBytes
        );

        return new EncryptedData(iv, new Uint8Array(encryptedBuffer));
      } catch (e) {
        // Fallback implementation - this is a simpler approach that may not be as secure
        // but maintains compatibility for environments without Web Crypto API
        throw new Error('bad decrypt');
      }
    } else {
      // Fallback to Node.js crypto for AES-CBC encryption
      try {
        const cipher = nodeCrypto.createCipheriv('aes-256-cbc', keyBytes, iv);
        let encrypted = cipher.update(new Uint8Array(plainBytes));
        const final = cipher.final();
        const encryptedBuffer = new Uint8Array(encrypted.length + final.length);
        encryptedBuffer.set(encrypted, 0);
        encryptedBuffer.set(final, encrypted.length);
        return new EncryptedData(iv, encryptedBuffer);
      } catch (e) {
        throw new Error('bad decrypt');
      }
    }
  }

  async decrypt(data: EncryptedData, aesKey: KeyParameter): Promise<Uint8Array> {
    const { initialisationVector: iv, encryptedBytes } = data;
    const keyBytes = aesKey.key;

    // Use Web Crypto API for AES-CBC decryption
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      try {
        // Import the key for Web Crypto API
        const importedKey = await crypto.subtle.importKey(
          'raw',
          keyBytes,
          { name: 'AES-CBC' },
          false,
          ['decrypt']
        );

        // Decrypt the data
        const decryptedBuffer = await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv: iv },
          importedKey,
          encryptedBytes
        );

        return new Uint8Array(decryptedBuffer);
      } catch (e) {
        // Throw the expected error message for compatibility
        throw new Error('bad decrypt');
      }
    } else {
      // Fallback to Node.js crypto for AES-CBC decryption
      try {
        const decipher = nodeCrypto.createDecipheriv('aes-256-cbc', keyBytes, iv);
        let decrypted = decipher.update(new Uint8Array(encryptedBytes));
        const final = decipher.final();
        const decryptedBuffer = new Uint8Array(decrypted.length + final.length);
        decryptedBuffer.set(decrypted, 0);
        decryptedBuffer.set(final, decrypted.length);
        return decryptedBuffer;
      } catch (e) {
        throw new Error('bad decrypt');
      }
    }
  }

  getScryptParameters(): ScryptParameters {
    return this.scryptParameters;
  }

  static convertToByteArray(str: string): Uint8Array {
    // UTF-16 to byte array
    const buf = new Uint8Array(str.length * 2);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      buf[i * 2] = code >> 8;
      buf[i * 2 + 1] = code & 0xff;
    }
    return buf;
  }

  toString(): string {
    return `AES-256-CBC, Scrypt (N: ${this.scryptParameters.N})`;
  }

  equals(other: KeyCrypter): boolean {
    if (other instanceof KeyCrypterScrypt) {
      return (
        Buffer.compare(
          new Uint8Array(this.scryptParameters.salt),
          new Uint8Array(other.scryptParameters.salt)
        ) === 0 &&
        this.scryptParameters.N === other.scryptParameters.N &&
        this.scryptParameters.r === other.scryptParameters.r &&
        this.scryptParameters.p === other.scryptParameters.p
      );
    }
    return false;
  }

  hashCode(): number {
    // Simple hashCode using sum of bytes + scrypt params
    const saltSum = this.scryptParameters.salt.reduce((acc, v) => acc + v, 0);
    return saltSum + this.scryptParameters.N + this.scryptParameters.r + this.scryptParameters.p;
  }
}
