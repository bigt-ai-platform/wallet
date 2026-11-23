/**
 * Sweep planning (pure): decide which per-user deposit addresses can be
 * consolidated into the omnibus, and why the rest are skipped.
 *
 * The economics are explicit: an ERC-20 transfer costs gas at that address, so
 * a balance below the threshold or an address without enough ETH is left alone.
 * Nothing here signs or sends; the EVM runner applies the plan.
 */

export interface SweepCandidate {
  assetId: string;
  account: string;
  address: string;
  addressIndex: number;
  /** ERC-20 balance, smallest units. */
  tokenBalanceRaw: bigint;
  /** Native balance that pays gas, wei. */
  nativeBalanceWei: bigint;
  /** Estimated gas for the transfer at this address. */
  gasLimit: bigint;
}

export interface SweepPlanOptions {
  /** Shared custody address that receives the swept tokens. */
  omnibus: string;
  /** Minimum token balance worth a sweep, smallest units. */
  minTokenRaw: bigint;
  maxFeePerGasWei: bigint;
  /** ETH left behind at the deposit address after gas, wei. */
  nativeReserveWei: bigint;
}

export interface SweepJob {
  assetId: string;
  account: string;
  address: string;
  addressIndex: number;
  to: string;
  amountRaw: bigint;
  gasLimit: bigint;
}

export type SweepSkipReason = 'omnibus' | 'zero' | 'below-min' | 'no-gas';

export interface SweepSkip {
  address: string;
  account: string;
  reason: SweepSkipReason;
}

export interface SweepPlan {
  jobs: SweepJob[];
  skipped: SweepSkip[];
}

export function planSweeps(candidates: SweepCandidate[], options: SweepPlanOptions): SweepPlan {
  if (options.minTokenRaw < 0n) throw new Error('minTokenRaw must be >= 0');
  if (options.maxFeePerGasWei < 0n || options.nativeReserveWei < 0n) {
    throw new Error('fee and reserve must be >= 0');
  }

  const omnibus = options.omnibus.trim().toLowerCase();
  const jobs: SweepJob[] = [];
  const skipped: SweepSkip[] = [];

  for (const candidate of [...candidates].sort((a, b) => a.addressIndex - b.addressIndex)) {
    const skip = (reason: SweepSkipReason) => skipped.push({
      address: candidate.address,
      account: candidate.account,
      reason,
    });

    if (candidate.address.toLowerCase() === omnibus) {
      skip('omnibus');
      continue;
    }
    if (candidate.tokenBalanceRaw <= 0n) {
      skip('zero');
      continue;
    }
    if (candidate.tokenBalanceRaw < options.minTokenRaw) {
      skip('below-min');
      continue;
    }
    const gasCost = candidate.gasLimit * options.maxFeePerGasWei + options.nativeReserveWei;
    if (candidate.nativeBalanceWei < gasCost) {
      skip('no-gas');
      continue;
    }

    jobs.push({
      assetId: candidate.assetId,
      account: candidate.account,
      address: candidate.address,
      addressIndex: candidate.addressIndex,
      to: options.omnibus,
      amountRaw: candidate.tokenBalanceRaw,
      gasLimit: candidate.gasLimit,
    });
  }

  return { jobs, skipped };
}
