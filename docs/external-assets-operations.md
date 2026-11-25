# Operations plan — run HKD, USD, Gold (GOLD) and ETH/ERC-20

**Status: runbook draft.** Companion to
[`external-assets-order-trade.md`](./external-assets-order-trade.md) (design) and
[`external-assets.md`](./external-assets.md) (distributor rail, implemented).
Phases that depend on unbuilt tooling are marked **[P1]** / **[P2]**.

Audience: whoever is on call for the order chain and the issuer service.

---

## 0. Operating principles

1. **L0 is read-only for this work.** Nothing here changes L0 consensus,
   storage, schema or deployment. If a step seems to need an L0 change, stop.
2. **Four tradable tokens, many deposit rails.** Never mint a token per external
   instrument. Rails convert into the four; nothing is wrapped.
3. **Pinned images only.** `IMAGE_TAG` is required by `prod-order.sh`; `latest`
   is refused for a reason. Same for the issuer service.
4. **One decimals constant: 6.** Any asset that cannot be represented at 6 is
   not listed.
5. **Finality, not confirmations.** Ethereum `finalized` before mint; L1
   finality before releasing ETH or fiat.
6. **Secrets never touch a shell history, a log, or a ticket.** Validator keys
   use the keystore-file path in `../blockchain/pass.md`; custody keys live in
   HSM/MPC.
7. **Java first.** Protocol questions are answered in `../blockchain`, not by
   patching the TypeScript client.

---

## 1. Topology and prerequisites

| Component | Where | Notes |
|---|---|---|
| L0 settlement | existing prod nodes | must be reachable; unchanged |
| `l1-order-server` mesh | `helper/prod/prod-order.sh` (5 nodes: eu1–eu5) | Caddy TLS in front, `--network host`, per-node postgres DB |
| Postgres per order node | host-local | `DB_NAME=ordermatch`, distinct per co-located node |
| Kafka (optional transport) | 3 prod mirrors | `RUN_KAFKA=false` is supported |
| ETH RPC + address index | region proxies `/eth`, `/ethindex` | `ETH_RPC_URL`, `ETH_INDEX_URL` in `wallet/deploy/env/.env.eth.<region>` |
| Issuer service **[P2]** | new `wallet/services/asset-issuer` | implements the `services/distributor.ts` contract |
| Wallet web/native | `wallet/deploy/deploy.sh`, `deploy.apk.sh` | `/eth` proxy per region |

**Access required before starting:** SSH to the order hosts (jump host per
`prod-order.sh`), postgres on each host, the key directory
`/home/jcui/keys/validators`, and the ETH custody HSM/MPC ceremony.

**Pre-flight verification (must pass before any deploy):**

```bash
cd ../blockchain
mvn -q -DskipTests package
mvn -B verify
helper/check-layer-deps.sh          # no L0↔L1 import violations
cd ../wallet/expo-app
npx tsc --noEmit
npx vitest run sources
```

---

## 2. Secrets inventory

| Secret | Location | Used by | Rotation |
|---|---|---|---|
| Order validator keys ×5 | `/home/jcui/keys/validators/ordermatch-*.env` or keystore files (`pass.md`) | `POS_VALIDATOR_KEY` per node | per `pass.md` §6, one node at a time |
| Bridge issuance key (mint signer) | `issuance-order.env` → `BRIDGE_ISSUANCE_PUBKEY/PRIKEY` | wrapped-BIG issuance for `ordermatch` | planned; M-of-N target |
| L0 vault pubkey | exported `BRIDGE_VAULT_PUBKEY` at deploy | peg-in/peg-out | vault ceremony |
| `SERVER_APIKEY` | `issuance-order.env` | guards mutating PoS/API calls | quarterly |
| Postgres creds | host-local | each node | on host rebuild |
| **Token issuer keys** (HKD/USD/GOLD/ETH) **[P1]** | HSM/MPC, M-of-N | token creation + reissuance | never hot; ceremony only |
| **ETH custody** hot/cold keys | HSM/MPC; hot wallet limited balance | deposit sweep, withdrawal release | hot key rotated on schedule |
| Bank + vault operator credentials | secrets manager | reserve ledger, mint/redeem ops | per provider policy |
| Issuer API bearer tokens | `services/distributor.ts` device KV (user) / server-side (ops) | wallet ↔ issuer | rotate on staff change |

Rule: the four **token issuer keys are not validator keys and not custody
keys.** Separate custody domains, separate ceremonies.

