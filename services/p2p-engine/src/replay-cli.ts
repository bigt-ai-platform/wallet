/**
 * Chain-scan projector CLI (docs/p2p.md §14).
 *
 *   sync     one incremental pass from p2p_watch_cursor (what the watch loop runs)
 *   verify   replay the whole chain into a scratch store, diff against the
 *            projection, exit 1 on drift (missing = chain rows the store lost)
 *   rebuild  reset the cursor, replay the whole chain into the projection
 *            (POSTGRES_URL required; refuses a mem store unless FORCE=1)
 *
 * Env: POSTGRES_URL (PG projection), SETTLEMENT_L1_SOCIAL_URL[|S] (chain),
 * SETTLEMENT_STORE=mem to force an in-memory projection for smoke runs.
 */
import { pathToFileURL } from "node:url";

async function main(): Promise<number> {
  const mode = process.argv[2] ?? "sync";
  if (!["sync", "verify", "rebuild"].includes(mode)) {
    console.error("usage: replay-cli <sync|verify|rebuild>");
    return 2;
  }
  const env = process.env;
  const { Pool } = await import("pg");
  const { PgSettlementStore, MemSettlementStore } = await import("./store.js");
  const { BlobSettlementStore } = await import("./storeBlob.js");
  const { blobStoreFromEnv } = await import("./blob.js");
  const { syncOnce, replayVerify, HttpSocialSource, pgCursorStore, MemCursorStore, ensureWatchSchema } = await import(
    "./replay.js"
  );

  const storeMode = env.SETTLEMENT_STORE === "mem" || env.SETTLEMENT_STORE === "blob"
    ? env.SETTLEMENT_STORE
    : env.POSTGRES_URL
      ? "pg"
      : "mem";
  const pool = storeMode === "pg" ? new Pool({ connectionString: env.POSTGRES_URL! }) : null;
  if (pool) await ensureWatchSchema(pool);
  const store =
    storeMode === "pg"
      ? new PgSettlementStore(pool!)
      : storeMode === "blob"
        ? new BlobSettlementStore(blobStoreFromEnv(env))
        : new MemSettlementStore();

  const l1Urls = (env.SETTLEMENT_L1_SOCIAL_URLS ?? env.SETTLEMENT_L1_SOCIAL_URL ?? "").split(",").map((s) => s.trim());
  const l1Url = l1Urls.find(Boolean);
  if (!l1Url) {
    console.error("replay-cli: SETTLEMENT_L1_SOCIAL_URL(_S) is required");
    return 2;
  }
  const src = new HttpSocialSource(l1Url);
  const cursors = pool ? pgCursorStore(pool) : new MemCursorStore();
  const maxWalk = Number(env.SETTLEMENT_WATCH_MAX_WALK ?? (mode === "sync" ? 2000 : 50_000));

  if (mode === "rebuild") {
    if (!pool && env.FORCE !== "1") {
      console.error("replay-cli: rebuild needs POSTGRES_URL (mem projection is already chain-derived; FORCE=1 to run anyway)");
      return 2;
    }
    if (pool) {
      // Reset the projection: orders and events are both chain-derived; PII
      // tables (profiles/proofs) are store-only and deliberately kept.
      await pool.query("DELETE FROM p2p_orders");
      await pool.query("DELETE FROM p2p_swap_events");
      await pool.query("DELETE FROM p2p_watch_cursor");
    }
  }

  if (mode === "verify") {
    const report = await replayVerify(src, store, { maxWalk });
    console.log(`scanned blocks: ${report.scanned}`);
    for (const m of report.missing) console.log(`missing: ${m}`);
    for (const e of report.extra) console.log(`extra:   ${e}`);
    console.log(report.ok ? "verify: OK" : `verify: DRIFT (${report.missing.length} missing)`);
    return report.ok ? 0 : 1;
  }

  const r = await syncOnce(src, store, cursors, { maxWalk });
  console.log(
    JSON.stringify({
      mode,
      scannedBlocks: r.scannedBlocks,
      ordersOpened: r.ordersOpened,
      ordersCancelled: r.ordersCancelled,
      swapsAppended: r.swapsAppended,
      skipped: r.skipped,
      conflicts: r.conflicts,
      cursor: r.cursor,
      error: r.error ?? null,
    }),
  );
  return r.error ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
