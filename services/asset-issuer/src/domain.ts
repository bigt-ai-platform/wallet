/**
 * Issuer domain: operations, idempotency, reserve ledger.
 *
 * Pure functions only — no I/O, no clock, no DB. The state machine, the
 * idempotency keys and the `supply <= reserve` invariant are the parts that
 * must be provable in tests; everything else is wiring.
 *
 * The API this service exposes is the contract the wallet already speaks
 * (`expo-app/sources/services/distributor.ts`), so no client transport changes.
 */

/** Minimal decimal representation: amounts are strings of smallest units. */
export type Amount = string;

export type OperationStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type OperationKind =
  | 'deposit' // external value observed, waiting to mint on L1
  | 'mint' // reissuance submitted to the L1
  | 'withdrawal' // L1 token received by the issuer
  | 'redeem' // external value released
  | 'transfer'; // distributor-mediated transfer between holders

/** The natural key of an on-chain observation. */
export interface ChainRef {
  chain: string;
  txHash: string;
  logIndex: number;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  assetId: string;
  account: string;
  /** Amount observed/produced on the external side, smallest units. */
  amountRaw: Amount;
  /** Amount minted/released on L1, smallest units at the L1 scale. */
  l1AmountRaw: Amount;
  status: OperationStatus;
  /**
   * Set for chain-observed operations; absent for API-initiated requests.
   * For a `redeem` it is the **L1 funding transfer** that backs it (the output
   * paid to `redemptionAddress`), and the unique `(chain, txHash, logIndex)`
   * index is what lets one L1 return authorize exactly one release.
   */
  ref?: ChainRef;
  /**
   * Client-supplied idempotency key for API-initiated operations (a POST may be
   * retried by a mobile network). Chain-observed work uses `ref` instead.
   */
  idempotencyKey?: string;
  externalRef?: string;
  /**
   * Verified external destination for a redemption (EVM address). Set only by
   * a signed intent; `executeRelease` refuses a release without it.
   */
  destination?: string;
  /**
   * Hash of the external payout/mint transaction once the signer reports it.
   * Persisted before the ledger is settled so a requeue never broadcasts a
   * second payout for the same operation.
   */
  payoutRef?: string;
  /**
   * Reissuance reference for a mint: the token-creation transaction hash once
   * reported, or the sentinel `attempted` while the signer is running. A
   * requeue must not issue again when this is `attempted` (the outcome is
   * unknown); see `requeue`.
   */
  issuanceRef?: string;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Allowed transitions. `completed` is terminal — a completed mint is never
 * "rolled back" by editing state; the only undo is a burn/release operation.
 * `failed` can be requeued explicitly (`attempts` is preserved), never
 * implicitly.
 */
const TRANSITIONS: Record<OperationStatus, OperationStatus[]> = {
  pending: ['processing', 'failed'],
  processing: ['completed', 'failed'],
  completed: [],
  failed: ['pending'],
};

export function canTransition(from: OperationStatus, to: OperationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class TransitionError extends Error {
  constructor(from: OperationStatus, to: OperationStatus) {
    super(`illegal operation transition ${from} -> ${to}`);
    this.name = 'TransitionError';
  }
}

/** Pure transition; throws on an illegal edge so a bug cannot silently pass. */
export function transition(op: Operation, to: OperationStatus, now: string, error?: string): Operation {
  if (!canTransition(op.status, to)) throw new TransitionError(op.status, to);
  return {
    ...op,
    status: to,
    error: to === 'failed' ? (error ?? op.error ?? 'unspecified failure') : undefined,
    attempts: to === 'processing' ? op.attempts + 1 : op.attempts,
    updatedAt: now,
  };
}

/** Stable idempotency key for a chain observation. */
export function chainKey(ref: ChainRef): string {
  if (!ref.chain) throw new Error('chainKey: chain is required');
  if (!ref.txHash) throw new Error('chainKey: txHash is required');
  if (!Number.isInteger(ref.logIndex) || ref.logIndex < 0) {
    throw new Error('chainKey: logIndex must be a non-negative integer');
  }
  return `${ref.chain}:${ref.txHash.toLowerCase()}:${ref.logIndex}`;
}

/**
 * A deposit is only actionable once the source chain is final. Confirmations are
 * not enough: an Ethereum reorg after minting leaves unbacked supply, and the
 * only fix would be a burn the holder never authorised.
 */
export function isFinalized(finalizedBlock: number, observedBlock: number): boolean {
  return Number.isFinite(finalizedBlock) && Number.isFinite(observedBlock)
    && observedBlock <= finalizedBlock;
}

/**
 * Convert an external amount to the L1 scale (6 decimals), returning the dust
 * that cannot be represented. Dust stays in the reserve and must be tracked per
 * asset; dropping it silently makes the ledger drift.
 */
export function toL1Amount(
  externalRaw: Amount,
  externalDecimals: number,
  l1Decimals: number,
): { l1: bigint; dust: bigint } {
  if (externalDecimals < 0 || l1Decimals < 0) throw new Error('decimals must be >= 0');
  const value = BigInt(externalRaw);
  if (value < 0n) throw new Error('amount must be >= 0');
  if (externalDecimals <= l1Decimals) {
    return { l1: value * 10n ** BigInt(l1Decimals - externalDecimals), dust: 0n };
  }
  const divisor = 10n ** BigInt(externalDecimals - l1Decimals);
  return { l1: value / divisor, dust: value % divisor };
}

/**
 * Convert an L1 amount back to the external asset's scale for a redemption.
 * Exact inverse of {@link toL1Amount} for amounts that fit the external scale;
 * anything finer is refused rather than silently truncated.
 */
export function fromL1Amount(l1Raw: Amount, l1Decimals: number, externalDecimals: number): bigint {
  if (l1Decimals < 0 || externalDecimals < 0) throw new Error('decimals must be >= 0');
  const value = BigInt(l1Raw);
  if (value < 0n) throw new Error('amount must be >= 0');
  if (externalDecimals >= l1Decimals) {
    return value * 10n ** BigInt(externalDecimals - l1Decimals);
  }
  const divisor = 10n ** BigInt(l1Decimals - externalDecimals);
  if (value % divisor !== 0n) throw new Error('amount is not representable at the external scale');
  return value / divisor;
}

/**
 * Render smallest units as a plain decimal string (no grouping), for the
 * wallet's display-unit fields (`/deposits`, `/statement`). Trailing zeros in
 * the fraction are dropped; `100000000` at 6 dp is `100`.
 */
export function formatAmount(raw: Amount, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) throw new Error('decimals must be >= 0');
  const value = BigInt(raw);
  if (value < 0n) throw new Error('amount must be >= 0');
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** A signed reserve attestation, published on a fixed cadence. */
export interface AttestationRecord {
  assetId: string;
  version: number;
  reserveRaw: bigint;
  supplyRaw: bigint;
  /** Hash of the off-chain statement (bar list, bank letter, PoR report). */
  documentHash: string;
  publishedAt: string;
}

export interface ReserveEntry {
  assetId: string;
  /** External value we hold, expressed on the L1 scale. */
  reserveRaw: bigint;
  /** L1 token supply we have issued. */
  supplyRaw: bigint;
  /** Unrepresentable remainder carried for reconciliation. */
  dustRaw: bigint;
}

/**
 * The one invariant: supply never exceeds the reserve that backs it.
 *
 * Everything else (caps, pauses, attestations) is operational hardening; this
 * is the solvency line. It is checked per asset and never aggregated.
 */
export function supplyWithinReserve(entry: ReserveEntry): boolean {
  return entry.reserveRaw >= 0n && entry.supplyRaw >= 0n && entry.supplyRaw <= entry.reserveRaw;
}

export function canMint(entry: ReserveEntry, amountRaw: bigint): boolean {
  if (amountRaw <= 0n) return false;
  return entry.supplyRaw + amountRaw <= entry.reserveRaw;
}

export interface ReconcileBreach {
  assetId: string;
  supplyRaw: string;
  reserveRaw: string;
  overflowRaw: string;
}

/** Reconcile every asset independently; return the breaches, not a boolean. */
export function reconcile(entries: ReserveEntry[]): ReconcileBreach[] {
  return entries
    .filter((entry) => !supplyWithinReserve(entry))
    .map((entry) => ({
      assetId: entry.assetId,
      supplyRaw: entry.supplyRaw.toString(),
      reserveRaw: entry.reserveRaw.toString(),
      overflowRaw: (entry.supplyRaw - entry.reserveRaw).toString(),
    }));
}

/** Per-asset caps, applied before any mint leaves the service. */
export interface AssetCaps {
  /** Hard cap on total L1 supply, smallest units. */
  maxSupplyRaw: bigint;
  /** Per-operation cap, smallest units. */
  maxMintRaw: bigint;
}

export function withinCaps(entry: ReserveEntry, amountRaw: bigint, caps: AssetCaps): boolean {
  return amountRaw <= caps.maxMintRaw && entry.supplyRaw + amountRaw <= caps.maxSupplyRaw;
}