---

## 3. Phase 0 — bring the chain up (if not already running)

Only needed on a fresh environment; an existing prod mesh skips to Phase 1.

```bash
cd ../blockchain
export POS_VALIDATOR_KEYS="$(grep -h ^POS_VALIDATOR_KEY= \
  /home/jcui/keys/validators/ordermatch-*.env | cut -d= -f2 | paste -sd, -)"
set -a; . /home/jcui/keys/validators/issuance-order.env; set +a
IMAGE_TAG=<pinned> BRIDGE_VAULT_PUBKEY=<l0-vault> helper/prod/prod-order.sh up
helper/prod/prod-order.sh status
```

Checks:

- `status` reports every node healthy on its API port.
- `getAnchors` on the L1 returns anchors reaching L0 (cross-layer alive).
- L0 `getBridgeInfo` reports the vault address/script expected.

Funding and staking (order genesis mints no BIG):

1. Peg-in from L0 with the `ordermatch` chain id using the fund helper in
   `helper/prod/prod-social-fund.sh` (see its header for `pegin`).
2. `stakeDeposit` + `activateValidator` on the order endpoints until the
   validator set is at quorum.
3. Confirm L1 BIG balance is spendable before creating anything.

> Token creation and `StablecoinPolicy` both pay `Coin.FEE_DEFAULT` in BIG
> (design §4.3), so this peg-in is also the issuer's fee source. `asset-issue.sh
> preflight` refuses to continue without a spendable BIG output.

---

## 4. Phase 1 — issue the four tokens

Tooling: `helper/prod/assets/AssetIssueTool.java` driven by
`helper/prod/asset-issue.sh`. It runs single-file Java against the unpacked
`l1-order-server` exec jar, the same pattern as `PegInTool` / `SocialFundTool`,
and only touches the L1 order chain.

```bash
cd ../blockchain
export WALLET=/path/to/issuer.json
export L1_URL=https://ordereu1.bigt-ai.org
export SERVER_NET=Mainnet            # or Test
export ISSUER_SIGNERS=<pubkey1>,<pubkey2>,<pubkey3>
export ISSUER_M=2

helper/prod/asset-issue.sh preflight          # fail-closed gate, moves nothing
ALLOW_MAINNET=1 helper/prod/asset-issue.sh create HKD "HKD Stablecoin" 6 0 currency \
  "asset.class=stablecoin,asset.currency=HKD,asset.jurisdiction=HK"
