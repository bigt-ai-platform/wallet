/**
 * Postgres `Store` implementation (see `schema.sql`).
 *
 * Not covered by the unit tests: this repository has no database in CI, so the
 * domain and HTTP layers are tested against `MemoryStore` and this file is
 * verified by running it against a real Postgres before deployment. The queries
 * are deliberately simple (no CTEs, no window functions) so they can be reviewed
 * line by line.
 *
 * Amounts are NUMERIC(38,0) and come back from `pg` as strings; they are
 * converted to BigInt at this boundary so the rest of the service never sees a
 * float.
 */

import { Pool } from 'pg';
import type { AssetConfig } from './config.js';
import type { AttestationRecord, Operation, OperationStatus, ReserveEntry } from './domain.js';
import type { HolderBalance, Store } from './store.js';

interface OperationRow {
  id: string;
  kind: Operation['kind'];
  asset_id: string;
  account: string;
  amount_raw: string;
  l1_amount_raw: string;
  status: OperationStatus;
  chain: string | null;
  tx_hash: string | null;
  log_index: number | null;
  idempotency_key: string | null;
  external_ref: string | null;
  attempts: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const OPERATION_COLUMNS = `id, kind, asset_id, account, amount_raw, l1_amount_raw, status,
  chain, tx_hash, log_index, idempotency_key, external_ref, attempts, error, created_at, updated_at`;

function toOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    kind: row.kind,
    assetId: row.asset_id,
    account: row.account,
    amountRaw: row.amount_raw,
    l1AmountRaw: row.l1_amount_raw,
    status: row.status,
    ...(row.chain && row.tx_hash !== null && row.log_index !== null
      ? { ref: { chain: row.chain, txHash: row.tx_hash, logIndex: row.log_index } }
      : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.external_ref ? { externalRef: row.external_ref } : {}),
    attempts: row.attempts,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PgStore implements Store {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Upsert the configured assets. `operations.asset_id` and `reserves.asset_id`
   * are foreign keys, so this must run before the first write. Called from
   * `main.ts` on boot; safe to run repeatedly.
   */
  async seedAssets(assets: AssetConfig[]): Promise<void> {
    for (const asset of assets) {
      await this.pool.query(
        `INSERT INTO assets (asset_id, symbol, external_decimals, l1_decimals, max_supply_raw, max_mint_raw, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (asset_id) DO UPDATE SET
           symbol = EXCLUDED.symbol,
           external_decimals = EXCLUDED.external_decimals,
           l1_decimals = EXCLUDED.l1_decimals,
           max_supply_raw = EXCLUDED.max_supply_raw,
           max_mint_raw = EXCLUDED.max_mint_raw,
           enabled = EXCLUDED.enabled`,
        [
          asset.assetId, asset.symbol, asset.externalDecimals, asset.l1Decimals,
          asset.maxSupplyRaw.toString(), asset.maxMintRaw.toString(), asset.enabled,
        ],
      );
    }
  }

  async saveOperation(op: Operation): Promise<void> {
    await this.pool.query(
      `INSERT INTO operations (${OPERATION_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         attempts = EXCLUDED.attempts,
         error = EXCLUDED.error,
         external_ref = EXCLUDED.external_ref,
         updated_at = EXCLUDED.updated_at`,
      [
        op.id, op.kind, op.assetId, op.account, op.amountRaw, op.l1AmountRaw, op.status,
        op.ref?.chain ?? null, op.ref?.txHash ?? null, op.ref?.logIndex ?? null,
        op.idempotencyKey ?? null, op.externalRef ?? null, op.attempts, op.error ?? null,
        op.createdAt, op.updatedAt,
      ],
    );
  }

  async getOperation(id: string): Promise<Operation | undefined> {
    const res = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE id = $1`, [id],
    );
    return res.rows[0] ? toOperation(res.rows[0]) : undefined;
  }

  async findOperationByKey(key: string): Promise<Operation | undefined> {
    // key is `chain:txHash:logIndex`; the hash comparison is case-insensitive.
    const [chain, txHash, logIndex] = splitChainKey(key);
    const res = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM operations
        WHERE chain = $1 AND lower(tx_hash) = lower($2) AND log_index = $3
        LIMIT 1`,
      [chain, txHash, logIndex],
    );
    return res.rows[0] ? toOperation(res.rows[0]) : undefined;
  }

