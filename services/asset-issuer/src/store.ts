/**
 * Storage seam. The service is pure domain + this interface; production binds a
 * Postgres implementation, tests bind the in-memory one. Keeping the interface
 * small is deliberate — every method is something the state machine needs, and
 * nothing lets a caller bypass an invariant by writing balances directly.
 */

import type { AttestationRecord, Operation, OperationStatus, ReserveEntry } from './domain.js';
import { chainKey } from './domain.js';

export interface HolderBalance {
  assetId: string;
  account: string;
  /** Available to transfer, smallest units. */
  availableRaw: bigint;
  /** Held by an in-flight operation, smallest units. */
  pendingRaw: bigint;
}

/**
 * A per-user EVM deposit address (Binance-style). `address` is stored
 * lower-case; presentation (EIP-55) happens at the HTTP boundary.
 */
export interface DepositAddressRecord {
  assetId: string;
  /** The L1 (base58) account credited when this address receives funds. */
  account: string;
  address: string;
  /** BIP32 non-hardened index, unique per asset. */
  addressIndex: number;
  chain: string;
  createdAt: string;
}

/** One signed redemption intent, stored before the balance is debited. */
export interface RedeemIntentRecord {
  assetId: string;
  account: string;
  nonce: string;
  intentHash: string;
  destination: string;
  amountRaw: string;
  expiry: number;
  operationId: string;
  createdAt: string;
}

/** Atomic result of reserving a redemption: the nonce, the operation and the debit. */
export type RedeemRequestResult =
  | { ok: true; debited: boolean }
  | { ok: false; reason: 'replay' };

/** Per-asset caps applied when mint capacity is reserved. */
export interface MintCaps {
  maxSupplyRaw: bigint;
  maxMintRaw: bigint;
}

/** `exceeds` means the reservation would breach the reserve or a cap. */
export type MintReserveResult = 'reserved' | 'exceeds';

/** Increment applied when a finalized deposit is observed. */
export interface ReserveDelta {
  assetId: string;
  reserveDeltaRaw: bigint;
  dustDeltaRaw: bigint;
}

/**
 * Ledger effect applied together with an operation's completion. Each kind is
 * the *only* write a worker may make for a settlement, so a crash between two
 * separate `putReserve`/`putHolderBalance` calls can no longer half-apply.
 */
export type SettleEffect =
  | { kind: 'mint'; amountRaw: bigint }
  | { kind: 'release'; amountRaw: bigint }
  | { kind: 'transfer'; amountRaw: bigint };