ALLOW_MAINNET=1 helper/prod/asset-issue.sh sign <tokenid>   # once per custodian
ALLOW_MAINNET=1 helper/prod/asset-issue.sh mint <tokenid> 1000000
ALLOW_MAINNET=1 helper/prod/asset-issue.sh policy <tokenid> ALLOWLIST 1 addresses.txt
helper/prod/asset-issue.sh show <tokenid>
```

- `preflight` prints chain id, issuer address/pubkey, spendable BIG and
  `PREFLIGHT=OK|BLOCKED`. It blocks when the wallet has no BIG for the creation
  fee (fund it with a vault peg-in first) or the chain does not allow
  `TOKEN_CREATION`.
- `create` refuses any decimals other than 6, refuses a token that already
  exists, and prints `TOKENID=`, `TOKEN_INDEX=`, `SIGNNUMBER=`. It also prints
  `NEXT=` with the exact `sign` command.
- `sign` submits exactly one multi-signature round for the invoking wallet; run
  it from each custodian until the threshold is met.
- `mint` is reissuance to the issuer wallet (distribution to holders is a
  normal transfer, so the issuer signature never targets a third-party
  address). It refuses a stopped token and prints `NEXT=sign` when the
  threshold is above 1.
- `policy` hashes each address in `addresses.txt`, sorts and commits the list
  root, and pays the BIG fee in the same transaction.
- `show` prints decimals, supply, signnumber, block and every `asset.*`
  keyvalue — use it as the post-issuance acceptance check.

Per asset, in this order — ETH last, because it needs the custody rail first:

| Token | `tokenid` | Decimals | Initial supply | Policy |
|---|---|---|---|---|
| `HKD` | issuer pubkey | 6 | 0 (mint on bank credit) | allowlist + pause |
| `USD` | issuer pubkey | 6 | 0 | allowlist + pause |
| `GOLD` | issuer pubkey | 6 | 0 | denylist + pause-on-audit |
| ETH token | issuer pubkey | 6 | 0 | denylist |

Steps per token:

1. Ceremony: unlock the issuer key at threshold (no single operator).
2. `preflight` → `create` with `signnumber = M`, `tokenstop = false`, and the
   `asset.*` keyvalues from design §3.
3. `sign` from each custodian until the threshold is met; `show` to confirm.
4. Publish the initial `StablecoinPolicy` block (`policy`).
5. Record in the asset register: tokenid, txid, policy hash, attestation hash,
   issuer, decimals, date.

**Acceptance:** all four are queryable with `show`, decimals are 6, supply is 0,
and a 1-unit reissuance to a staging address succeeds and is reversible by burn.

**Hard checks:**

- `orderPriceShift` behaviour: quote shift 6 for every non-`bc` base — verify a
  price round-trip on each new base token before enabling markets.
- Max price/amount ceilings (design §4.2) with boundary vectors in a Java L1
  test, not by hand.

---

## 5. Phase 2 — ETH / ERC-20 custody rail **[P2]**

### 5.1 Transport

Per region, in `wallet/deploy/env/.env.eth.<region>`:

```
ETH_RPC_URL=<provider or own node>
ETH_INDEX_URL=<address index for native deposits>
```

Deploy/refresh with `wallet/deploy/region.sh`; verify `GET /eth` and
`GET /ethindex` from the region, and that **no provider key ships in the app
bundle** (the proxy holds it).

### 5.2 Custody

1. Ceremony: create cold (MPC/HSM) and hot wallets. Record addresses; publish
   the cold address set for proof-of-reserves.
2. Hot wallet holds only the withdrawal float; refill from cold on a threshold
   and an approval.
3. Per-asset mint caps and per-user deposit caps in the issuer config.
4. Per-asset custody addresses — do not receive everything to one address.

### 5.3 Watchers

- **ERC-20**: `eth_getLogs` on `Transfer` to the custody address; idempotency
  `(txHash, logIndex)`. Cheaper and more reliable than the address index.
- **Native ETH**: address-index scan via `/ethindex`.
- Mint only at Ethereum `finalized`. Record the finalized block number with
  every mint.

### 5.4 Adding an ERC-20 later

Config row only (no app release if decision 7 lands server-driven):

```text
{ assetId, chainId, contract, symbol, underlyingDecimals,
  l1Decimals: 6, mintCap, minDeposit, custodyAddress, enabled }
```

Refuse at intake: fee-on-transfer, rebasing, ERC-777 hooks, undisclosed
arbitrary mint. Pausable/blacklistable only with disclosure.

---

## 6. Phase 3 — issuer service **[P2]**

The service owns its **own** Postgres — never a chain node's database
(`ordermatch`/`info`). `deploy/compose.asset-issuer.yml` provisions
`postgres:16-alpine` with the `asset_issuer` database, its own role, volume and
password, and mounts `services/asset-issuer/schema.sql` into the init directory.

```bash
REGION=europa ASSET_ISSUER_DB_PASSWORD=<secret> \
  docker compose -f deploy/compose.asset-issuer.yml up -d
```

Verify a fresh database (all of these pass against Postgres 16):

```bash
docker exec -i wallet-asset-issuer-europa-db \
  psql -v ON_ERROR_STOP=1 -U asset_issuer -d asset_issuer \
  < services/asset-issuer/schema.sql
DATABASE_URL=postgres://asset_issuer:<secret>@127.0.0.1:55432/asset_issuer \
  npx tsx services/asset-issuer/test/pg-smoke.ts   # -> RESULT=OK
```

Environment:

```
POSTGRES_URL=postgres://asset_issuer:<secret>@db:5432/asset_issuer
NETWORK=Test                 # required outside Test: refuses in-memory
ASSETS_JSON=                 # optional cap/decimals override
ETH_RPC_URL=...              # server-side, not the public proxy
ISSUER_KEYFILES=...          # M+of+N, HSM/MPC backed (mint/release executor)
API_TOKEN=...                # bearer the wallet presents
```

Schema: `assets`, `reserves`, `operations` (idempotency + state machine),
`holder_balances`, `attestations`. The database itself enforces
`supply_raw <= reserve_raw` and refuses to rewrite a `completed` operation.

Endpoints must match `services/distributor.ts` exactly: `/assets`, `/balances`,
`/statement`, `/transfers`, `/mint-requests`, `/redeem-intents`,
`/transfers/<id>`, plus `/health` and `/metrics`. `/mint-requests` needs the
operator `MINT_API_TOKEN` (header `x-mint-token`); `/redeem-requests` is retained
only to reject the unsigned path.

### 6.1 Runner

The HTTP process serves the wallet; the scanner is a separate invocation of the
same image:

```bash
# one pass: scan deposits/redemptions -> execute -> attest -> report (cron)
docker run --rm --env-file deploy/env/.env.issuer.europa \
  wallet-asset-issuer:latest node dist/cli.js once

