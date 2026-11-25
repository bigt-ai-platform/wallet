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
import type {
  DepositAddressRecord, HolderBalance, RedeemIntentRecord, RedeemRequestResult,
  ReserveDelta, SettleEffect, Store,
} from './store.js';

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
  destination: string | null;
  payout_ref: string | null;
  attempts: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

const OPERATION_COLUMNS = `id, kind, asset_id, account, amount_raw, l1_amount_raw, status,
  chain, tx_hash, log_index, idempotency_key, external_ref, destination, payout_ref,
  attempts, error, created_at, updated_at`;

/** Placeholders for {@link OPERATION_COLUMNS}, shared by every insert path. */
const OPERATION_VALUES = '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)';

function operationParams(op: Operation): unknown[] {
  return [
    op.id, op.kind, op.assetId, op.account, op.amountRaw, op.l1AmountRaw, op.status,
    op.ref?.chain ?? null, op.ref?.txHash ?? null, op.ref?.logIndex ?? null,
    op.idempotencyKey ?? null, op.externalRef ?? null, op.destination ?? null,
    op.payoutRef ?? null, op.attempts, op.error ?? null, op.createdAt, op.updatedAt,
  ];
}

interface DepositAddressRow {
  asset_id: string;
  account: string;
  address: string;
  address_index: string;
  chain: string;
  created_at: Date;
}

