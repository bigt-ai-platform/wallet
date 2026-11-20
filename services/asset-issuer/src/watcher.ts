/**
 * Deposit and redemption watcher.
 *
 * Observes the outside world and turns it into operations. It never mints and
 * never releases: it records an intent and credits the reserve, so a crash after
 * the observation but before the mint is resumable.
 *
 * Two rules are enforced here rather than left to the executor:
 *
 * 1. **Finality.** An observation above the finalized block is deferred, not
 *    recorded. Minting on confirmations means a reorg leaves unbacked supply and
 *    the only remedy is a burn the holder never authorised.
 * 2. **Idempotency.** The observation is keyed `(chain, txHash, logIndex)`; the
 *    unique index in `schema.sql` makes a second pass a no-op.
 */

import { findAssetConfig, type AssetConfig } from './config.js';
import {
  chainKey,
  isFinalized,
  toL1Amount,
  type Operation,
} from './domain.js';
import type { Store } from './store.js';

/** An external transfer *into* our custody. */
export interface DepositObservation {
  assetId: string;
  account: string;
  /** Amount at the external asset's own decimals. */
  externalRaw: string;
  chain: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

/** An L1 transfer *into* the issuer's token address (the redemption request). */
export interface RedemptionObservation {
  assetId: string;
  account: string;
  /** Amount at the L1 scale (already 6 dp). */
  l1Raw: string;
  chain: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
}

export interface ChainClient {
  finalizedBlock(chain: string): Promise<number>;
  deposits(fromBlock: number): Promise<DepositObservation[]>;
  redemptions(fromBlock: number): Promise<RedemptionObservation[]>;
}

export interface WatcherOptions {
  store: Store;
  client: ChainClient;
  assets: AssetConfig[];
  now: () => string;
  newId: () => string;
}

export interface ScanResult {
  recorded: number;
  skipped: number;
  deferred: number;
}

export async function scanDeposits(options: WatcherOptions, fromBlock = 0): Promise<ScanResult> {
  const { store, client, assets, now, newId } = options;
  const result: ScanResult = { recorded: 0, skipped: 0, deferred: 0 };

  for (const observation of await client.deposits(fromBlock)) {
    const asset = findAssetConfig(assets, observation.assetId);
    if (!asset || !asset.enabled) {
      result.skipped += 1;
      continue;
    }
    const finalized = await client.finalizedBlock(observation.chain);
    if (!isFinalized(finalized, observation.blockNumber)) {
      result.deferred += 1;
      continue;
    }
    const key = chainKey(observation);
    if (await store.findOperationByKey(key)) {
      result.skipped += 1;
      continue;
    }
    const { l1, dust } = toL1Amount(observation.externalRaw, asset.externalDecimals, asset.l1Decimals);
    if (l1 <= 0n) {
      // Below one L1 unit: real value, but not representable. Record nothing and
      // report it rather than rounding a holder's deposit away.
      result.skipped += 1;
      continue;
    }

    // Credit the reserve *before* the operation exists: the value is already in
    // custody, and a crash between the two must not lose it.
    const reserve = (await store.getReserve(asset.assetId)) ?? {
      assetId: asset.assetId,
      reserveRaw: 0n,
      supplyRaw: 0n,
      dustRaw: 0n,
    };
    await store.putReserve({
      ...reserve,
      reserveRaw: reserve.reserveRaw + l1,
      dustRaw: reserve.dustRaw + dust,
    });

    const timestamp = now();
    const operation: Operation = {
      id: newId(),
      kind: 'deposit',
      assetId: asset.assetId,
      account: observation.account,
      amountRaw: observation.externalRaw,
      l1AmountRaw: l1.toString(),
      status: 'pending',
      ref: {
        chain: observation.chain,
        txHash: observation.txHash,
        logIndex: observation.logIndex,
      },
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.saveOperation(operation);
    result.recorded += 1;
  }
  return result;
}

export async function scanRedemptions(options: WatcherOptions, fromBlock = 0): Promise<ScanResult> {
  const { store, client, assets, now, newId } = options;
  const result: ScanResult = { recorded: 0, skipped: 0, deferred: 0 };

  for (const observation of await client.redemptions(fromBlock)) {
    const asset = findAssetConfig(assets, observation.assetId);
    if (!asset || !asset.enabled) {
      result.skipped += 1;
      continue;
    }
    const finalized = await client.finalizedBlock(observation.chain);
    if (!isFinalized(finalized, observation.blockNumber)) {
      result.deferred += 1;
      continue;
    }
    const key = chainKey(observation);
    if (await store.findOperationByKey(key)) {
      result.skipped += 1;
      continue;
    }
    const l1 = BigInt(observation.l1Raw);
    if (l1 <= 0n) {
      result.skipped += 1;
      continue;
    }

    const timestamp = now();
    const operation: Operation = {
      id: newId(),
      kind: 'withdrawal',
      assetId: asset.assetId,
      account: observation.account,
      amountRaw: observation.l1Raw,
      l1AmountRaw: l1.toString(),
      status: 'pending',
      ref: {
        chain: observation.chain,
        txHash: observation.txHash,
        logIndex: observation.logIndex,
      },
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await store.saveOperation(operation);
    result.recorded += 1;
  }
  return result;
}