# continuous (default 60 s)
… node dist/cli.js loop

# solvency check; exit 1 on a breach (wire this into monitoring)
… node dist/cli.js health
```

Adapter switches, all optional and fail-closed:

| Env | Effect when set |
|---|---|
| `ETH_RPC_URL` | scans ERC-20 `Transfer` logs into each asset's `custodyAddress` |
| `L1_URL` + `L1_ISSUER_KEY` | enables minting and verifies redemption funding (`serve` also needs it, read-only) |
| `ALLOW_LIVE_L1=1` | **required** to actually sign a mint |
| `FROM_BLOCK` | seeds the persisted deposit scan cursor (`scan_cursors`) for a chain seen for the first time |
| `MINT_API_TOKEN` | operator credential for `/mint-requests`; empty disables the route |
| `INTERVAL_MS` | loop interval |

Nothing signs without `ALLOW_LIVE_L1=1`, so a staging pass is safe by default.

### 6.2 Adapter status (read before go-live)

| Adapter | State |
|---|---|
| EVM deposits (`src/chain.evm.ts`) | implemented — ERC-20 logs + `finalized`; **native ETH needs the address index**, not yet wired |
| L1 mint (`src/l1.bigt-ai.ts`) | implemented and **verified on the Java L1-order infra** (issuance + reissuance). Reissue → drain `getTokenSignByTokenid` → pay; the **domain key** is required on top of the issuer key |
| L1 redemptions | implemented as **intent + L1 return**: the signed intent names the funding tx and a confirmed output of the exact token/amount to `redemptionAddress` is required; one L1 reference backs one release |
| Deposit cursor (`src/watcher.ts`, `src/cli.ts`) | implemented — advances window by window to the finalized head, only after each window commits |
| Release (`Treasury`) | **not implemented** — `RefusingTreasury` fails loudly; redeem stays closed until the HSM/MPC adapter + approval flow exist |

**First live run (Test only), one asset at a time:**

1. `health` — expect `ok: true`, `breaches: []`.
2. `once` with `ALLOW_LIVE_L1` **unset** — nothing signs; check the pass reports
   the deposits it found.
3. Mint one unit with `ALLOW_LIVE_L1=1` against a staging holder address. The
   pass must drain pending signatures (`getTokenSignByTokenid` empty) before
   paying, otherwise the mint sits unsolid and the token index never moves.
4. `health` again — reserve must have dropped by exactly one unit and supply
   risen by one; `breaches` must stay empty.
5. Only then raise the caps.

Mandatory jobs:

| Job | Invariant / action |
|---|---|
| Deposit scanner | no mint before Ethereum finality; idempotent |
| Withdrawal queue | no release before L1 finality; batched; approval above threshold |
| Reconciliation | `L1 supply ≤ external reserve` per asset; alert on breach |
| Attestation | publish `asset.reserveAttestation` hash on a fixed cadence |
| Dust | track sub-unit residue from 18→6 conversion per asset |

**Acceptance:** on staging, one deposit and one withdrawal per asset with the
issuer stopped mid-flight — no double mint, no double release, state resumes
cleanly.

---

## 7. Phase 4 — wallet and markets **[P3]**

1. Registry entries for `HKD`, `USD`, `GOLD`, ETH token with
   `orderTrading.enabled=true`; every external instrument stays `false`.
2. `QUOTE_SYMBOLS` in `app/trade.tsx` gains `HKD`, `USD`, `GOLD`, ETH ticker.
3. `lib/markets.ts`: six launch pairs (design §4.1), tick size, max order.
4. Deposit/withdraw: bank/vault instructions for fiat and gold; issuer credit
   for the ETH token; network badge everywhere.
5. Deploy web (`deploy/deploy.sh`) and Android (`deploy.apk.sh`); confirm the
   `/eth` proxy on each region.

**Acceptance:** a staging user can deposit, see balance, place and cancel an
order, match against a seeded counter-order, and withdraw — on all six pairs.

---

## 8. Phase 5 — go-live gates

Each asset launches independently. A gate is not "code merged"; it is:

| Gate | HKD | USD | GOLD | ETH token |
|---|---|---|---|---|
| Legal sign-off | required | required (heaviest) | required | required |
| Reserve account/vault live + first attestation | required | required | required (bar list) | required (PoR) |
| Issuer key ceremony (M-of-N) | required | required | required | required |
| Market maker / seeded quotes | required | required | required | required |
| Canary limits (per-user and global) | 7 days | 7 days | 7 days | 7 days |
| Incident runbooks rehearsed (§9) | required | required | required | required |

Canary means small caps that are raised only after a clean week with zero
reconciliation breaches.

---

## 9. Day-2 runbooks

**R1 — Deposit not credited.** Check watcher is on the right custody address;
check `finalized` (not just confirmed); check `(txHash, logIndex)` wasn't
already consumed; check the token's `StablecoinPolicy` isn't paused; then
replay the operation idempotently.

**R2 — Withdrawal stuck.** Distinguish L1 burn pending (wait), burn confirmed
but not finalized (wait), release queued (check hot-wallet balance and gas), or
policy paused (unpause requires the same M-of-N as minting). Never "just send
it" from a different wallet.

**R3 — Reserve mismatch.** Immediately pause the affected asset
(`StablecoinPolicy.paused`), stop mints, and reconcile the ledger against the
bank/vault/custody statement. Do not resume until the difference is explained
to the wei.

**R4 — RPC outage / reorg.** Mints stop (no finality). Verify the finalized
block number didn't regress; if the provider is inconsistent, switch base via
the region config, not by patching the app.

**R5 — Order node wedged/forked.** `prod-order.sh resync <node>` (targeted; the
others stay up). Then confirm anchors resume and the L1 balance is intact.

**R6 — Suspected key compromise.** Pause the asset, freeze the issuer key,
rotate to the next M-of-N share, publish an incident note. For ETH, pause the
withdrawal queue before rotating the hot wallet.

**R7 — Emergency unwind.** Pause → stop mints → allow redemptions only →
reconcile → publish. Never unwind by transferring reserves to insiders.

---

## 10. Monitoring and alerting

| Signal | Source | Page? |
|---|---|---|
| Node health / API | `prod-order.sh status`, `/actuator/health` | yes |
| Anchor freshness per node | `getAnchors` | yes (> expected interval) |
| `supply ≤ reserve` per asset | issuer reconciliation | yes |
| Pending withdrawal age | issuer queue | yes (> SLA) |
| Failed mints / duplicate guards hit | issuer operations table | yes |
| Policy paused | on-chain policy read | yes |
| Hot-wallet balance / gas | ETH RPC | yes (low) |
| Disk, heap, DB size | node metrics | warn |
| `/eth` 5xx rate | Caddy | warn |

Dashboards per asset: supply, reserve, pending queue, last attestation age,
24h minted/redeemed. Keep one row per asset — do not aggregate, because a
breach in one is not diluted by the others.

---

## 11. Change management

- Mutating chain deploys: pinned `IMAGE_TAG`, one host at a time, verify each
  (`prod-order.sh up-one <idx>`).
- Any change to `bigt-ai-servercore`, `l1-order-server` or the bridge runs
  `mvn -B verify` + `helper/check-layer-deps.sh` and needs the L0 scoping,
  reward and store-schema tests green.
- Issuer service changes ship behind a flag with a rollback that never touches
  the reserve ledger.
- **Rollback rule:** you can always pause minting; you must never "roll back" a
  mint by editing the ledger. Burn or pause, and record why.

---

## 12. Open operational decisions

1. Who operates the issuer service and the ETH hot wallet — one team or split
   duty (mint vs release)?
2. HSM/MPC vendor and threshold for the issuer keys; who holds which share.
3. Attestation cadence and auditor per asset.
4. Canary limits and the exact promotion criteria.
5. On-call ownership for the issuer service vs the chain.
6. Whether Kafka stays enabled for the order chain during launch
   (`RUN_KAFKA`), and who owns the purge procedure.

---

**See also:** [`external-assets-order-trade.md`](./external-assets-order-trade.md),
[`external-assets.md`](./external-assets.md), [`ethereum.md`](./ethereum.md),
`../blockchain/helper/prod/prod-order.sh`, `../blockchain/helper/prod/cutover-runbook.md`,
`../blockchain/helper/prod/golive-plan.md`, `../blockchain/pass.md`.
