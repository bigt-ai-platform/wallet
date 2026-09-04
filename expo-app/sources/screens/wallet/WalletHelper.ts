/**
 * WalletHelper.ts - Bigtangle wallet utilities
 *
 * Uses imports from bigtangle-ts to work in both Node.js and webpack environments.
 */
import i18n from '../../lib/i18n';

import { PQKey, Utils, ECKey, Address, MainNetParams, TestParams } from 'bigtangle-ts';
// @ts-ignore - These are not exported in index but exist in dist
import { KeyCrypterScrypt } from 'bigtangle-ts/dist/net/bigtangle/crypto/KeyCrypterScrypt';
// @ts-ignore
import { EncryptedData } from 'bigtangle-ts/dist/net/bigtangle/crypto/EncryptedData';
// @ts-ignore
import { Wallet } from 'bigtangle-ts/dist/net/bigtangle/wallet/Wallet';
// @ts-ignore
import { WalletProtobufSerializer } from 'bigtangle-ts/dist/net/bigtangle/wallet/WalletProtobufSerializer';

export interface CredentialEntry {
  url: string;
  user: string;
  password: string;
}

export interface Key {
  readonly address: string;
  readonly pubkey: string;
  readonly privateKey: string;
  /** Key algorithm: post-quantum (default) or legacy secp256k1 (old .wallet import). */
  readonly keyType?: 'PQ' | 'EC';
  /** Network the address was derived on (EC keys only). */
  readonly network?: string;
}

export interface WalletFile {
  wallet: Key;
  /** Optional wallet.bigt.ai web-login credentials (no longer generated for new wallets). */
  credentials?: CredentialEntry;
}

export interface SerializedWallet {
  keys: Array<{
    address: string;
    pubkey: string;
    privateKey: string;
    keyType?: string;
    network?: string;
  }>;
  credentials?: CredentialEntry;
}

/**
 * True for an unencrypted wallet JSON ({@link SerializedWallet} with `keys[]`
 * and no `salt`/`data`). Such wallets need no password to load/unlock.
 */
export function isPlainWalletJson(content: string): boolean {
  try {
    const root = JSON.parse(content);
    return !!root?.keys?.length && root.salt === undefined && root.data === undefined;
  } catch {
    return false;
  }
}

// Default context root for bigtangle network
const DEFAULT_CONTEXT_ROOT = 'http://localhost:8088/';

/**
 * Base58 on-chain address of a PQ key (the format the server stores/expects —
 * e.g. getOutputsHistory). Test-net encoding matches the local test infra and
 * the TestKeys addresses (m…/n… prefix).
 */
function pqKeyAddress(pqKey: PQKey): string {
  return Address.fromP2PKH(TestParams.get(), pqKey.getPubKeyHash()).toBase58();
}

// Use bigtangle-ts PQKey for wallet creation
export async function createWallet(): Promise<WalletFile> {
  const pqKey = PQKey.createNew();

  const address = pqKeyAddress(pqKey);
  const pubkey = Utils.HEX.encode(pqKey.getPrefixedPublicKeyBytes());
  const privateKey = pqKey.getPrivateKeyHex();

  const wallet: Key = {
    address,
    pubkey,
    privateKey,
  };

  return { wallet };
}

export async function saveKeyToFile(
  walletFile: WalletFile,
  _password: string,
): Promise<string> {
  const keyEntry: SerializedWallet['keys'][number] = {
    address: walletFile.wallet.address,
    pubkey: walletFile.wallet.pubkey,
    privateKey: walletFile.wallet.privateKey,
    keyType: walletFile.wallet.keyType ?? 'PQ',
    network: walletFile.wallet.network,
  };
  const serialized: SerializedWallet = { keys: [keyEntry] };
  // wallets created without credentials (new format) keep the file credential-free
  if (walletFile.credentials) {
    serialized.credentials = walletFile.credentials;
  }

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
  const parsedRoot = JSON.parse(fileData);

  let parsed: SerializedWallet;
  if (parsedRoot.salt !== undefined && parsedRoot.data !== undefined) {
    // Encrypted wallet-file format (saveKeyToFile output): salt/iv/data/N/r/p.
    const encrypted = parsedRoot;

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

    parsed = JSON.parse(raw);
  } else if (parsedRoot.keys?.length) {
    // Plain SerializedWallet JSON (already unencrypted) — accept it directly.
    parsed = parsedRoot;
  } else {
    throw new Error(i18n.t('errors.walletFormat'));
  }

  if (!parsed.keys?.length) {
    throw new Error(i18n.t('errors.walletNoKey'));
  }

  const keyData = parsed.keys[0];

  let wallet: Key;
  if (keyData.keyType === 'EC') {
    // Legacy secp256k1 key imported from an old-format .wallet file.
    const ecKey = ECKey.fromPrivate(Utils.HEX.decode(keyData.privateKey), true);
    const params =
      keyData.network === 'Test' || keyData.network === 'test'
        ? TestParams.get()
        : MainNetParams.get();
    wallet = {
      address: ecKey.toAddressString(params),
      pubkey: Utils.HEX.encode(ecKey.getPubKey()),
      privateKey: keyData.privateKey,
      keyType: 'EC',
      network: keyData.network,
    };
  } else {
    // Recreate PQKey and address from the stored private key
    const rawKey = Utils.HEX.decode(keyData.privateKey);
    const pqKey = PQKey.fromPrivateKey(rawKey);

    wallet = {
      address: pqKeyAddress(pqKey),
      pubkey: pqKey.getPublicKeyAsHex(),
      privateKey: pqKey.getPrivateKeyHex(),
      keyType: 'PQ',
    };
  }

  return {
    wallet,
    credentials: parsed.credentials,
  };
}