export interface Store {
  saveOperation(op: Operation): Promise<void>;
  getOperation(id: string): Promise<Operation | undefined>;
  findOperationByKey(key: string): Promise<Operation | undefined>;
  findOperationByClientKey(key: string): Promise<Operation | undefined>;
  listOperations(account: string, limit: number): Promise<Operation[]>;
  /** Deposit-page history: only `deposit` operations, optionally one asset. */
  listDeposits(account: string, assetId: string | undefined, limit: number): Promise<Operation[]>;
  /**
   * Atomically move up to `limit` pending operations to `processing` and
   * return them. This is the executor's claim: two workers must never see the
   * same row (Postgres: `FOR UPDATE SKIP LOCKED`).
   */
  claimPending(limit: number): Promise<Operation[]>;
  /** Executor scan: oldest pending operations first, across all accounts. */
  listOperationsByStatus(status: OperationStatus, limit: number): Promise<Operation[]>;
  getReserve(assetId: string): Promise<ReserveEntry | undefined>;
  putReserve(entry: ReserveEntry): Promise<void>;
  listReserves(): Promise<ReserveEntry[]>;
  getHolderBalance(assetId: string, account: string): Promise<HolderBalance | undefined>;
  putHolderBalance(balance: HolderBalance): Promise<void>;
  latestAttestation(assetId: string): Promise<AttestationRecord | undefined>;
  putAttestation(record: AttestationRecord): Promise<void>;
  /** False when the account, address or index is already taken (allocation race). */
  putDepositAddress(record: DepositAddressRecord): Promise<boolean>;
  getDepositAddress(assetId: string, account: string): Promise<DepositAddressRecord | undefined>;
  findAccountByDepositAddress(assetId: string, address: string): Promise<string | undefined>;
  listDepositAddresses(assetId: string): Promise<DepositAddressRecord[]>;
  /**
   * MAX(address_index) + 1 across **all** assets; 0 when none exist.
   * Global (not per asset) so two assets cannot hand the same address to
   * different accounts — the sweeper would then reuse a nonce.
   */
  nextDepositIndex(): Promise<number>;
  /** False when the nonce or intent hash was already used (replay). */
  putRedeemIntent(record: RedeemIntentRecord): Promise<boolean>;
  /**
   * Persisted scan cursor (last fully processed block) per chain, `undefined`
   * when the chain has never been scanned. Without it every pass re-reads the
   * same window and never reaches new deposits.
   */
  getScanCursor(chain: string): Promise<number | undefined>;
  putScanCursor(chain: string, block: number): Promise<void>;
  /**
   * Credit the reserve and record the observed deposit in **one** write.
   * False when the chain reference was already recorded, so a crash between
   * the two old writes cannot inflate the reserve on the next pass.
   */
  creditDeposit(delta: ReserveDelta, op: Operation): Promise<boolean>;
  /**
   * Atomically reserve the intent (nonce + hash + L1 funding ref), create the
   * pending operation and debit the holder's available balance when it covers
   * the amount. The debit is bookkeeping only: the L1 funding transfer is what
   * authorizes the release, so a holder who acquired the token on-market is
   * still redeemable.
   */
  putRedeemRequest(record: RedeemIntentRecord, op: Operation, debitRaw: bigint): Promise<RedeemRequestResult>;
  /**
   * Reserve mint headroom **before** the L1 signer runs. Concurrent operations
   * read the same `supply_raw`, so an execution-time read alone lets two mints
   * pass the check and over-issue; the reservation is serialized and counted
   * (with other reservations) against the reserve and the asset caps.
   */
  reserveMint(operationId: string, assetId: string, amountRaw: bigint, caps: MintCaps): Promise<MintReserveResult>;
  /** Release a reservation after a signer failure (or an explicit cancel). */
  releaseMintReservation(operationId: string): Promise<void>;
  /**
   * Unsettled redeem rows stored at output index 0. The schema cannot recover a
   * historical output index; these must be audited before their release, and
   * `/health` surfaces the count.
   */
  countRedeemRefsAtZero(): Promise<number>;
  /**
   * Complete an operation and apply its ledger effect atomically. Returns
   * false when the operation was already completed (a retry is a no-op).
   */
  settleOperation(op: Operation, effect: SettleEffect): Promise<boolean>;
}

/** In-memory store: the test double, and the reference for the SQL schema. */
export class MemoryStore implements Store {
  private readonly operations = new Map<string, Operation>();
  private readonly byKey = new Map<string, string>();
  private readonly reserves = new Map<string, ReserveEntry>();
  private readonly balances = new Map<string, HolderBalance>();
  private readonly attestations = new Map<string, AttestationRecord>();
  private readonly depositAddresses = new Map<string, DepositAddressRecord>();
  private readonly depositByAddress = new Map<string, string>();
  private readonly redeemIntents = new Map<string, RedeemIntentRecord>();
  private readonly scanCursors = new Map<string, number>();
  private readonly mintReservations = new Map<string, { assetId: string; amountRaw: bigint }>();

  async saveOperation(op: Operation): Promise<void> {
    this.operations.set(op.id, { ...op });
    if (op.ref) this.byKey.set(`chain:${chainKey(op.ref)}`, op.id);
    if (op.idempotencyKey) this.byKey.set(`idem:${op.idempotencyKey}`, op.id);
  }

  async getOperation(id: string): Promise<Operation | undefined> {
    const op = this.operations.get(id);
    return op ? { ...op } : undefined;
  }

  async findOperationByKey(key: string): Promise<Operation | undefined> {
    const id = this.byKey.get(`chain:${key}`);
    return id ? this.getOperation(id) : undefined;
  }

  async findOperationByClientKey(key: string): Promise<Operation | undefined> {
    const id = this.byKey.get(`idem:${key}`);
    return id ? this.getOperation(id) : undefined;
  }

