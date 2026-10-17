import { describe, it, expect } from "vitest";
import { PgNonceStore } from "../src/nonceStore.js";

/** A tiny fake `pg` Pool recording the SQL and returning canned rows. */
function fakePool() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.trim().startsWith("SELECT")) return { rows: [{ nonce: "n1", exp: String(Date.now() + 1000) }] };
      return { rows: [] };
    },
  } as unknown as { calls: typeof calls; query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
}

describe("PgNonceStore", () => {
  it("creates the table, loads unexpired nonces, inserts idempotently, prunes", async () => {
    const pool = fakePool();
    const store = new PgNonceStore(pool as never);

    await store.ensureSchema();
    expect(pool.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS p2p_nonces/);

    const loaded = await store.load();
    expect(pool.calls.at(-1)!.sql).toMatch(/FROM p2p_nonces WHERE exp > \$1/);
    expect(loaded).toEqual([{ nonce: "n1", exp: expect.any(Number) }]);

    await store.add("n2", 123);
    expect(pool.calls.at(-1)!.sql).toMatch(/ON CONFLICT \(nonce\) DO NOTHING/);
    expect(pool.calls.at(-1)!.params).toEqual(["n2", 123]);

    await store.prune(999);
    expect(pool.calls.at(-1)!.sql).toMatch(/DELETE FROM p2p_nonces WHERE exp <= \$1/);
  });
});
