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

export interface Store {
  saveOperation(op: Operation): Promise<void>;
  getOperation(id: string): Promise<Operation | undefined>;
  findOperationByKey(key: string): Promise<Operation | undefined>;
  findOperationByClientKey(key: string): Promise<Operation | undefined>;
  listOperations(account: string, limit: number): Promise<Operation[]>;
  /** Executor scan: oldest pending operations first, across all accounts. */
  listOperationsByStatus(status: OperationStatus, limit: number): Promise<Operation[]>;
  getReserve(assetId: string): Promise<ReserveEntry | undefined>;
  putReserve(entry: ReserveEntry): Promise<void>;
  listReserves(): Promise<ReserveEntry[]>;
  getHolderBalance(assetId: string, account: string): Promise<HolderBalance | undefined>;
  putHolderBalance(balance: HolderBalance): Promise<void>;
  latestAttestation(assetId: string): Promise<AttestationRecord | undefined>;
  putAttestation(record: AttestationRecord): Promise<void>;
}

/** In-memory store: the test double, and the reference for the SQL schema. */
export class MemoryStore implements Store {
  private readonly operations = new Map<string, Operation>();
  private readonly byKey = new Map<string, string>();
  private readonly reserves = new Map<string, ReserveEntry>();
  private readonly balances = new Map<string, HolderBalance>();
  private readonly attestations = new Map<string, AttestationRecord>();

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
}
