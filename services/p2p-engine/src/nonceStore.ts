/**
 * Nonce persistence for the signed-request replay guard (docs/p2p.md §18.1).
 *
 * The guard's nonce set is process-local, so a restart forgets every nonce and
 * a captured signed request can be replayed within the skew window. With a
 * shared Postgres the guard now hydrates from, and writes through to, this
 * store — so a restarted (or, for reads of the table, a second) instance still
 * rejects a replayed nonce.
 *
 * The `mem` / `blob` store modes have no database, so they keep the in-memory
 * set only (the deployment runs a single engine, so the residual is the skew
 * window across a restart — see the docs).
 */
import type { Pool } from "pg";

export interface StoredNonce {
  nonce: string;
  exp: number;
}

export interface NonceStore {
  /** Unexpired nonces, for boot hydration. */
  load(): Promise<StoredNonce[]>;
  /** Persist an accepted nonce (fire-and-forget; the in-memory set is truth). */
  add(nonce: string, exp: number): Promise<void>;
  /** Best-effort drop of expired rows. */
  prune(now: number): Promise<void>;
}

/** Postgres-backed nonce set (the `pg` store mode). */
export class PgNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS p2p_nonces (
         nonce TEXT PRIMARY KEY,
         exp BIGINT NOT NULL
       )`,
    );
  }

  async load(): Promise<StoredNonce[]> {
    const res = await this.pool.query<{ nonce: string; exp: string }>(
      "SELECT nonce, exp FROM p2p_nonces WHERE exp > $1",
      [Date.now()],
    );
    return res.rows.map((r) => ({ nonce: r.nonce, exp: Number(r.exp) }));
  }

  async add(nonce: string, exp: number): Promise<void> {
    await this.pool.query(
      "INSERT INTO p2p_nonces (nonce, exp) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING",
      [nonce, exp],
    );
  }

  async prune(now: number): Promise<void> {
    await this.pool.query("DELETE FROM p2p_nonces WHERE exp <= $1", [now]);
  }
}
