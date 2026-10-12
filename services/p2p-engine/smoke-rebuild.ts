/**
 * Live smoke for the swap anchor + the chain-scan projector (replay.ts) against
 * a real L1-SOCIAL node (e2e/infra.sh up + e2e/l1social.sh up). Anchors signed
 * `social.p2p-swap` records through the production submit path, then syncs the
 * projection from chain and verifies it — proving the wire format
 * (`getTips`/`getBlockByHash`), the anchor funding flow and the replay
 * projector against the Java node. Not part of the unit suite; run manually:
 *
 *   SETTLEMENT_NETWORK=testnet npx tsx smoke-rebuild.ts
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PQKey, TestParams, Utils } from "bigtangle-ts";
import { didFromPQKey } from "did/pq";
import { p2pSwapRecord } from "p2p-protocol";
import { signSwapRecord, submitSocialRecord } from "./src/anchor.js";
import { HttpSocialSource, MemCursorStore, replayVerify, syncOnce } from "./src/replay.js";
import { MemSettlementStore } from "./src/store.js";

const L1 = (process.env.SMOKE_L1_URL ?? "http://127.0.0.1:24091").replace(/\/+$/, "");
const GENESIS_CSV =
  process.env.SMOKE_GENESIS_CSV ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../blockchain/helper/test/TestGenesisOutput.csv");

// The dev validator seed is funded by TestGenesisOutput.csv on the SOCIAL
// chain (docs/p2p.md §11 — the anchor key must hold BIG to pay anchor fees).
const SEED_HEX = "04".repeat(32);
// Fresh swap id per run: the dev chain accumulates anchors across smoke runs.
const SWAP_ID = "swap-" + randomBytes(8).toString("hex");

function fail(msg: string): never {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const pqKey = PQKey.fromPrivateKeyHex(SEED_HEX);
  const did = didFromPQKey(pqKey);

  // Java-first cross-check: the seed must derive the exact pubkey the Java
  // genesis CSV funds (ValidatorKeyTool derives it via PQKey.fromPrivateKeyHex).
  const derivedPubkey = Utils.HEX.encode(pqKey.getPrefixedPublicKeyBytes());
  const csvPubkeys = new Set(
    readFileSync(GENESIS_CSV, "utf8")
      .split("\n")
      .slice(1)
      .map((line) => line.split(",")[1]?.trim())
      .filter(Boolean),
  );
  if (!csvPubkeys.has(derivedPubkey)) {
    fail(`derived pubkey ${derivedPubkey.slice(0, 32)}… is not funded in ${GENESIS_CSV}`);
  }
  console.log(`smoke: seed derives the genesis-funded pubkey ✓`);
  console.log(`smoke: engine did ${did.slice(0, 48)}…`);

  const base = {
    from: did,
    to: SWAP_ID,
    escrowTxHash: "f".repeat(64),
    releaseTxHash: "b".repeat(64),
  };
  const record0 = signSwapRecord(p2pSwapRecord({ ...base, status: "ESCROW_LOCKED", swapSeq: 0, ts: Date.now() }), pqKey);
  const record1 = signSwapRecord(p2pSwapRecord({ ...base, status: "ESCROW_RELEASED", swapSeq: 1, ts: Date.now() }), pqKey);

  // The node marks an output spendable only after its block is confirmed, and
  // the dev bootstrap (stakeDeposit) can leave spend-pending claims for up to
  // 5 minutes (SPEND_PENDING_TIMEOUT_MS) — retry until the anchor key's
  // outputs are spendable again.
  const submitWithRetry = async (record: unknown): Promise<string> => {
    for (let i = 0; i < 40; i++) {
      try {
        return await submitSocialRecord(L1, pqKey, record);
      } catch (e) {
        if (!String(e).includes("insufficient") || i === 39) throw e;
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    throw new Error("unreachable");
  };

  console.log(`smoke: anchoring record 0 via ${L1} ...`);
  const txid0 = await submitWithRetry(record0);
  console.log(`smoke: anchored txid=${txid0}`);

  // The record must appear in a produced block before the projector can see it
  // (POS slot = 6s on the dev chain).
  const src = new HttpSocialSource(L1);
  const store = new MemSettlementStore();
  const cursors = new MemCursorStore();
  let last = { scannedBlocks: 0, swapsAppended: 0, conflicts: [] as string[], error: undefined as string | undefined };
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    last = await syncOnce(src, store, cursors);
    if (last.error) fail(`sync failed: ${last.error}`);
    if ((await store.events(SWAP_ID)).length >= 1) break;
  }
  if ((await store.events(SWAP_ID)).length < 1) {
    const st = await fetch(`${L1}getTransactionStatus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash: txid0 }),
    }).then((r) => r.text());
    fail(
      `record 0 never appeared on the canonical chain (txid=${txid0}); ` +
        `sync=${JSON.stringify(last)}; status=${st.replace(/\s+/g, " ").slice(0, 200)} ` +
        `(a non-CONFIRMED status here means the dev beacon proposer orphaned the micro-batch block — ` +
        "the projector rightly only reads canonical blocks)",
    );
  }

  console.log(`smoke: anchoring record 1 via ${L1} ...`);
  const txid1 = await submitWithRetry(record1);
  console.log(`smoke: anchored txid=${txid1}`);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    last = await syncOnce(src, store, cursors);
    if (last.error) fail(`sync failed: ${last.error}`);
    if ((await store.events(SWAP_ID)).length >= 2) break;
  }

  const events = await store.events(SWAP_ID);
  if (events.map((e) => e.seq).join(",") !== "0,1") fail(`wrong event order ${events.map((e) => e.seq)}`);
  if (events[0].status !== "ESCROW_LOCKED") fail(`wrong status at seq 0: ${events[0].status}`);
  if (events[1].status !== "ESCROW_RELEASED") fail(`wrong status at seq 1: ${events[1].status}`);
  const latest = await store.getSwap(SWAP_ID);
  if (latest?.status !== "ESCROW_RELEASED") fail(`wrong current state ${latest?.status}`);
  if (last.conflicts.some((c) => c.includes(SWAP_ID))) fail(`our swap had conflicts: ${last.conflicts}`);

  // Drift check: a fresh replay of the whole chain must equal the projection.
  const report = await replayVerify(src, store);
  if (!report.ok) fail(`verify reported drift: ${JSON.stringify(report.missing)}`);

  console.log(
    `smoke: OK — synced ${events.length} events for ${SWAP_ID} from ${last.scannedBlocks}+ block(s); ` +
      `verify clean (scanned=${report.scanned}, swappedIn=${last.swapsAppended}, conflicts=${last.conflicts.length})`,
  );
}

main().catch((e) => fail(String(e)));
