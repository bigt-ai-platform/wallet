/**
 * Plain (unencrypted) wallet JSON.
 *
 * The wallet loader (`loadWallet` / `loadPlainWalletSync` /
 * `isPlainWalletJson`) accepts a `SerializedWallet` object — `keys[]` with no
 * `salt`/`data` — and treats it as an already-unlocked wallet. This is the
 * format written when a wallet is imported without a password (legacy
 * `.wallet` files, plain JSON wallet files).
 */

export interface PlainWalletKey {
  address: string;
  pubkey: string;
  privateKey: string;
  /** Key algorithm: PQ (default) or the legacy EC key of an old .wallet. */
  keyType?: string;
  /** Network the EC address was derived on (EC keys only). */
  network?: string;
  /** Wallet role: the Bigtangle key or the Ethereum (EVM) key. */
  role?: 'bigtangle' | 'ethereum';
}

export interface PlainWalletJson {
  keys: PlainWalletKey[];
  /** Optional wallet.bigt.ai web-login credentials (new wallets have none). */
  credentials?: unknown;
}

/**
 * Serialize one key (or every key of a multi-key wallet) as a plain wallet
 * JSON file — the unencrypted input that `saveKeyToFile` encrypts, and the
 * form `storeEncryptedWallet` accepts without a password.
 */
export function serializePlainWallet(
  keys: PlainWalletKey | PlainWalletKey[],
  credentials?: unknown,
): string {
  const serialized: PlainWalletJson = { keys: Array.isArray(keys) ? keys : [keys] };
  // Wallets created without credentials (new format) keep the file
  // credential-free.
  if (credentials) serialized.credentials = credentials;
  return JSON.stringify(serialized, null, 2);
}