  async listOperations(account: string, limit: number): Promise<Operation[]> {
    return [...this.operations.values()]
      .filter((op) => op.account === account)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit))
      .map((op) => ({ ...op }));
  }

  async listDeposits(account: string, assetId: string | undefined, limit: number): Promise<Operation[]> {
    const wanted = assetId?.toLowerCase();
    return [...this.operations.values()]
      .filter((op) => op.account === account && op.kind === 'deposit'
        && (!wanted || op.assetId.toLowerCase() === wanted))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(0, limit))
      .map((op) => ({ ...op }));
  }

  async claimPending(limit: number): Promise<Operation[]> {
    const claimed = [...this.operations.values()]
      .filter((op) => op.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(0, limit))
      .map((op) => ({ ...op, status: 'processing' as const, attempts: op.attempts + 1 }));
    for (const op of claimed) this.operations.set(op.id, op);
    return claimed.map((op) => ({ ...op }));
  }

  async getReserve(assetId: string): Promise<ReserveEntry | undefined> {
    const entry = this.reserves.get(assetId);
    return entry ? { ...entry } : undefined;
  }

  async putReserve(entry: ReserveEntry): Promise<void> {
    this.reserves.set(entry.assetId, { ...entry });
  }

  async listReserves(): Promise<ReserveEntry[]> {
    return [...this.reserves.values()].map((entry) => ({ ...entry }));
  }

  async getHolderBalance(assetId: string, account: string): Promise<HolderBalance | undefined> {
    const key = `${assetId}:${account}`;
    const entry = this.balances.get(key);
    return entry ? { ...entry } : undefined;
  }

  async putHolderBalance(balance: HolderBalance): Promise<void> {
    this.balances.set(`${balance.assetId}:${balance.account}`, { ...balance });
  }

  async listOperationsByStatus(status: OperationStatus, limit: number): Promise<Operation[]> {
    return [...this.operations.values()]
      .filter((op) => op.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(0, limit))
      .map((op) => ({ ...op }));
  }

  async latestAttestation(assetId: string): Promise<AttestationRecord | undefined> {
    const entry = this.attestations.get(assetId);
    return entry ? { ...entry } : undefined;
  }

  async putAttestation(record: AttestationRecord): Promise<void> {
    this.attestations.set(record.assetId, { ...record });
  }

  async putDepositAddress(record: DepositAddressRecord): Promise<boolean> {
    const key = `${record.assetId}:${record.account}`;
    const addressKey = record.address.toLowerCase();
    const indexTaken = [...this.depositAddresses.values()]
      .some((entry) => entry.addressIndex === record.addressIndex);
    if (this.depositAddresses.has(key) || this.depositByAddress.has(addressKey) || indexTaken) {
      return false;
    }
    this.depositAddresses.set(key, { ...record });
    this.depositByAddress.set(addressKey, key);
    return true;
  }

  async getDepositAddress(assetId: string, account: string): Promise<DepositAddressRecord | undefined> {
    const entry = this.depositAddresses.get(`${assetId}:${account}`);
    return entry ? { ...entry } : undefined;
  }

  async findAccountByDepositAddress(assetId: string, address: string): Promise<string | undefined> {
    const key = this.depositByAddress.get(address.toLowerCase());
    const entry = key ? this.depositAddresses.get(key) : undefined;
    // Addresses are globally unique; still refuse a cross-asset lookup that
    // would attribute one asset's deposit to another asset's holder.
    return entry && entry.assetId === assetId ? entry.account : undefined;
  }

  async listDepositAddresses(assetId: string): Promise<DepositAddressRecord[]> {
    return [...this.depositAddresses.values()]
      .filter((entry) => entry.assetId === assetId)
      .sort((a, b) => a.addressIndex - b.addressIndex)
      .map((entry) => ({ ...entry }));
  }

  async nextDepositIndex(): Promise<number> {
    let max = -1;
    for (const entry of this.depositAddresses.values()) {
      if (entry.addressIndex > max) max = entry.addressIndex;
    }
    return max + 1;
  }

  async putRedeemIntent(record: RedeemIntentRecord): Promise<boolean> {
    const key = `${record.assetId}:${record.account}:${record.nonce}`;
    const hashTaken = [...this.redeemIntents.values()]
      .some((entry) => entry.intentHash === record.intentHash);
    if (this.redeemIntents.has(key) || hashTaken) return false;
    this.redeemIntents.set(key, { ...record });
    return true;
  }

  async getScanCursor(chain: string): Promise<number | undefined> {
    return this.scanCursors.get(chain);
  }

  async putScanCursor(chain: string, block: number): Promise<void> {
    this.scanCursors.set(chain, block);
  }

  async creditDeposit(delta: ReserveDelta, op: Operation): Promise<boolean> {
    if (op.ref && this.byKey.has(`chain:${chainKey(op.ref)}`)) return false;
    if (this.operations.has(op.id)) return false;
    const current = this.reserves.get(delta.assetId) ?? {
      assetId: delta.assetId,
      reserveRaw: 0n,
      supplyRaw: 0n,
      dustRaw: 0n,
    };
    this.reserves.set(delta.assetId, {
      ...current,
      reserveRaw: current.reserveRaw + delta.reserveDeltaRaw,
      dustRaw: current.dustRaw + delta.dustDeltaRaw,
    });
    await this.saveOperation(op);
    return true;
  }

  async putRedeemRequest(
    record: RedeemIntentRecord,
    op: Operation,
    debitRaw: bigint,
  ): Promise<RedeemRequestResult> {
    const key = `${record.assetId}:${record.account}:${record.nonce}`;
    const hashTaken = [...this.redeemIntents.values()]
      .some((entry) => entry.intentHash === record.intentHash);
    // The L1 funding output may authorize exactly one release.
    const refTaken = !!op.ref && this.byKey.has(`chain:${chainKey(op.ref)}`);
    if (this.redeemIntents.has(key) || hashTaken || refTaken || this.operations.has(op.id)) {
      return { ok: false, reason: 'replay' };
    }
    this.redeemIntents.set(key, { ...record });
    await this.saveOperation(op);
    const balance = this.balances.get(`${record.assetId}:${record.account}`);
    if (balance && balance.availableRaw >= debitRaw) {
      this.balances.set(`${record.assetId}:${record.account}`, {
        ...balance,
        availableRaw: balance.availableRaw - debitRaw,
        pendingRaw: balance.pendingRaw + debitRaw,
      });
      return { ok: true, debited: true };
    }
    return { ok: true, debited: false };
  }

  async reserveMint(
    operationId: string,
    assetId: string,
    amountRaw: bigint,
    caps: MintCaps,
  ): Promise<MintReserveResult> {
    // Idempotent: a requeue after a crash already holds this operation's slot.
    if (this.mintReservations.has(operationId)) return 'reserved';
    if (amountRaw <= 0n || amountRaw > caps.maxMintRaw) return 'exceeds';
    const reserve = this.reserves.get(assetId);
    if (!reserve) return 'exceeds';
    let pending = 0n;
    for (const entry of this.mintReservations.values()) {
      if (entry.assetId === assetId) pending += entry.amountRaw;
    }
    const after = reserve.supplyRaw + pending + amountRaw;
    if (after > reserve.reserveRaw || after > caps.maxSupplyRaw) return 'exceeds';
    this.mintReservations.set(operationId, { assetId, amountRaw });
    return 'reserved';
  }

  async releaseMintReservation(operationId: string): Promise<void> {
    this.mintReservations.delete(operationId);
  }

  async countRedeemRefsAtZero(): Promise<number> {
    return [...this.operations.values()].filter((op) => (
      op.kind === 'redeem' && op.status !== 'completed' && op.ref?.logIndex === 0
    )).length;
  }

  async settleOperation(op: Operation, effect: SettleEffect): Promise<boolean> {
    const current = this.operations.get(op.id);
    if (!current) throw new Error(`unknown operation: ${op.id}`);
    if (current.status === 'completed') return false;
    const amount = effect.amountRaw;
    const balanceKey = `${op.assetId}:${op.account}`;
    const balance = this.balances.get(balanceKey) ?? {
      assetId: op.assetId,
      account: op.account,
      availableRaw: 0n,
      pendingRaw: 0n,
    };
    if (effect.kind === 'mint') {
      const reserve = this.reserves.get(op.assetId);
      if (!reserve) throw new Error(`no reserve credited for ${op.assetId}`);
      if (reserve.supplyRaw + amount > reserve.reserveRaw) {
        throw new Error('settlement would exceed the reserve');
      }
      this.reserves.set(op.assetId, { ...reserve, supplyRaw: reserve.supplyRaw + amount });
      this.balances.set(balanceKey, { ...balance, availableRaw: balance.availableRaw + amount });
      // The reservation is consumed by the settlement (idempotent if absent).
      this.mintReservations.delete(op.id);
    } else if (effect.kind === 'release') {
      const reserve = this.reserves.get(op.assetId);
      if (!reserve) throw new Error(`no reserve credited for ${op.assetId}`);
      this.reserves.set(op.assetId, {
        ...reserve,
        supplyRaw: reserve.supplyRaw > amount ? reserve.supplyRaw - amount : 0n,
        reserveRaw: reserve.reserveRaw > amount ? reserve.reserveRaw - amount : 0n,
      });
      this.balances.set(balanceKey, {
        ...balance,
        pendingRaw: balance.pendingRaw > amount ? balance.pendingRaw - amount : 0n,
      });
    } else {
      this.balances.set(balanceKey, {
        ...balance,
        pendingRaw: balance.pendingRaw > amount ? balance.pendingRaw - amount : 0n,
      });
    }
    this.operations.set(op.id, { ...op, status: 'completed' });
    return true;
  }
}
