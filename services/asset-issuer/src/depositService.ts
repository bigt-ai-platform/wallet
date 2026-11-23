/**
 * Per-user deposit address allocation.
 *
 * The address is the attribution key: an ERC-20 transfer has no memo, so a
 * shared custody address can only be credited to the sender (`from`), which is
 * an exchange's hot wallet when the user withdraws from an exchange. Allocating
 * one derived address per L1 account removes that ambiguity.
 *
 * Allocation is idempotent per account and safe under concurrency: the store's
 * unique constraints decide the winner, and a loser re-reads or retries with
 * the next index.
 */

import { deriveDepositAddress } from './depositAddress.js';
import type { AssetConfig } from './config.js';
import type { DepositAddressRecord, Store } from './store.js';

export interface AllocateOptions {
  store: Store;
  asset: AssetConfig;
  xpub: string;
  /** Non-hardened path below the xpub (`0` = external chain). */
  path: string;
  chain?: string;
  now: () => string;
}

const MAX_ATTEMPTS = 10;

export async function ensureDepositAddress(
  options: AllocateOptions,
  account: string,
): Promise<DepositAddressRecord> {
  const { store, asset, xpub, path, chain = 'ethereum', now } = options;
  const key = account.trim();
  if (!key) throw new Error('deposit address requires an account');

  const existing = await store.getDepositAddress(asset.assetId, key);
  if (existing) return existing;

  let index = await store.nextDepositIndex();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let address: string;
    try {
      address = deriveDepositAddress(xpub, path, index);
    } catch {
      // BIP32's "invalid child" case: skip this index rather than reuse it.
      index += 1;
      continue;
    }

    const record: DepositAddressRecord = {
      assetId: asset.assetId,
      account: key,
      address: address.toLowerCase(),
      addressIndex: index,
      chain,
      createdAt: now(),
    };

    if (await store.putDepositAddress(record)) return record;

    // Lost a race: another request may have created this account's row, or
    // claimed the same index for a different account.
    const raced = await store.getDepositAddress(asset.assetId, key);
    if (raced) return raced;
    index = await store.nextDepositIndex();
  }

  throw new Error(`could not allocate a deposit address for ${asset.assetId} after ${MAX_ATTEMPTS} attempts`);
}