function toDepositAddress(row: DepositAddressRow): DepositAddressRecord {
  return {
    assetId: row.asset_id,
    account: row.account,
    address: row.address,
    addressIndex: Number(row.address_index),
    chain: row.chain,
    createdAt: row.created_at.toISOString(),
  };
}

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
    ...(row.destination ? { destination: row.destination } : {}),
    ...(row.payout_ref ? { payoutRef: row.payout_ref } : {}),
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
       VALUES ${OPERATION_VALUES}
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         attempts = EXCLUDED.attempts,
         error = EXCLUDED.error,
         external_ref = EXCLUDED.external_ref,
         destination = EXCLUDED.destination,
         payout_ref = EXCLUDED.payout_ref,
         updated_at = EXCLUDED.updated_at`,
      operationParams(op),
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

  async listDeposits(account: string, assetId: string | undefined, limit: number): Promise<Operation[]> {
    const res = await this.pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS} FROM operations
        WHERE account = $1 AND kind = 'deposit'
          AND ($2::text IS NULL OR lower(asset_id) = lower($2))
        ORDER BY created_at DESC LIMIT $3`,
      [account, assetId ?? null, clamp(limit)],
    );
    return res.rows.map(toOperation);
  }

  async claimPending(limit: number): Promise<Operation[]> {
    // One statement: the subquery locks pending rows and skips rows another
    // worker already claimed, so two executors cannot process the same op.
    const res = await this.pool.query<OperationRow>(
      `UPDATE operations SET status = 'processing', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM operations
           WHERE status = 'pending'
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING ${OPERATION_COLUMNS}`,
      [clamp(limit)],
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

  async putDepositAddress(record: DepositAddressRecord): Promise<boolean> {
    // Any of the three unique constraints can reject the row; `DO NOTHING`
    // turns the allocation race into a retry signal instead of an exception.
    const res = await this.pool.query(
      `INSERT INTO deposit_addresses (asset_id, account, address, address_index, chain, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING
       RETURNING asset_id`,
      [
        record.assetId, record.account, record.address.toLowerCase(),
        record.addressIndex, record.chain, record.createdAt,
      ],
    );
    return res.rowCount === 1;
  }

  async putRedeemIntent(record: RedeemIntentRecord): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO redeem_intents
         (asset_id, account, nonce, intent_hash, destination, amount_raw, expiry, operation_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING asset_id`,
      [
        record.assetId, record.account, record.nonce, record.intentHash,
        record.destination, record.amountRaw, record.expiry, record.operationId, record.createdAt,
      ],
    );
    return res.rowCount === 1;
  }

  async getDepositAddress(assetId: string, account: string): Promise<DepositAddressRecord | undefined> {
    const res = await this.pool.query<DepositAddressRow>(
      `SELECT asset_id, account, address, address_index, chain, created_at
         FROM deposit_addresses WHERE asset_id = $1 AND account = $2`,
      [assetId, account],
    );
    return res.rows[0] ? toDepositAddress(res.rows[0]) : undefined;
  }

  async findAccountByDepositAddress(assetId: string, address: string): Promise<string | undefined> {
    const res = await this.pool.query<{ account: string }>(
      `SELECT account FROM deposit_addresses
        WHERE asset_id = $1 AND lower(address) = lower($2)
        LIMIT 1`,
      [assetId, address],
    );
    return res.rows[0]?.account;
  }

  async listDepositAddresses(assetId: string): Promise<DepositAddressRecord[]> {
    const res = await this.pool.query<DepositAddressRow>(
      `SELECT asset_id, account, address, address_index, chain, created_at
         FROM deposit_addresses WHERE asset_id = $1 ORDER BY address_index ASC`,
      [assetId],
    );
    return res.rows.map(toDepositAddress);
  }

  async nextDepositIndex(): Promise<number> {
    const res = await this.pool.query<{ next: string }>(
      `SELECT COALESCE(MAX(address_index), -1) + 1 AS next FROM deposit_addresses`,
    );
    return Number(res.rows[0]?.next ?? 0);
  }

  async getScanCursor(chain: string): Promise<number | undefined> {
    const res = await this.pool.query<{ block: string }>(
      `SELECT block FROM scan_cursors WHERE chain = $1`, [chain],
    );
    const row = res.rows[0];
    return row ? Number(row.block) : undefined;
  }

  async putScanCursor(chain: string, block: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO scan_cursors (chain, block, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (chain) DO UPDATE SET block = EXCLUDED.block, updated_at = now()`,
      [chain, Math.max(0, Math.trunc(block))],
    );
  }

  /**
   * Reserve credit + operation insert in one transaction. The old two-step
   * write could leave the reserve credited with no operation row, and the next
   * pass (idempotent only on the operation) credited it again.
   */
  async creditDeposit(delta: ReserveDelta, op: Operation): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO operations (${OPERATION_COLUMNS})
         VALUES ${OPERATION_VALUES}
         ON CONFLICT DO NOTHING
         RETURNING id`,
        operationParams(op),
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      if (delta.reserveDeltaRaw > 0n || delta.dustDeltaRaw > 0n) {
        // Upsert: the first deposit for an asset may arrive before any reserve
        // row exists. `EXCLUDED` carries the delta, so a conflict adds to the
        // stored value instead of overwriting it.
        await client.query(
          `INSERT INTO reserves (asset_id, reserve_raw, supply_raw, dust_raw, updated_at)
           VALUES ($1,$2,0,$3,now())
           ON CONFLICT (asset_id) DO UPDATE SET
             reserve_raw = reserves.reserve_raw + EXCLUDED.reserve_raw,
             dust_raw = reserves.dust_raw + EXCLUDED.dust_raw,
             updated_at = now()`,
          [delta.assetId, delta.reserveDeltaRaw.toString(), delta.dustDeltaRaw.toString()],
        );
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * One transaction: lock the balance row, insert the operation (whose chain
   * ref may only back one release), insert the intent (nonce/hash may only be
   * used once) and debit the balance when it covers the amount. A worker can
   * never claim the operation before the debit is committed.
   */
  async putRedeemRequest(
    record: RedeemIntentRecord,
    op: Operation,
    debitRaw: bigint,
  ): Promise<RedeemRequestResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const balance = await client.query<{ available_raw: string }>(
        `SELECT available_raw FROM holder_balances
          WHERE asset_id = $1 AND account = $2
          FOR UPDATE`,
        [record.assetId, record.account],
      );
      const insertedOp = await client.query(
        `INSERT INTO operations (${OPERATION_COLUMNS})
         VALUES ${OPERATION_VALUES}
         ON CONFLICT DO NOTHING
         RETURNING id`,
        operationParams(op),
      );
      if (insertedOp.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'replay' };
      }
      const insertedIntent = await client.query(
        `INSERT INTO redeem_intents
           (asset_id, account, nonce, intent_hash, destination, amount_raw, expiry, operation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING
         RETURNING asset_id`,
        [
          record.assetId, record.account, record.nonce, record.intentHash,
          record.destination, record.amountRaw, record.expiry, record.operationId, record.createdAt,
        ],
      );
      if (insertedIntent.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'replay' };
      }
      const available = BigInt(balance.rows[0]?.available_raw ?? '0');
      const debited = !!balance.rows[0] && available >= debitRaw;
      if (debited) {
        await client.query(
          `UPDATE holder_balances
              SET available_raw = available_raw - $3,
                  pending_raw = pending_raw + $3,
                  updated_at = now()
            WHERE asset_id = $1 AND account = $2`,
          [record.assetId, record.account, debitRaw.toString()],
        );
      }
      await client.query('COMMIT');
      return { ok: true, debited };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // A lost race on either unique index is a replay, not a 500.
      if ((error as { code?: string }).code === '23505') return { ok: false, reason: 'replay' };
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Complete the operation and apply its ledger effect under one row lock.
   * `completed` is terminal, so a replayed settlement is a no-op instead of a
   * second supply/balance write.
   */
  async settleOperation(op: Operation, effect: SettleEffect): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ status: OperationStatus }>(
        `SELECT status FROM operations WHERE id = $1 FOR UPDATE`, [op.id],
      );
      const row = current.rows[0];
      if (!row) throw new Error(`unknown operation: ${op.id}`);
      if (row.status === 'completed') {
        await client.query('ROLLBACK');
        return false;
      }
      const amount = effect.amountRaw.toString();
      if (effect.kind === 'mint') {
        // The CHECK (supply_raw <= reserve_raw) rejects an over-issue here too.
        const updated = await client.query(
          `UPDATE reserves
              SET supply_raw = supply_raw + $2, updated_at = now()
            WHERE asset_id = $1`,
          [op.assetId, amount],
        );
        if (updated.rowCount !== 1) throw new Error(`no reserve credited for ${op.assetId}`);
        await client.query(
          `INSERT INTO holder_balances (asset_id, account, available_raw, pending_raw, updated_at)
           VALUES ($1,$2,$3,0,now())
           ON CONFLICT (asset_id, account) DO UPDATE SET
             available_raw = holder_balances.available_raw + EXCLUDED.available_raw,
             updated_at = now()`,
          [op.assetId, op.account, amount],
        );
      } else if (effect.kind === 'release') {
        const updated = await client.query(
          `UPDATE reserves
              SET supply_raw = GREATEST(supply_raw - $2, 0),
                  reserve_raw = GREATEST(reserve_raw - $2, 0),
                  updated_at = now()
            WHERE asset_id = $1`,
          [op.assetId, amount],
        );
        if (updated.rowCount !== 1) throw new Error(`no reserve credited for ${op.assetId}`);
        await client.query(
          `UPDATE holder_balances
              SET pending_raw = GREATEST(pending_raw - $3, 0), updated_at = now()
            WHERE asset_id = $1 AND account = $2`,
          [op.assetId, op.account, amount],
        );
      } else {
        await client.query(
          `UPDATE holder_balances
              SET pending_raw = GREATEST(pending_raw - $3, 0), updated_at = now()
            WHERE asset_id = $1 AND account = $2`,
          [op.assetId, op.account, amount],
        );
      }
      await client.query(
        `UPDATE operations
            SET status = 'completed', payout_ref = $2, error = NULL, updated_at = $3
          WHERE id = $1`,
        [op.id, op.payoutRef ?? null, op.updatedAt],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
