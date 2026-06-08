// ECIESCoder.ts
// TypeScript translation of bigtangle-core/src/main/java/net/bigtangle/crypto/ECIESCoder.java
// Uses imports from core, utils, exception, params, script


import { InvalidTransactionDataException } from '../exception/Exceptions';

// You may need to install a library for ECIES, e.g., 'eciesjs' or implement the logic using 'elliptic' and 'crypto'.
// Here, we use 'eciesjs' for simplicity. If you want a pure implementation, let me know.


export class ECIESCoder {
    /**
     * Encrypts data using the recipient's public key (ECKey).
     * @param pubKeyPoint The public key point (Buffer or Uint8Array)
     * @param data The data to encrypt (Buffer or Uint8Array)
     * @returns The encrypted data (Buffer)
     */
    public static async encrypt(pubKeyPoint: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
        throw new InvalidTransactionDataException('ECIES encryption not implemented: eciesjs library removed');
    }

    /**
     * Decrypts data using the recipient's private key (Buffer or Uint8Array)
     * @param privKey The private key (Buffer or Uint8Array)
     * @param encrypted The encrypted data (Buffer or Uint8Array)
     * @returns The decrypted data (Buffer)
     */
    public static async decrypt(privKey: Uint8Array, encrypted: Uint8Array): Promise<Uint8Array> {
        throw new InvalidTransactionDataException('ECIES decryption not implemented: eciesjs library removed');
    }
}
