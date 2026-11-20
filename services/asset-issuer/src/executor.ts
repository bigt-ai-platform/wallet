/**
 * Executor: the only place value is created or destroyed.
 *
 * It advances `pending` operations in a straight line — mint on L1 for a
 * deposit, release the external asset for a withdrawal, move a distributor
 * transfer — and it re-checks the invariants at execution time, not just at
 * request time. A mint that would push supply past the reserve fails here even
 * if a concurrent request slipped past the HTTP check.
 *
 * Key material never enters this module: `L1Minter` and `Treasury` are injected
 * adapters over an HSM/MPC signer.
 */

import { findAssetConfig, type AssetConfig } from './config.js';
import {
  canMint,
  fromL1Amount,
  withinCaps,
  type Operation,
  type OperationStatus,
  type ReserveEntry,
} from './domain.js';
import type { Store } from './store.js';

export interface L1Minter {
  /** Reissue `l1Raw` of the asset's token to `account` on L1-order. */
  mint(assetId: string, account: string, l1Raw: string): Promise<{ txHash: string }>;
}

export interface Treasury {
  /** Release `externalRaw` of the external asset to `account`. */
  release(assetId: string, account: string, externalRaw: string): Promise<{ txHash: string }>;
}

export interface TransferExecutor {
  transfer(assetId: string, from: string, to: string, l1Raw: string): Promise<{ txHash: string }>;
}

export interface ExecutorOptions {
  store: Store;
  assets: AssetConfig[];
  l1: L1Minter;
  treasury: Treasury;
  transfers?: TransferExecutor;
  now: () => string;
}

export interface RunResult {
  completed: number;
  failed: number;
  skipped: number;
}

const MINT_KINDS = new Set<Operation['kind']>(['deposit', 'mint']);
const RELEASE_KINDS = new Set<Operation['kind']>(['withdrawal', 'redeem']);

export async function runOnce(options: ExecutorOptions, limit = 50): Promise<RunResult> {
  const { store, assets, l1, treasury, transfers, now } = options;
  const result: RunResult = { completed: 0, failed: 0, skipped: 0 };
  const pending = await store.listOperationsByStatus('pending', limit);

  for (const operation of pending) {
    const asset = findAssetConfig(assets, operation.assetId);
    if (!asset || !asset.enabled) {
      result.skipped += 1;
      continue;
    }
    await store.saveOperation({ ...operation, status: 'processing', attempts: operation.attempts + 1, updatedAt: now() });
    try {
      if (MINT_KINDS.has(operation.kind)) {
        await executeMint(store, asset, operation, l1);
      } else if (RELEASE_KINDS.has(operation.kind)) {
        await executeRelease(store, asset, operation, treasury);
      } else if (operation.kind === 'transfer') {
        if (!transfers) throw new Error('transfer executor not configured');
        await transfers.transfer(asset.assetId, operation.account, operation.externalRef ?? '', operation.amountRaw);
        await settleTransfer(store, asset, operation);
      } else {
        throw new Error(`unsupported operation kind: ${operation.kind}`);
      }
      await store.saveOperation({ ...operation, status: 'completed', attempts: operation.attempts + 1, updatedAt: now() });
      result.completed += 1;
    } catch (error) {
      await store.saveOperation({
        ...operation,
        status: 'failed',
        attempts: operation.attempts + 1,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: now(),
      });
      result.failed += 1;
    }
  }
  return result;
}

async function executeMint(
  store: Store,
  asset: AssetConfig,
  operation: Operation,
  l1: L1Minter,
): Promise<void> {
  const reserve = await reserveFor(store, asset.assetId);
  const amount = BigInt(operation.l1AmountRaw);
  const caps = { maxSupplyRaw: asset.maxSupplyRaw, maxMintRaw: asset.maxMintRaw };
  // Re-checked at execution time: the HTTP layer only saw an earlier snapshot.
  if (!canMint(reserve, amount) || !withinCaps(reserve, amount, caps)) {
    throw new Error('mint would exceed the reserve or the asset cap');
  }
  await l1.mint(asset.assetId, operation.account, operation.l1AmountRaw);
  await store.putReserve({ ...reserve, supplyRaw: reserve.supplyRaw + amount });

  const balance = (await store.getHolderBalance(asset.assetId, operation.account)) ?? {
    assetId: asset.assetId,
    account: operation.account,
    availableRaw: 0n,
    pendingRaw: 0n,
  };
  await store.putHolderBalance({ ...balance, availableRaw: balance.availableRaw + amount });
}

async function executeRelease(
  store: Store,
  asset: AssetConfig,
  operation: Operation,
  treasury: Treasury,
): Promise<void> {
  const reserve = await reserveFor(store, asset.assetId);
  const amount = BigInt(operation.l1AmountRaw);
  const externalRaw = fromL1Amount(operation.l1AmountRaw, asset.l1Decimals, asset.externalDecimals);
  await treasury.release(asset.assetId, operation.account, externalRaw.toString());
  // The token is now in issuer custody and is retired: supply and reserve both
  // drop by the same L1 amount, preserving the invariant.
  await store.putReserve({
    ...reserve,
    supplyRaw: reserve.supplyRaw > amount ? reserve.supplyRaw - amount : 0n,
    reserveRaw: reserve.reserveRaw > amount ? reserve.reserveRaw - amount : 0n,
  });

  const balance = await store.getHolderBalance(asset.assetId, operation.account);
  if (balance) {
    await store.putHolderBalance({
      ...balance,
      pendingRaw: balance.pendingRaw > amount ? balance.pendingRaw - amount : 0n,
    });
  }
}

async function settleTransfer(store: Store, asset: AssetConfig, operation: Operation): Promise<void> {
  const amount = BigInt(operation.amountRaw);
  const balance = await store.getHolderBalance(asset.assetId, operation.account);
  if (!balance) return;
  await store.putHolderBalance({
    ...balance,
    pendingRaw: balance.pendingRaw > amount ? balance.pendingRaw - amount : 0n,
  });
}

async function reserveFor(store: Store, assetId: string): Promise<ReserveEntry> {
  return (await store.getReserve(assetId)) ?? {
    assetId,
    reserveRaw: 0n,
    supplyRaw: 0n,
    dustRaw: 0n,
  };
}

/** Explicit requeue: the only way a failed operation may run again. */
export async function requeue(store: Store, operationId: string, now: () => string): Promise<Operation> {
  const operation = await store.getOperation(operationId);
  if (!operation) throw new Error(`unknown operation: ${operationId}`);
  if (operation.status !== 'failed') {
    throw new Error(`only failed operations can be requeued (is ${operation.status})`);
  }
  const next: Operation = {
    ...operation,
    status: 'pending' as OperationStatus,
    error: undefined,
    updatedAt: now(),
  };
  await store.saveOperation(next);
  return next;
}
