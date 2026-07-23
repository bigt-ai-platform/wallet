/**
 * WalletHelper.ts - Bigtangle wallet utilities
 *
 * Uses imports from bigtangle-ts to work in both Node.js and webpack environments.
 */

import { PQKey, Utils } from 'bigtangle-ts';
// @ts-ignore - These are not exported in index but exist in dist
import { KeyCrypterScrypt } from 'bigtangle-ts/dist/net/bigtangle/crypto/KeyCrypterScrypt';
// @ts-ignore
import { EncryptedData } from 'bigtangle-ts/dist/net/bigtangle/crypto/EncryptedData';
// @ts-ignore
import { Wallet } from 'bigtangle-ts/dist/net/bigtangle/wallet/Wallet';

export interface CredentialEntry {
  url: string;
  user: string;
  password: string;
}

export interface Key {
  readonly address: string;
  readonly privateKey: string;
}

export interface WalletFile {
  wallet: Key;
  credentials: CredentialEntry;
}

export interface SerializedWallet {
  keys: Array<{ address: string; privateKey: string }>;
  credentials: CredentialEntry;
}

// Default context root for bigtangle network
const DEFAULT_CONTEXT_ROOT = 'http://localhost:8088/';

/**
 * Generate random bytes using crypto API
 */
function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback for environments without crypto
    for (let i = 0; i < length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

// Use bigtangle-ts PQKey for wallet creation
export async function createWallet(): Promise<WalletFile> {
  const pqKey = PQKey.createNew();

  const address = pqKey.toAddressHex();
  const privateKey = pqKey.getPrivateKeyHex();

  const wallet: Key = {
    address,
    privateKey,
  };

  const credentials: CredentialEntry = {
    url: 'https://wallet.bigt.ai',
    user: address + '@bigt.ai',
    password: Utils.HEX.encode(getRandomBytes(32)),
  };

  return { wallet, credentials };
}

export async function saveKeyToFile(
  walletFile: WalletFile,
  _password: string,
): Promise<string> {
  const serialized: SerializedWallet = {
    keys: [
      {
        address: walletFile.wallet.address,
        privateKey: walletFile.wallet.privateKey,
      },
    ],
    credentials: walletFile.credentials,
  };

  const raw = JSON.stringify(serialized, null, 2);

  // Convert string to Uint8Array for encryption
  const encoder = new TextEncoder();
  const plainBytes = encoder.encode(raw);

  const keyCrypter = new KeyCrypterScrypt();
  const key = await keyCrypter.deriveKey(_password);
  const encryptedData = await keyCrypter.encrypt(plainBytes, key);

  // Serialize the EncryptedData object to a JSON-safe format
  const scryptParams = keyCrypter.getScryptParameters();
  const output = {
    salt: Utils.HEX.encode(scryptParams.salt),
    iv: Utils.HEX.encode(encryptedData.initialisationVector),
    data: Utils.HEX.encode(encryptedData.encryptedBytes),
    N: scryptParams.N,
    r: scryptParams.r,
    p: scryptParams.p,
  };

  return JSON.stringify(output, null, 2);
}

export async function loadWallet(
  fileData: string,
  _password: string,
): Promise<WalletFile> {
  // Parse the encrypted file format
  const encrypted = JSON.parse(fileData);

  // Reconstruct scrypt parameters with the saved salt
  const keyCrypter = new KeyCrypterScrypt({
    salt: Utils.HEX.decode(encrypted.salt),
    N: encrypted.N,
    r: encrypted.r,
    p: encrypted.p,
  });

  // Derive the key using the same parameters
  const tmpkey = await keyCrypter.deriveKey(_password);

  // Reconstruct the EncryptedData object
  const encryptedData = new EncryptedData(
    Utils.HEX.decode(encrypted.iv),
    Utils.HEX.decode(encrypted.data),
  );

  // Decrypt the data
  const decryptedBytes = await keyCrypter.decrypt(encryptedData, tmpkey);

  // Convert Uint8Array back to string
  const decoder = new TextDecoder();
  const raw = decoder.decode(decryptedBytes);

  const parsed: SerializedWallet = JSON.parse(raw);

  if (!parsed.keys?.length) {
    throw new Error('No key found in wallet file');
  }

  const keyData = parsed.keys[0];

  // Recreate PQKey and address from the stored private key
  const rawKey = Utils.HEX.decode(keyData.privateKey);
  const pqKey = PQKey.fromPrivateKey(rawKey);

  const wallet: Key = {
    address: pqKey.toAddressHex(),
    privateKey: pqKey.getPrivateKeyHex(),
  };

  return {
    wallet,
    credentials: parsed.credentials,
  };
}

/**
 * Import a wallet from a PQ private key hex string
 */
export async function importPrivateKey(
  privateKeyInput: string,
): Promise<WalletFile> {
  const cleanInput = privateKeyInput.trim().replace(/\s+/g, '');
  const raw = Utils.HEX.decode(cleanInput);

  const pqKey = PQKey.fromPrivateKey(raw);

  const address = pqKey.toAddressHex();
  const privateKey = pqKey.getPrivateKeyHex();

  const wallet: Key = {
    address,
    privateKey,
  };

  const credentials: CredentialEntry = {
    url: 'https://wallet.bigt.ai',
    user: address + '@bigt.ai',
    password: Utils.HEX.encode(getRandomBytes(32)),
  };

  return { wallet, credentials };
}

/**
 * Create a bigtangle-ts Wallet instance from a WalletFile
 * Uses ECKey derived from PQ key material for Wallet compatibility
 */
export async function createBigtangleWallet(
  walletFile: WalletFile,
  contextRoot: string = DEFAULT_CONTEXT_ROOT,
): Promise<any> {
  const { TestParams } = await import('bigtangle-ts');
  const { Wallet: BtWallet } = await import('bigtangle-ts/dist/net/bigtangle/wallet/Wallet');

  const params = TestParams.get();
  const btWallet = await BtWallet.fromKeysURL(params, [], contextRoot);

  return btWallet;
}

/**
 * Get the default context root URL
 */
export function getDefaultContextRoot(): string {
  return DEFAULT_CONTEXT_ROOT;
}
