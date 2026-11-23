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
}
