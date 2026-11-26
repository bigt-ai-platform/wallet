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
  fromL1Amount,
  type Operation,
  type OperationStatus,
  type ReserveEntry,
} from './domain.js';
import type { Store } from './store.js';

export interface SignerContext {
  /** Stable key so an HSM/MPC signer can return the same payout on a retry. */
  operationId: string;
}

export interface L1Minter {
  /**
   * Reissue the asset's token to the issuer wallet. Split from `pay` so the
   * issuance reference is durable before the risky payment step: a retry then
   * skips reissuance and only pays. `operationId` lets an HSM/MPC command
   * return the same transaction on a retry.
   */
  issue(assetId: string, l1Raw: string, context: SignerContext): Promise<{ txHash: string }>;
  /** Drain signatures and pay the holder. */
  pay(
    assetId: string,
    account: string,
    l1Raw: string,
    context: SignerContext,
  ): Promise<{ txHash: string }>;
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
    context?: SignerContext,
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

/**
 * Re-checks that a redemption is backed by its L1 funding transfer at execution
 * time. A signed intent proves *who* chose the destination; the confirmed L1
 * return proves the tokens were actually given up.
 */
export type RedemptionVerifier = (operation: Operation, asset: AssetConfig) => Promise<boolean>;

export interface ExecutorOptions {
  store: Store;
  assets: AssetConfig[];
  l1: L1Minter;
  treasury: Treasury;
  transfers?: TransferExecutor;
  now: () => string;
  /** Required for chain-observed `deposit` operations (fail closed if absent). */
  verifyDeposit?: DepositVerifier;
  /** Required for every release (fail closed if absent). */
  verifyRedemption?: RedemptionVerifier;
}

export interface RunResult {
  completed: number;
  failed: number;
  skipped: number;
}

const MINT_KINDS = new Set<Operation['kind']>(['deposit', 'mint']);
const RELEASE_KINDS = new Set<Operation['kind']>(['withdrawal', 'redeem']);

export async function runOnce(options: ExecutorOptions, limit = 50): Promise<RunResult> {
  const { store, assets, l1, treasury, transfers, now, verifyDeposit, verifyRedemption } = options;
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
        await executeMint(store, asset, operation, l1, now);
      } else if (RELEASE_KINDS.has(operation.kind)) {
        if (!operation.ref) {
          throw new Error('release has no L1 funding transfer');
        }
        if (!verifyRedemption) {
          throw new Error('redemption verification is not configured (set L1_URL + L1_ISSUER_KEY)');
        }
        if (!(await verifyRedemption(operation, asset))) {
          throw new Error('L1 redemption transfer is not confirmed at the issuer address');
        }
        await executeRelease(store, asset, operation, treasury, now);
      } else if (operation.kind === 'transfer') {
        if (!transfers) throw new Error('transfer executor not configured');
        const { txHash } = await transfers.transfer(
          asset.assetId,
          operation.account,
          operation.externalRef ?? '',
          operation.amountRaw,
        );
        const settled = { ...operation, payoutRef: txHash, updatedAt: now() };
        await store.saveOperation(settled);
        await store.settleOperation(
          { ...settled, status: 'completed' },
          { kind: 'transfer', amountRaw: BigInt(operation.amountRaw) },
        );
      } else {
        throw new Error(`unsupported operation kind: ${operation.kind}`);
      }
      result.completed += 1;
    } catch (error) {
      // Keep a payout/mint hash that was persisted before the failure: on
      // requeue it is the proof that the signer already ran.
      const latest = await store.getOperation(operation.id);
      await store.saveOperation({
        ...operation,
        ...(latest?.payoutRef ? { payoutRef: latest.payoutRef } : {}),
        ...(latest?.issuanceRef ? { issuanceRef: latest.issuanceRef } : {}),
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
  now: () => string,
): Promise<void> {
  const amount = BigInt(operation.l1AmountRaw);
  let current = operation;

  // A requeue after the signer already ran must not mint twice: `payoutRef` is
  // persisted before the ledger settles, so its presence means "minted, only
  // the settlement is outstanding".
  if (!current.payoutRef) {
    // Reserve capacity atomically BEFORE the signer: two workers can otherwise
    // read the same headroom and both mint, and a later DB rejection cannot
    // undo an on-chain mint.
    const reserved = await store.reserveMint(operation.id, asset.assetId, amount, {
      maxSupplyRaw: asset.maxSupplyRaw,
      maxMintRaw: asset.maxMintRaw,
    });
    if (reserved !== 'reserved') {
      throw new Error('mint would exceed the reserve or the asset cap');
    }
    // Persist an attempt marker before the signer call. If the process dies or
    // the call throws, the outcome is unknown: `requeue` refuses unless the
    // operator forces it, so a local (non-idempotent) signer cannot reissue.
    if (current.issuanceRef !== 'attempted' && !current.issuanceRef) {
      current = { ...current, issuanceRef: 'attempted', updatedAt: now() };
      await store.saveOperation(current);
    }
    if (!current.issuanceRef || current.issuanceRef === 'attempted') {
      const { txHash } = await l1.issue(
        asset.assetId,
        operation.l1AmountRaw,
        { operationId: operation.id },
      );
      current = { ...current, issuanceRef: txHash, updatedAt: now() };
      await store.saveOperation(current);
    }
    if (!current.payoutRef) {
      const { txHash } = await l1.pay(
        asset.assetId,
        operation.account,
        operation.l1AmountRaw,
        { operationId: operation.id },
      );
      current = { ...current, payoutRef: txHash, updatedAt: now() };
      await store.saveOperation(current);
    }
  }

  await store.settleOperation(
    { ...current, status: 'completed', updatedAt: now() },
    { kind: 'mint', amountRaw: amount },
  );
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
  now: () => string,
): Promise<void> {
  const amount = BigInt(operation.l1AmountRaw);
  // A release without a signed-intent destination is exactly the redirect bug:
  // fail closed rather than send to the L1 account or a DB-supplied address.
  if (!operation.destination) {
    throw new Error('release requires a verified destination from a signed intent');
  }
  const destination = requireEvmAddress(operation.destination, 'destination');
  const externalRaw = fromL1Amount(operation.l1AmountRaw, asset.l1Decimals, asset.externalDecimals);

  let current = operation;
  if (!current.payoutRef) {
    const reserve = await reserveFor(store, asset.assetId);
    if (reserve.supplyRaw < amount) {
      throw new Error('release would exceed the issued supply; refusing to pay out');
    }
    const { txHash } = await treasury.release(
      asset.assetId,
      operation.account,
      destination,
      externalRaw.toString(),
      { operationId: operation.id },
    );
    current = { ...current, payoutRef: txHash, updatedAt: now() };
    await store.saveOperation(current);
  }

  // Supply and reserve drop by the same L1 amount, preserving the invariant.
  // The holder's pending amount is released only if its balance was debited.
  await store.settleOperation(
    { ...current, status: 'completed', updatedAt: now() },
    { kind: 'release', amountRaw: amount },
  );
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
export async function requeue(
  store: Store,
  operationId: string,
  now: () => string,
  options: { force?: boolean } = {},
): Promise<Operation> {
  const operation = await store.getOperation(operationId);
  if (!operation) throw new Error(`unknown operation: ${operationId}`);
  if (operation.status !== 'failed') {
    throw new Error(`only failed operations can be requeued (is ${operation.status})`);
  }
  // `attempted` means a mint signer started but did not report an issuance
  // reference. The chain may already hold the issuance, so an ordinary requeue
  // could issue twice; require explicitly reconciled/forced action.
  if (!options.force && operation.issuanceRef === 'attempted') {
    throw new Error(
      'mint outcome is ambiguous (signer started without an issuance reference); '
        + 'reconcile on chain, then requeue with force',
    );
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