/**
 * Synchronously load a PLAIN (unencrypted) wallet JSON. Unlike
 * {@link loadWallet}, this never performs scrypt derivation, so the whole
 * parse is synchronous — safe to call from a getter without awaiting.
 */
export function loadPlainWalletSync(fileData: string): WalletFile {
  const parsedRoot = JSON.parse(fileData);
  const parsed = parsedRoot as SerializedWallet;

  if (!parsed.keys?.length) {
    throw new Error(i18n.t('errors.walletNoKey'));
  }

  const keyData = parsed.keys[0];

  let wallet: Key;
  if (keyData.keyType === 'EC') {
    const ecKey = ECKey.fromPrivate(Utils.HEX.decode(keyData.privateKey), true);
    const params =
      keyData.network === 'Test' || keyData.network === 'test'
        ? TestParams.get()
        : MainNetParams.get();
    wallet = {
      address: ecKey.toAddressString(params),
      pubkey: Utils.HEX.encode(ecKey.getPubKey()),
      privateKey: keyData.privateKey,
      keyType: 'EC',
      network: keyData.network,
    };
  } else {
    const rawKey = Utils.HEX.decode(keyData.privateKey);
    const pqKey = PQKey.fromPrivateKey(rawKey);
    wallet = {
      address: pqKeyAddress(pqKey),
      pubkey: pqKey.getPublicKeyAsHex(),
      privateKey: pqKey.getPrivateKeyHex(),
      keyType: 'PQ',
    };
  }

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

  const address = pqKeyAddress(pqKey);
  const privateKey = pqKey.getPrivateKeyHex();

  const wallet: Key = {
    address,
    pubkey: pqKey.getPublicKeyAsHex(),
    privateKey,
  };

  return { wallet };
}

/**
 * Read an old-format `.wallet` protobuf file (as produced by the legacy Java
 * bigtangle clients) and report whether it is password-encrypted. This never
 * requires the password.
 */
export async function parseOldWalletFile(
  fileData: Uint8Array,
): Promise<{ encrypted: boolean; address?: string }> {
  const serializer = new WalletProtobufSerializer();
  const wallet = serializer.readWallet(fileData);
  const encrypted = wallet.isEncrypted();
  if (encrypted) {
    return { encrypted };
  }
  const keys = await wallet.walletKeysAll(null);
  const ecKey = findLegacyKey(keys);
  return {
    encrypted,
    address: ecKey ? ecKey.toAddressString(wallet.getParams()) : undefined,
  };
}

/**
 * Import an old-format `.wallet` protobuf file. The legacy wallet contains
 * secp256k1 (EC) keys; if the file is encrypted, the wallet password must be
 * supplied so the private key can be recovered.
 */
export async function importOldWalletFile(
  fileData: Uint8Array,
  password?: string,
): Promise<WalletFile> {
  const serializer = new WalletProtobufSerializer();
  const wallet = serializer.readWallet(fileData);

  let keys: Array<ECKey | any>;
  if (wallet.isEncrypted()) {
    if (!password) {
      throw new Error(i18n.t('errors.oldWalletEncrypted'));
    }
    const crypter = wallet.getKeyCrypter();
    if (!crypter) {
      throw new Error(i18n.t('errors.noCrypter'));
    }
    const aesKey = await crypter.deriveKey(password);
    keys = await wallet.walletKeysAll(aesKey);
  } else {
    keys = await wallet.walletKeysAll(null);
  }

  const ecKey = findLegacyKey(keys);
  if (!ecKey) {
    throw new Error(i18n.t('errors.noEcKey'));
  }

  const params = wallet.getParams();
  const address = ecKey.toAddressString(params);

  return {
    wallet: {
      address,
      pubkey: Utils.HEX.encode(ecKey.getPubKey()),
      privateKey: Utils.HEX.encode(ecKey.getPrivKeyBytes()),
      keyType: 'EC',
      network: params.getId(),
    },
  };
}

function findLegacyKey(keys: Array<ECKey | any>): ECKey | null {
  for (const key of keys) {
    if (
      key &&
      typeof key.getKeyType === 'function' &&
      key.getKeyType() === 'EC' &&
      typeof key.hasPrivKey === 'function' &&
      key.hasPrivKey()
    ) {
      return key as ECKey;
    }
  }
  return null;
}

/**
 * Decode a base64 string into bytes (works in React Native and the browser
 * without relying on platform globals).
 */
export function base64ToBytes(b64: string): Uint8Array {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup: number[] = new Array(256).fill(0);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of b64) {
    if (ch === '=' || ch === '\n' || ch === '\r') continue;
    const v = lookup[ch.charCodeAt(0)];
    if (v === undefined && ch !== '=') continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
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
