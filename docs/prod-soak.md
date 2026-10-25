# Production soak / performance tests

Long-running probes against the **deployed** stack. No local infra is started;
the normal e2e suite never runs these (all are gated or standalone).

## Read-only soak: P2P + chain + order reads

`e2e/prod-soak.mjs` (wrapper: `e2e/prod-soak.sh`) is the long-run companion to
`e2e/playwright/tests/p2p-prod.spec.ts`. It measures per-endpoint
p50/p95/p99/max, error rate and throughput, and periodically snapshots the
engine watcher and chain tips.

```bash
# 30s smoke (what `e2e/e2etest.sh p2p-prod-soak` runs)
./e2e/prod-soak.sh --duration 30 --target p2p

# One hour, P2P + L0/L1-SOCIAL/L1-order + order books
./e2e/prod-soak.sh --duration 3600 --concurrency 4 --target all

# Days, until Ctrl-C
./e2e/prod-soak.sh --duration 0 --target all

# Measure a live Nvidia/USDT market (creates nothing; fails if absent)
./e2e/prod-soak.sh --duration 3600 --target order --require-market
```

Targets:

| target | probes |
|---|---|
| `p2p` | `/healthz`, `/capabilities`, public `ACTIVE`/`MATCHED` book, signed `/swaps/mine` (ephemeral DID) |
| `chain` | L0 `getTips` + `getBridgeInfo` preflight, L1-SOCIAL `getTips`, L1-order `getTips` |
| `order` | L1-order `searchExchangeTokens`, `getOrders`, `getOrdersTicker`, plus the discovered `Nvidia`/`USDT` pair |
| `all` | all of the above |

The market inventory is printed at startup and stored in the report
(`market.nvidia`, `market.usdt`, `market.pairRead`). `--require-market` turns a
missing pair into a failure; otherwise it is just reported. `--out` selects the
JSON report path (default `e2e/test-results/prod-soak-<ts>.json`); `--jsonl`
also appends raw samples.

**Budgets** (all overridable): <2% errors, steady-state p95 <2500ms and p99
<8000ms, no engine watcher error for 3 consecutive probes, and no watcher stall
while L1-SOCIAL advances. The runner exits non-zero when a budget or stability
check fails. Warm-up samples (default 15s) are excluded from the steady-state
percentiles.

**Writes are opt-in** (`--write`): every 5 minutes it creates a no-funds
`limit_buy` bid and cancels it. A crash between the two leaves an ad that
expires after 10 minutes. The normal soak is read-only.

## Write/load soak: Nvidia/USDT orders on prod L1-order

`e2e/prod-order-soak.sh` wraps the Java prod remote test
`../blockchain/helper/prod/testorder.sh` → `RemoteOrderIT#testCnyBasedTradePairs`
and loops it. Each iteration mints/reuses the fixed quote + pair tokens on
L1-order, funds the fixed wallets with L1 BC, places one sell and one matching
buy, and asserts both balances moved.

```bash
# 1h, one Nvidia/USDT pair roughly per minute
./e2e/prod-order-soak.sh

# 4h, one pair per 2 minutes, 3 failures max
ORDER_SOAK_SECONDS=14400 ORDER_SOAK_INTERVAL_SEC=120 \
  ./e2e/prod-order-soak.sh

# Print the underlying command without writing
DRY_RUN=1 ./e2e/prod-order-soak.sh
```

Defaults: quote `USDT`, pair `Nvidia`, L0 `https://eu1.bigtangle.org/`, L1-order
`https://ordereu1.bigtangle.org/`, logs under
`e2e/test-results/order-soak-<ts>/`. Every `RemoteOrderIT` knob passes through
(`ORDER_COUNT`, `ORDER_PRICE`, `ORDER_STAGGER_MS`, `ORDER_BINANCE_LIVE`,
`REQUIRE_BINANCE`, `ORDER_PRICE_NVIDIA`, `EXTRA_ARGS`, …).

**This writes to the target chain** (token issuance, BC funding, orders). The
quote token id is fixed (seed `0x05`): if that id already exists as CNY,
`ORDER_TOKEN_NAME=USDT` reuses it without renaming. Verify the first run's log
says it minted USDT, or target a freshly reset L1-order chain. Pair ids are
also seed-indexed (`0x06..` in list order); `ORDER_PAIR_TOKENS=Nvidia` alone
gives Nvidia the first pair seed, while the full default list keeps its
canonical id.

For raw throughput of the same class, `../blockchain/helper/prod/prodorderloop.sh`
accepts `ORDER_COUNT`, `AMOUNT_JITTER_PCT`, `PRICE_JITTER_PCT`, `LOOP_ITERS`,
`PAUSE_SEC`, `MAX_FAILS`.

## L0 → L1 bridge

There is **no** production remote bridge/peg-in test yet. `prod-soak.mjs`
includes the L0 `getBridgeInfo` preflight (vault address/active) but does not
move funds. The real bridge logic is covered by local Java integration tests
(`CrossChainFlowTest`, `BridgeServiceTest`, `L1CrosstangleHandlerTest`) and the
wallet `pegInToL1` path; a prod `RemoteBridgeIT` is still a separate task.
