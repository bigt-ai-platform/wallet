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

### Prerequisites (order soak)

The prod `Remote*IT` suite signs as the deterministic test wallets (ML-DSA seed
`0x01` / yuan `0x03`). On the multi-validator prod chains those are not minted,
and the order chain has no BIG genesis, so the first run fails
`InsufficientMoneyException [1000:bc] outputs size=0`. Fund them once from the
validator keystores:

```bash
FUND_L0=0 FUND_L1=1 FUND_UTXOS=8 \
  bash ../blockchain/helper/prod/fund-test-wallets.sh
```

The Java helpers also need current `bigtangle-core` / `bigtangle-servercore`
jars in the local Maven repo; if test compilation reports missing
`AttestationSigner` / `assignedSlot`, install them:

```bash
cd ../blockchain
JAVA_HOME=/home/jcui/.local/java-25 PATH=$JAVA_HOME/bin:$PATH \
  mvn -q install -DskipTests -pl bigtangle-core,bigtangle-servercore -am
```

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

Defaults: quote `USDT` (seed `12`), pair `Nvidia`, L0
`https://eu1.bigtangle.org/`, L1-order `https://ordereu1.bigtangle.org/`, logs
under `e2e/test-results/order-soak-<ts>/`. Every `RemoteOrderIT` knob passes
through (`ORDER_COUNT`, `ORDER_PRICE`, `ORDER_STAGGER_MS`,
`ORDER_BINANCE_LIVE`, `REQUIRE_BINANCE`, `ORDER_PRICE_NVIDIA`, `EXTRA_ARGS`,
…).

**Verified on prod:** the first run minted `USDT` (seed 12) and `Nvidia`
(pair seed 0x06), then placed and matched `107 Nvidia @ 213.23 USDT`
(`testCnyBasedTradePairs`, 24s). The market now exists, so
`prod-soak.mjs --target order --require-market` discovers it and reads its
book/ticker.

**This writes to the target chain** (token issuance, BC funding, orders). The
wrapper uses quote seed `12` by default, so `USDT` is a distinct token from the
CNY token at seed `5` and can coexist with it; pass `ORDER_QUOTE_SEED=5` to
reuse CNY. Pair ids are also seed-indexed (`0x06..` in list order);
`ORDER_PAIR_TOKENS=Nvidia` alone gives Nvidia the first pair seed, while the
full default list keeps its canonical id.

### Resting maker book

`e2e/prod-maker.sh` places a **resting** sell above and buy below the market
and leaves both open (no counter-order), so Home/Spot have an actual order
book:

```bash
./e2e/prod-maker.sh
MAKER_PRICE=220 MAKER_SPREAD=4 MAKER_AMOUNT=25 ./e2e/prod-maker.sh
DRY_RUN=1 ./e2e/prod-maker.sh
```

Verified on prod: the Nvidia/USDT book showed a SELL **220** and BUY **218**
(10 each) around last **210**. It is a write test (funding/orders); running it
again adds another pair of resting orders.

### Price walk

`e2e/prod-price-walk.sh` drives the same market through a configurable price
sequence, one matched sell+buy per step, so the wallet's last price, 24h
high/low, chart and recent trades actually move:

```bash
./e2e/prod-price-walk.sh
ORDER_PRICE_WALK=205,210,215,220,215,210 PRICE_WALK_PAUSE_SEC=10 \
  ./e2e/prod-price-walk.sh
PRICE_WALK_ROUNDS=4 ./e2e/prod-price-walk.sh
DRY_RUN=1 ./e2e/prod-price-walk.sh
```

Verified on prod: after the six-step walk Spot showed last **210**, 24h high
**220**, 24h low **205**, volume **886**, and the recent-trades list populated.
It is a write test (funding/orders; tokens minted only on the first step).

For raw throughput of the same class, `../blockchain/helper/prod/prodorderloop.sh`
accepts `ORDER_COUNT`, `AMOUNT_JITTER_PCT`, `PRICE_JITTER_PCT`, `LOOP_ITERS`,
`PAUSE_SEC`, `MAX_FAILS`.

## L0 → L1 bridge

`e2e/prod-bridge-smoke.sh` runs the opt-in `RemoteBridgeIT` against the
deployed stack: it locks a small BIG UTXO in the L0 bridge vault with
`PegInInfo{chainId=ordermatch}`, submits `processPegIn`, and waits for the
L1-order `PegInWatcher` to mint the wrapped amount to the beneficiary. The
first successful run moved **0.1 BIG** and observed **100000 sat** minted on
`https://ordereu1.bigtangle.org/`.

```bash
# one-time: fund the deterministic L0 test wallets
FUND_L0=1 FUND_L1=0 FUND_UTXOS=8 \
  bash ../blockchain/helper/prod/fund-test-wallets.sh

# real peg-in (moves funds; the amount stays locked in the vault)
./e2e/prod-bridge-smoke.sh
BRIDGE_AMOUNT_BIG=0.05 ./e2e/prod-bridge-smoke.sh
DRY_RUN=1 ./e2e/prod-bridge-smoke.sh
```

`prod-soak.mjs` still includes the read-only L0 `getBridgeInfo` preflight as
part of the `chain` target, so bridge health/vault availability is covered by
the long-running soak without moving funds.
