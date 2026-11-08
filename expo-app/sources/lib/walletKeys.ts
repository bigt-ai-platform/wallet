/**
 * Wallet key roles.
 *
 * A wallet file may hold more than one key:
 *  - **bigtangle** (PQ preferred; a legacy EC key when the wallet has no PQ):
 *    signs Bigtangle L0/L1 transactions, holds the BIG address;
 *  - **ethereum** (always EC/secp256k1): Ethereum, the EVM deposit/withdraw
 *    pages and (later) TRON.
 *
 * New wallets are created with both. Old EC-only wallets keep their EC key as
 * the Bigtangle key and can add a PQ key later; a PQ-only wallet can add an EC
 * key for Ethereum. Multi-key spend keeps funds on every key reachable.
 */

export type KeyType = 'PQ' | 'EC';
export type KeyRole = 'bigtangle' | 'ethereum';

export interface WalletKey {
  address: string;
  pubkey: string;
  privateKey: string;
  keyType?: KeyType;
  /** Network the address was derived on (EC keys only). */
  network?: string;
  /** Optional explicit role; inferred when absent. */
  role?: KeyRole;
}

export interface WalletKeySet {
  /** Primary key (the Bigtangle key). */
  wallet: WalletKey;
  /** Every key in the file, primary included. */
  keys?: WalletKey[];
  credentials?: unknown;
}

/** Every key of the file, primary first, deduplicated by private key. */
export function allKeys(file: WalletKeySet): WalletKey[] {
  const out: WalletKey[] = [];
  const seen = new Set<string>();
  for (const key of [file.wallet, ...(file.keys ?? [])]) {
    if (!key?.privateKey) continue;
    const id = key.privateKey.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

/** The Bigtangle key: explicit role first, then PQ, then the primary. */
export function bigtangleKey(file: WalletKeySet): WalletKey {
  const keys = allKeys(file);
  return (
    keys.find((k) => k.role === 'bigtangle') ??
    keys.find((k) => (k.keyType ?? 'PQ') === 'PQ') ??
    keys[0]
  );
}

/** The Ethereum (EVM) key: explicit role first, then the first EC key. */
export function ethereumKey(file: WalletKeySet): WalletKey | null {
  const keys = allKeys(file);
  return (
    keys.find((k) => k.role === 'ethereum') ??
    keys.find((k) => k.keyType === 'EC') ??
    null
  );
}

/** Append a key (replacing a same-role key) and rebuild the key list. */
export function withKey<T extends WalletKeySet>(file: T, key: WalletKey): T {
  const role: KeyRole = key.role ?? (key.keyType === 'EC' ? 'ethereum' : 'bigtangle');
  const tagged: WalletKey = { ...key, role };
  const others = allKeys(file).filter((k) => (k.role ?? (k.keyType === 'EC' ? 'ethereum' : 'bigtangle')) !== role);
  const keys = role === 'bigtangle' ? [tagged, ...others] : [...others, tagged];
  return { ...file, wallet: keys[0], keys } as T;
}

/** True when the wallet has no key that can sign Ethereum transactions. */
export function needsEthereumKey(file: WalletKeySet): boolean {
  return ethereumKey(file) === null;
}

/** True when the wallet has no post-quantum key (legacy EC-only wallet). */
export function needsPostQuantumKey(file: WalletKeySet): boolean {
  return !allKeys(file).some((k) => (k.keyType ?? 'PQ') === 'PQ');
}

/** Signing material for one key, as the transaction service expects it. */
export function signingKeys(file: WalletKeySet): Array<{ privateKeyHex: string; keyType?: KeyType }> {
  return allKeys(file).map((k) => ({ privateKeyHex: k.privateKey, keyType: k.keyType }));
}
