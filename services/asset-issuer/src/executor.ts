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
  /**
   * Release `externalRaw` of the external asset to the verified `destination`.
   * `account` is the L1 account that authorized it (audit/attribution); the
   * signer must not treat it as an external address.
   */
  release(
    assetId: string,
    account: string,
    destination: string,
    externalRaw: string,
  ): Promise<{ txHash: string }>;
}

export interface TransferExecutor {
  transfer(assetId: string, from: string, to: string, l1Raw: string): Promise<{ txHash: string }>;
}

/**
 * Re-checks an observed deposit against the source chain at execution time.
 * A DB row alone must not authorize a mint: the `(chain, txHash, logIndex)`
 * must still exist, still match amount/account, and still be finalized.
 */
export type DepositVerifier = (operation: Operation, asset: AssetConfig) => Promise<boolean>;

export interface ExecutorOptions {
  store: Store;
  assets: AssetConfig[];
  l1: L1Minter;
  treasury: Treasury;
  transfers?: TransferExecutor;
  now: () => string;
  /** Required for chain-observed `deposit` operations (fail closed if absent). */
  verifyDeposit?: DepositVerifier;
}

export interface RunResult {
  completed: number;
  failed: number;
  skipped: number;
}

const MINT_KINDS = new Set<Operation['kind']>(['deposit', 'mint']);
const RELEASE_KINDS = new Set<Operation['kind']>(['withdrawal', 'redeem']);

export async function runOnce(options: ExecutorOptions, limit = 50): Promise<RunResult> {
  const { store, assets, l1, treasury, transfers, now, verifyDeposit } = options;
  const result: RunResult = { completed: 0, failed: 0, skipped: 0 };
  // Atomic claim: the row is `processing` and owned by this worker before any
  // chain call, so two workers cannot mint the same operation.
  const pending = await store.claimPending(limit);

  for (const operation of pending) {
    const asset = findAssetConfig(assets, operation.assetId);
    if (!asset || !asset.enabled) {
      // Do not leave a claimed row stuck in `processing`.
      await store.saveOperation({
        ...operation,
        status: 'failed',
        error: `unknown or disabled asset: ${operation.assetId}`,
        updatedAt: now(),
      });
      result.failed += 1;
      continue;
    }
    try {
      if (MINT_KINDS.has(operation.kind)) {
        if (operation.kind === 'deposit') {
          if (!operation.ref) throw new Error('deposit has no chain reference');
          if (!verifyDeposit) {
            throw new Error('deposit verification is not configured (set ETH_RPC_URL)');
          }
          if (!(await verifyDeposit(operation, asset))) {
            throw new Error('deposit is not present on chain at finality');
          }
        }
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
      await store.saveOperation({ ...operation, status: 'completed', updatedAt: now() });
      result.completed += 1;
    } catch (error) {
      await store.saveOperation({
        ...operation,
        status: 'failed',
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

function requireEvmAddress(value: string, name: string): string {
  const clean = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`${name} must be a 20-byte 0x address`);
  }
  return clean;
}

async function executeRelease(
  store: Store,
  asset: AssetConfig,
  operation: Operation,
  treasury: Treasury,
): Promise<void> {
  const reserve = await reserveFor(store, asset.assetId);
  const amount = BigInt(operation.l1AmountRaw);
  // A release without a signed-intent destination is exactly the redirect bug:
  // fail closed rather than send to the L1 account or a DB-supplied address.
  if (!operation.destination) {
    throw new Error('release requires a verified destination from a signed intent');
  }
  const destination = requireEvmAddress(operation.destination, 'destination');
  const externalRaw = fromL1Amount(operation.l1AmountRaw, asset.l1Decimals, asset.externalDecimals);
  await treasury.release(asset.assetId, operation.account, destination, externalRaw.toString());
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