  async findOperationByClientKey(key: string): Promise<Operation | undefined> {
    const res = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM operations WHERE idempotency_key = $1 LIMIT 1`, [key],
    );
    return res.rows[0] ? toOperation(res.rows[0]) : undefined;
  }

  async listOperations(account: string, limit: number): Promise<Operation[]> {
    const res = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM operations
        WHERE account = $1 ORDER BY created_at DESC LIMIT $2`,
      [account, clamp(limit)],
    );
    return res.rows.map(toOperation);
  }

  async listOperationsByStatus(status: OperationStatus, limit: number): Promise<Operation[]> {
    const res = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM operations
        WHERE status = $1 ORDER BY created_at ASC LIMIT $2`,
      [status, clamp(limit)],
    );
    return res.rows.map(toOperation);
  }

  async getReserve(assetId: string): Promise<ReserveEntry | undefined> {
    const res = await this.pool.query<{
      asset_id: string; reserve_raw: string; supply_raw: string; dust_raw: string;
    }>(
      `SELECT asset_id, reserve_raw, supply_raw, dust_raw FROM reserves WHERE asset_id = $1`,
      [assetId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      assetId: row.asset_id,
      reserveRaw: BigInt(row.reserve_raw),
      supplyRaw: BigInt(row.supply_raw),
      dustRaw: BigInt(row.dust_raw),
    };
  }

  async putReserve(entry: ReserveEntry): Promise<void> {
    // The CHECK (supply_raw <= reserve_raw) makes an over-issue a database error,
    // not a silently stored inconsistency.
    await this.pool.query(
      `INSERT INTO reserves (asset_id, reserve_raw, supply_raw, dust_raw, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (asset_id) DO UPDATE SET
         reserve_raw = EXCLUDED.reserve_raw,
         supply_raw = EXCLUDED.supply_raw,
         dust_raw = EXCLUDED.dust_raw,
         updated_at = now()`,
      [entry.assetId, entry.reserveRaw.toString(), entry.supplyRaw.toString(), entry.dustRaw.toString()],
    );
  }

  async listReserves(): Promise<ReserveEntry[]> {
    const res = await this.pool.query<{
      asset_id: string; reserve_raw: string; supply_raw: string; dust_raw: string;
    }>(`SELECT asset_id, reserve_raw, supply_raw, dust_raw FROM reserves ORDER BY asset_id`);
    return res.rows.map((row) => ({
      assetId: row.asset_id,
      reserveRaw: BigInt(row.reserve_raw),
      supplyRaw: BigInt(row.supply_raw),
      dustRaw: BigInt(row.dust_raw),
    }));
  }

  async getHolderBalance(assetId: string, account: string): Promise<HolderBalance | undefined> {
    const res = await this.pool.query<{
      asset_id: string; account: string; available_raw: string; pending_raw: string;
    }>(
      `SELECT asset_id, account, available_raw, pending_raw
         FROM holder_balances WHERE asset_id = $1 AND account = $2`,
      [assetId, account],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      assetId: row.asset_id,
      account: row.account,
      availableRaw: BigInt(row.available_raw),
      pendingRaw: BigInt(row.pending_raw),
    };
  }

  async putHolderBalance(balance: HolderBalance): Promise<void> {
    await this.pool.query(
      `INSERT INTO holder_balances (asset_id, account, available_raw, pending_raw, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (asset_id, account) DO UPDATE SET
         available_raw = EXCLUDED.available_raw,
         pending_raw = EXCLUDED.pending_raw,
         updated_at = now()`,
      [balance.assetId, balance.account, balance.availableRaw.toString(), balance.pendingRaw.toString()],
    );
  }

  async latestAttestation(assetId: string): Promise<AttestationRecord | undefined> {
    const res = await this.pool.query<{
      asset_id: string; version: string; reserve_raw: string; supply_raw: string;
      document_hash: string; published_at: Date;
    }>(
      `SELECT asset_id, version, reserve_raw, supply_raw, document_hash, published_at
         FROM attestations WHERE asset_id = $1 ORDER BY version DESC LIMIT 1`,
      [assetId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      assetId: row.asset_id,
      version: Number(row.version),
      reserveRaw: BigInt(row.reserve_raw),
      supplyRaw: BigInt(row.supply_raw),
      documentHash: row.document_hash,
      publishedAt: row.published_at.toISOString(),
    };
  }

  async putAttestation(record: AttestationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO attestations (asset_id, version, reserve_raw, supply_raw, document_hash, published_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (asset_id, version) DO NOTHING`,
      [
        record.assetId, record.version, record.reserveRaw.toString(),
        record.supplyRaw.toString(), record.documentHash, record.publishedAt,
      ],
    );
  }
}

function clamp(limit: number): number {
  return Math.max(1, Math.min(1000, Math.trunc(limit)));
}

/** `chain:txHash:logIndex` — split on the last colon so a hash cannot confuse it. */
export function splitChainKey(key: string): [string, string, number] {
  const last = key.lastIndexOf(':');
  const middle = key.lastIndexOf(':', last - 1);
  if (middle <= 0 || last <= middle) throw new Error(`malformed chain key: ${key}`);
  const logIndex = Number(key.slice(last + 1));
  if (!Number.isInteger(logIndex)) throw new Error(`malformed chain key log index: ${key}`);
  return [key.slice(0, middle), key.slice(middle + 1, last), logIndex];
}
