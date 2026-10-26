# Prediction chain: remote production soak

Long-running **write** simulation against the deployed L1-prediction chain
(`predicteu1`/`predicteu2`/`predicthk1`). It is the prediction counterpart of
`e2e/prod-order-soak.sh` (order chain) and `e2e/prod-soak.sh` (read-only probe);
no local infra is started and the normal e2e suite never runs it.

```bash
./e2e/prod-prediction-soak.sh                    # 10 iterations
./e2e/prod-prediction-soak.sh 5                  # 5 iterations
PREDICTION_SOAK_SECONDS=14400 ./e2e/prod-prediction-soak.sh   # 4h budget
DRY_RUN=1 ./e2e/prod-prediction-soak.sh          # plan + read-only preflight
```

## What one iteration does

`e2e/prod-prediction-soak.sh` runs the remote suite
`net.bigtangle.server.remote.RemotePredictionIT` against the **live** node
(`helper/prod/prodtest.sh`, so every iteration is one `mvn test` with its own
log). Each test mints a fresh market with random token ids, so a run keeps
accumulating real markets instead of reusing one:

| test | exercises |
|---|---|
| `testCreateSplitMergeLifecycle` | YES+NO fixed supply → contract token → `create` (escrow S/S) → `split` (C collateral → C YES + C NO) → `merge` (C YES + C NO → C collateral) |
| `testStakedMarketCreateSplit` | staked-optimistic market (no committee): config on-chain, `create` → `split` |
| `testMultiOutcomeCreateSplitMerge` | 3-outcome market: `create` → `split` → `merge` over the complete set |

That covers the paths unit tests cannot: contract-event submission through the
mempool, engine execution (`confirmPredictionExecution`), the beacon
confirmation and the coinbase payout — on production.

Choose a narrower surface with `PREDICTION_TESTS`, e.g.
`PREDICTION_TESTS=net.bigtangle.server.remote.RemotePredictionIT#testCreateSplitMergeLifecycle`.

## Per-iteration assertions

On top of the suite's own balance/state assertions the harness checks:

- **chain progress** — `getChainNumber().txReward.chainLength` grew by at least
  `PREDICTION_MIN_CHAIN_ADVANCE` (default 1). A soaking chain that stops
  producing blocks is a failure, not a slow run.
- **markets are visible where users look** — `searchContractTokens` (the
  endpoint the wallet Predict page lists) grew by at least
  `PREDICTION_MIN_NEW_MARKETS` (default 1). A market accepted by the mempool
  but missing from the read API would not show up in the app.

Both have their own failure line in the iteration log, and the run exits
non-zero if any iteration fails (`MAX_FAILS`, default 2, aborts early).

## Funding prerequisite (one-time)

The prediction chain mints **no BIG at genesis**: funds arrive only as a bridge
peg-in from L0. The suite signs with the shared test wallet (ML-DSA seed
`0x01`, the genesis key), so that wallet needs BIG on the prediction chain for
token/contract fees plus the split collateral
(`SPLIT_AMOUNT` = 100000 sat = 0.1 BIG per market).

`e2e/prod-bridge-smoke.sh` funds it by pinning the peg-in beneficiary to that
key (`-Dbridge.beneficiarySeed`, added for this purpose):

```bash
BRIDGE_CHAIN_ID=prediction \
BRIDGE_AMOUNT_BIG=1 \
BRIDGE_BENEFICIARY_SEED=$(printf '01%.0s' {1..32}) \
PROD_L1_URL=https://predicteu1.bigtangle.org/ \
  ./e2e/prod-bridge-smoke.sh
```

The smoke waits for the prediction node's `PegInWatcher` to mint and fails if it
never does. Note the tool locks the **whole source UTXO** it picks (≥ the
requested amount) and mints it 1:1 — a `BRIDGE_AMOUNT_BIG=1` run against a
50-BIG UTXO locks and mints 50 BIG, which is plenty for a soak (each iteration
spends ~0.2 BIG of split collateral plus fees). Peg-ins are one-way, like every
bridge smoke: the locked amount stays in the L0 vault.
`PREDICTION_FUND=1` makes the soak run this peg-in automatically the first time
an iteration cannot pay a fee.

Reaching the funding gate means the **prediction node must run with the bridge
enabled**: `BRIDGE_VAULT_PUBKEY` (the L0 vault), `BRIDGE_ISSUANCE_PUBKEY` /
`BRIDGE_ISSUANCE_PRIKEY` and `ANCHOR_L0_URL` — see
`../blockchain/helper/prod/prod-prediction.sh` (`up`). Without them the peg-in
finalises on L0 and is skipped on prediction, so the soak keeps failing at
`InsufficientMoney [1000:bc]`.

## Knobs

| env | default | meaning |
|---|---|---|
| `PREDICTION_URL` | `https://predicteu1.bigtangle.org/` | prediction API under test |
| `PROD_URL` | `https://eu1.bigtangle.org/` | L0 API (fees/peg-in source) |
| `PROD_L1_URL` | `https://ordereu1.bigtangle.org/` | L1-order API (prodtest preflight) |
| `NET_PARAMS` | `main` | network params for the test client |
| `PREDICTION_TESTS` | whole `RemotePredictionIT` | class or `Class#method` |
| `PREDICTION_SOAK_ITERS` | `10` | iterations (or first positional arg) |
| `PREDICTION_SOAK_SECONDS` | `0` | optional wall-clock budget |
| `PREDICTION_MIN_CHAIN_ADVANCE` | `1` | blocks required per iteration |
| `PREDICTION_MIN_NEW_MARKETS` | `1` | markets required per iteration |
| `PREDICTION_PREFLIGHT_SEC` | `15` | window used to prove the chain advances |
| `PREDICTION_FUND` / `PREDICTION_FUND_BIG` | `0` / `1` | auto peg-in on a dry wallet |
| `PREDICTION_FUND_WAIT_SEC` | `900` | how long to wait for the minted BIG to become spendable |
| `MAX_FAILS` | `2` | abort after N failed iterations |
| `LOG_DIR` | `e2e/test-results/prediction-soak-<ts>` | per-iteration logs |

## Reading a run

```
=== Summary: 3 passed, 0 failed (of 3 run) ===
  PASS  iter 1  212s  head 5727->5749  markets 0->3
  PASS  iter 2  206s  head 5749->5771  markets 3->6
```

- `head a->b` — chain length before/after the iteration (the write load and the
  validators' progress).
- `markets a->b` — contract tokens visible through `searchContractTokens`, i.e.
  what the Predict page shows.
- A `FAIL` line prints the last 25 lines of that iteration's log; the full log
  (and, when the suite could not pay a fee, the exact funding command) is in
  `LOG_DIR`.
