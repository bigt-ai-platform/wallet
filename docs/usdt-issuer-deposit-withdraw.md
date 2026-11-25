# USDT end-to-end: issuer, deposit and withdraw (worked example)

This is the complete, operator-facing walkthrough of one bridged asset, **USDT**,
from token issuance on `L1-order` through a user deposit from Ethereum and back
out again. Other assets (`USDC`, `HKD`, `GOLD`, …) follow the same shape with a
different contract, decimals and custody address.

Two implementations exist and they are deliberately separate:

| Rail | Client | Contract | Status |
|---|---|---|---|
| **USDT deposit page** (`/deposit`) | `expo-app/sources/services/ethBridge.ts` | `GET /deposit-address`, `GET /deposits` | **Wired**; the issuer side is yours to run |
| **Generic issuer service** (`services/asset-issuer`) | `expo-app/sources/services/distributor.ts` | `/assets`, `/balances`, `/statement`, `/transfers`, `/mint-requests`, `/redeem-requests` | Implemented/tested; USDT needs an `ASSETS_JSON` row |
| **Self-custody EVM withdraw** (`/withdraw`) | `expo-app/sources/services/eth.ts` | none (signs and broadcasts) | **Wired**, works for USDT today |

Read the "Known gaps" section (§6) before promising a production date: the
bridge **deposit** leg is complete, the **redeem/release** leg still fails
closed until a treasury adapter exists.

---

## 0. The model in one picture

```
        Ethereum mainnet                         L1-order (bigt-ai)
  ┌──────────────────────────┐            ┌──────────────────────────────┐
  │ user's 0x… wallet        │            │ user's base58 L1 wallet      │
  │   USDT (ERC-20, 6 dp)    │            │   USDT token (6 dp)          │
  └────────────┬─────────────┘            └──────────────▲───────────────┘
               │ transfer                                  │ reissue + pay
               ▼                                           │ (issuer L1 key)
  ┌──────────────────────────┐   watcher   ┌───────────────┴──────────────┐
  │ issuer custody address   │────────────▶│ asset-issuer service         │
  │ (Ethereum)               │  finalized  │ Postgres: reserve, supply,   │
  └──────────────────────────┘             │ operations, idempotency      │
               ▲                           └───────────────┬──────────────┘
               │ release (Treasury, HSM/MPC)               │ observe L1 transfer
               └───────────────────────────────────────────┘
                     redeem: user sends L1 USDT to redemptionAddress
```

1. **Deposit** = external USDT arrives in issuer custody → issuer mints/credits
   the same number of L1-order USDT to the user's L1 address.
2. **Withdraw** = either
   * **self-custody**: the user sends USDT they already hold on Ethereum from
     their own EVM key (no issuer involved), or
   * **redemption**: the user sends L1 USDT to the issuer's redemption address
     and the issuer releases ERC-20 USDT from custody.
3. The issuer's books must always satisfy **`supply ≤ reserve`** per asset.

Amounts: USDT has **6 decimals on both sides**, so no conversion dust. (The
converter still tracks dust for 18→6 assets such as ETH.)

---

## 1. Roles, components and files

| Component | Where | What it does |
|---|---|---|
| L1-order mesh | `../blockchain`, `helper/prod/prod-order.sh` | Hosts the L1 USDT token |
| Issuance tool | `../blockchain/helper/prod/asset-issue.sh` (+ `AssetIssueTool.java`) | `create` / `sign` / `policy` / `mint` / `show` |
| Issuer service | `services/asset-issuer` | Watches EVM deposits, mints on L1, scans redemptions, keeps the reserve ledger |
| Issuer database | its **own** Postgres (`deploy/compose.asset-issuer.yml`) | `assets`, `reserves`, `operations`, `holder_balances`, `deposit_addresses`, `attestations` |
| Per-user addresses | `services/asset-issuer/src/depositAddress.ts`, `src/depositService.ts` | BIP32 xpub → address; idempotent allocation per L1 account |
| Sweeper | `services/asset-issuer/src/sweep.ts`, `src/sweep.evm.ts`, `src/ethTx.ts` | plan/live consolidation of deposit addresses into the omnibus |
| Wallet deposit page | `expo-app/sources/app/deposit.tsx` | Coin → network → address/QR → history |
| Wallet withdraw page | `expo-app/sources/app/withdraw.tsx` | Asset → network → recipient/amount/fee → sign |
| Bridge client | `expo-app/sources/services/ethBridge.ts` | `deposit-address` / `deposits` + device overrides |
| Asset registry (page) | `expo-app/sources/lib/depositAssets.ts` | `USDT@Ethereum`: contract, 6 dp, 12 confirmations |
| EVM signer | `expo-app/sources/services/eth.ts`, `lib/eth/*` | EIP-1559 sign, ERC-20 `transfer`, receipts |

---

## 2. Prerequisites

- [ ] L1-order mesh healthy (`prod-order.sh status`), anchors reaching L0.
- [ ] Issuer L1 wallet file with **spendable BIG** (creation and policy pay a
      BIG fee; the L1 genesis mints no BIG). Fund it with a vault peg-in.
- [ ] Issuer M-of-N key plan: `ISSUER_SIGNERS` + `ISSUER_M`, stored in
      HSM/MPC (never a shell history).
- [ ] Ethereum custody: cold + hot addresses; the hot wallet only holds the
      withdrawal float.
- [ ] RPC access for the issuer (`ETH_RPC_URL`; server-side, not the public
      `/eth` proxy).
- [ ] Postgres for the issuer (`ASSET_ISSUER_DB_PASSWORD`) — never a chain
      node's database.
- [ ] Polar-check the wallet build: `npx tsc --noEmit && npx vitest run sources`
      in `expo-app`, and `npx vitest run` in `services/asset-issuer`.

---

# Part A — Issuer setup

## A1. Issue the L1 USDT token

The token lives **only** on the order chain (L0 forbids
`BLOCKTYPE_TOKEN_CREATION`). The `tokenid` of a self-issued token is the issuer
public key.

```bash
cd ../blockchain

export WALLET=/secure/issuer/usdt-issuer.json     # encrypted keystore preferred
export L1_URL=https://ordereu1.bigt-ai.org
export SERVER_NET=Mainnet
export ISSUER_SIGNERS=<pub1>,<pub2>,<pub3>
export ISSUER_M=2

# 1. Fail-closed preflight: prints chain id, issuer address/pubkey,
#    spendable BIG and PREFLIGHT=OK|BLOCKED. Moves nothing.
helper/prod/asset-issue.sh preflight

# 2. Create. Decimals MUST be 6. Initial supply 0; mint on bank/custody credit.
ALLOW_MAINNET=1 helper/prod/asset-issue.sh create USDT "Tether USD (custodial)" 6 0 currency \
  "asset.class=stablecoin,asset.currency=USD,asset.backing=ERC20-USDT,asset.jurisdiction=..."

#    -> prints TOKENID=, TOKEN_INDEX=, SIGNNUMBER=, NEXT=<sign command>
export TOKENID=<printed tokenid>

# 3. One multi-sign round per custodian until the threshold is met.
ALLOW_MAINNET=1 helper/prod/asset-issue.sh sign "$TOKENID"   # run from each signer

# 4. Publish the policy (allowlist/denylist + pause). Optional but recommended.
ALLOW_MAINNET=1 helper/prod/asset-issue.sh policy "$TOKENID" ALLOWLIST 1 addresses.txt

# 5. Mint initial float to the ISSUER wallet only.
ALLOW_MAINNET=1 helper/prod/asset-issue.sh mint "$TOKENID" 1000000000   # 1000 USDT

# 6. Acceptance check.
helper/prod/asset-issue.sh show "$TOKENID"
```

Acceptance:

- `show` prints `decimals=6`, the expected supply and every `asset.*` keyvalue.
- A **1-unit** reissuance to a staging address succeeds and can be burned back.
- `orderPriceShift` round-trips for a non-`bc` base before any market is
  enabled.

> `mint` reissues to the issuer wallet. Distribution to a holder is a normal
> transfer, or the service's two-step `reissue → pay` (§A6). The issuer
> signature never targets a third-party address directly.

## A2. Prepare Ethereum custody and choose the address model

1. Create the cold and hot wallets (ceremony; record addresses; publish the
   cold set for proof-of-reserves).
2. **Decide how a deposit is attributed.** USDT is an ERC-20: the transfer has
   no memo/tag, so there are only two workable models.

   | | `static` (shared custody) | `per-user` (Binance-style) |
   |---|---|---|
   | Receive address | one `custodyAddress` | one BIP32 address per L1 account |
   | Attribution | the sender (`from`) | **the address itself** |
   | Exchange-origin deposit | ❌ sender is the exchange hot wallet | ✅ |
   | Sweep needed | no | yes, with gas management |
   | Key material | receive address only | xpub to derive; key only to sweep |
   | Implementation | one config row | `depositAddressMode: "per-user"` + `DEPOSIT_XPUB` |

   * **`per-user`** is the right choice if users will withdraw USDT from an
     exchange. The service derives `m/…/<index>` from an account-level xpub, so
     no private key is needed to receive; it stores the mapping in
     `deposit_addresses` and the watcher attributes by destination address.
   * **`static`** is simpler and fine for a closed loop (“send only from this
     wallet”); the issuer falls back to `mapAccount(from)`.
   * A shared address + memo is not available on ERC-20. It is only relevant to
     memo chains and is kept in the config for those rails.

   Binance's addresses are **persistent per user per network**, not temporary
   per deposit. Rotation only happens on wallet maintenance/chain migration.
3. If `per-user`, generate an **account-level xpub** (e.g.
   `m/44'/60'/0'`) on the offline signer and set `DEPOSIT_XPUB`; the private
   half stays in HSM/MPC for sweeping.
4. Fund the hot wallet with the withdrawal float only; refill from cold on a
   threshold and an approval.
5. Set per-asset mint caps and per-user deposit caps.
6. Plan the **sweep**: `npx tsx src/cli.ts sweep` (dry-run) sends each deposit
   address's USDT to the omnibus above a threshold. At ~65k gas, a $5–6 sweep
   makes a $10 minimum uneconomical; set the threshold to several times the gas
   cost. Gas must already sit at the deposit address (the runner skips it
   otherwise).

## A3. Configure the issuer service

`ASSETS_JSON` is the server-side authority (it *replaces* the built-in
defaults, so list every asset you serve). USDT row:

```json
[
  {
    "assetId": "usdt",
    "symbol": "USDT",
    "depositKind": "evm",
    "depositAddressMode": "per-user",
    "depositInstructions": "Send USDT (ERC-20) on Ethereum mainnet to your deposit address. The L1 token is credited after finality.",
    "depositAddress": "0xTheStaticAddressWhenModeIsStatic",
    "referencePrefix": "USDT",
    "contract": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "custodyAddress": "0xYourCustodyAddress",
    "l1TokenId": "<TOKENID from A1>",
    "signers": ["<pub1>", "<pub2>"],
    "signnumber": 2,
    "redemptionAddress": "<base58 L1 redemption address>",
    "externalDecimals": 6,
    "l1Decimals": 6,
    "maxSupplyRaw": "1000000000000000",
    "maxMintRaw": "1000000000000",
    "enabled": true
  }
]
```

In `per-user` mode `depositAddress` is unused (the address comes from
`/deposit-address`); `custodyAddress` is the omnibus/sweep target and a
transfer there is skipped rather than credited to the sender. In `static` mode
`depositAddress` (or `custodyAddress`) is what every user receives.

Rules the service enforces:

- `depositAddressMode` is `static` (default) or `per-user`. The latter needs
  `DEPOSIT_XPUB` in the environment (or a per-asset `depositXpub`); it is not
  kept in this JSON because the xpub is operator material.
- `l1Decimals` is **6** for every listed asset.
- `maxSupplyRaw` / `maxMintRaw` are smallest-unit decimal strings.
- `custodyAddress` + `contract` enable the ERC-20 deposit scanner.
- `l1TokenId` is required to mint; `redemptionAddress` is required to verify a
  redemption's L1 return and **must be a dedicated address of the issuer wallet**
  (the verifier reads that wallet's confirmed outputs). Never use it as a mint
  payout destination.
- `signers`/`signnumber` are the reissuance threshold (default: the issuer key,
  threshold 1).

Start the database and the HTTP service:

```bash
REGION=europa ASSET_ISSUER_DB_PASSWORD=<secret> \
  docker compose -f deploy/compose.asset-issuer.yml up -d

# Fresh DB sanity: apply schema + run the store smoke test -> RESULT=OK
docker exec -i wallet-asset-issuer-europa-db \
  psql -v ON_ERROR_STOP=1 -U asset_issuer -d asset_issuer \
  < services/asset-issuer/schema.sql
DATABASE_URL=postgres://asset_issuer:<secret>@127.0.0.1:55432/asset_issuer \
  npx tsx services/asset-issuer/test/pg-smoke.ts

# HTTP (wallet-facing distributor contract)
NETWORK=Mainnet PORT=8090 DATABASE_URL=... npx tsx services/asset-issuer/src/main.ts
```

Verify:

```bash
curl -s localhost:8090/health
# {"ok":true,"breaches":[]}

curl -s localhost:8090/assets | jq
# items[].assetId == "usdt", decimals == 6, depositKind == "evm"
```

`main.ts` refuses to start outside `NETWORK=Test` without `DATABASE_URL`: losing
idempotency keys on restart is the double-mint this service exists to prevent.

### Deploying with the release train

The stack is part of `deploy/deploy.sh` (image `wallet-asset-issuer`, deployed by
`deploy/region.sh issuer` on `region.conf ASSET_ISSUER_REGION`, default
`APEX_REGION`). Keep the configuration in the gitignored per-region secrets file
instead of the shell:

```bash
cp deploy/env.issuer.example deploy/env/.env.issuer.europa
chmod 600 deploy/env/.env.issuer.europa
$EDITOR deploy/env/.env.issuer.europa     # ASSET_ISSUER_DB_PASSWORD, NETWORK, AUTH_MODE, DEPOSIT_XPUB…
./deploy/region.sh issuer europa          # or ./deploy/deploy.sh for a full release
```

`region.sh issuer` pulls the pinned image, brings up `db`, re-applies the
**idempotent** `services/asset-issuer/schema.sql` (the Postgres init dir only
runs on a fresh volume, so an existing ledger would otherwise miss
`deposit_addresses`/redeem tables before the new image starts), then waits on
`/health`. Every region's Caddy exposes it same-origin at `/issuer/*` (base URL
`/issuer` for the app), so no CORS or public port is needed. Without
`deploy/env/.env.issuer.<region>` the issuer leg is skipped with a warning.

## A4. Run the watcher / executor

```bash
cd services/asset-issuer

NETWORK=Mainnet \
DATABASE_URL=postgres://... \
ASSETS_JSON="$(cat /secure/issuer/assets.usdt.json)" \
ETH_RPC_URL=https://your-private-rpc \
DEPOSIT_XPUB=<account-level xpub> \
DEPOSIT_XPUB_PATH=0 \
DEPOSIT_ASSET_ID=usdt \
L1_URL=https://ordereu1.bigt-ai.org \
L1_ISSUER_KEY=<issuer key from HSM/MPC> \
FROM_BLOCK=<last scanned block> \
ALLOW_LIVE_L1=1 \
npx tsx src/cli.ts loop          # or `once` from cron
```

Commands:

| Command | Use |
|---|---|
| `once` | One `scan → execute → attest` pass (cron/CI) |
| `loop` | Same pass every `INTERVAL_MS` (default 60 s) |
| `attest` | Publish reserve attestations only |
| `health` | Print solvency; **exit 1 on a breach** (wire into monitoring) |
| `serve` | HTTP only |
| `sweep` | Plan (default) or execute the per-user → omnibus consolidation |

Safety defaults:

- Without `ETH_RPC_URL` nothing is scanned.
- `DEPOSIT_XPUB` enables per-user addresses; without it a `per-user` asset
  answers `/deposit-address` with 503 instead of a shared address.
- Without `L1_URL` + `L1_ISSUER_KEY` minting is unavailable.
- Without `ALLOW_LIVE_L1=1` nothing is signed — a staging pass reports what it
  *would* do.
- **`serve` is default-deny outside Test**: set `AUTH_MODE=bearer` +
  `API_TOKEN` (transport auth) or `AUTH_MODE=hmac` + `API_HMAC_SECRET`
  (account-bound; needs a signing client/proxy). With `AUTH_MODE=off` and
  `NETWORK!=Test`, it refuses to start. `/health` stays public.
- **`L1_SIGNER=command` + `L1_MINT_COMMAND`** keeps the L1 key out of this
  process; the HSM/MPC command owns reissue+pay. Local `L1_ISSUER_KEY` is the
  Testnet/small-float path. See [`issuer-hsm-adapter.md`](./issuer-hsm-adapter.md).
- The executor claims operations atomically and re-verifies a chain-observed
  deposit against `eth_getTransactionReceipt` + `finalized` before minting; a
  DB row alone is not proof.
- `FROM_BLOCK` seeds the **persisted scan cursor** the first time a chain is
  seen (`scan_cursors`). Each pass then scans forward window by window to the
  finalized head and advances the cursor only after the window's deposits are
  committed, so a restart resumes and a failed window is retried. Idempotency
  (`(chain, txHash, logIndex)`) still makes overlapping replays safe.

## A5. Expose the endpoints the `/deposit` page speaks

The page calls `services/ethBridge.ts`:

```
GET <api>/deposit-address?account=<account>
  -> { address: "0x…", memo?: "…" }

GET <api>/deposits?account=<account>
  -> { items: [{ hash, amount, status: "pending"|"credited"|"failed", creditedAt? }] }
```

`amount` is in **display units** ("100"), not raw units. Both endpoints are
implemented by `services/asset-issuer/src/server.ts`:

| Page call | Issuer behaviour |
|---|---|
| `GET /deposit-address?account=<L1>[&assetId=usdt]` | `per-user`: look up / derive the address for that L1 account and persist it. `static`: return `depositAddress ?? custodyAddress`. `assetId` defaults to `DEPOSIT_ASSET_ID`, else the first `depositKind: "evm"` asset |
| `GET /deposits?account=<L1>[&assetId=usdt][&limit=50]` | that account's `deposit` operations: `completed → credited` (with `creditedAt`), `failed → failed`, else `pending`; `hash` = the chain `txHash`; amounts formatted at the L1 scale |

The client now sends the **L1 address** to both calls (`deposit.tsx` uses
`publicInfo.address`). An older build sent the EVM account to
`/deposit-address`; if you must support it, accept both and key the mapping by
the L1 account for crediting.

Per-user allocation is idempotent and race-safe: `deposit_addresses` enforces
unique `(asset_id, account)` plus a **globally** unique address and index (so
two assets can never hand the same address to two holders, which would reuse a
sweep nonce), and a losing request re-reads or retries the next index. Apply the
updated `schema.sql` to an existing database (it adds the table;
`CREATE TABLE IF NOT EXISTS` is safe to re-run).

The receive path fails **closed**: `per-user` without `DEPOSIT_XPUB` returns
`503`, never a silent shared address. The HTTP service is default-deny outside
`Test` (`AUTH_MODE=bearer` or `hmac`); keep it behind the region proxy as well.
`hmac` binds a request to its account; `bearer` is only transport auth.

With no API configured, a single static `issuerAddress` is used and deposits are
tracked by the issuer's balance delta (the `BinanceETHPayADDRESS` model).

## A6. Wallet build configuration

Bake the rail in so a fresh install works with no setup:

```bash
EXPO_PUBLIC_ISSUER_API_URL=https://issuer.example \
EXPO_PUBLIC_ISSUER_API_TOKEN=<bearer token, if AUTH_MODE=bearer> \
EXPO_PUBLIC_ISSUER_DEPOSIT_ADDRESS=0xYourCustodyAddress \
EXPO_PUBLIC_ISSUER_MIN_USDT=10 \
  ./webapp.sh …            # or the normal deploy build
```

- Settings → **Ethereum** → Bridge keeps the address/API/minimum fields as an
  operator override (`bridge-api-input`, `bridge-issuer-input`,
  `bridge-min-input`); the bearer token is build-time
  (`EXPO_PUBLIC_ISSUER_API_TOKEN`) and is sent to both `/deposit-address` and
  `/deposits` when `AUTH_MODE=bearer`. That token is visible in the web bundle,
  so it is a coarse gate — inject it at the proxy or use `hmac` (which needs a
  signing client) for real account binding.
- A device value wins **field by field**; otherwise the build-time default
  applies (`services/ethBridge.ts`).
- The minimum is compared in whole USDT (`Number(amount) < minUsdt`).

## A7. Sweep the per-user addresses

```bash
cd services/asset-issuer
DATABASE_URL=… ASSETS_JSON=… ETH_RPC_URL=… \
DEPOSIT_XPUB=… \
SWEEP_MIN_RAW=20000000 SWEEP_GAS_LIMIT=65000 \
npx tsx src/cli.ts sweep                  # plan only (default)

# Production: HSM/MPC signs; no xprv in the process.
ALLOW_LIVE_SWEEP=1 SWEEP_SIGN_COMMAND=/usr/local/bin/sweep-sign \
DATABASE_URL=… ASSETS_JSON=… ETH_RPC_URL=… \
SWEEP_MIN_RAW=20000000 \
npx tsx src/cli.ts sweep

# Testnet/small float: the local key path.
ALLOW_LIVE_SWEEP=1 DEPOSIT_XPRV=… \
DATABASE_URL=… ASSETS_JSON=… ETH_RPC_URL=… \
SWEEP_MIN_RAW=20000000 \
npx tsx src/cli.ts sweep
```

- Reads the ERC-20 and native balance of every allocation, estimates gas
  (`×1.2`, fallback `SWEEP_GAS_LIMIT`), and uses
  `maxFee = 2 × baseFee + tip`.
- Every skip is explained: `omnibus`, `zero`, `below-min`, `no-gas`.
- Live mode derives the key for the allocation and **refuses to sign** if it
  does not control that address. One address's RPC failure is reported while
  the others continue.
- Balance-based, so a crash after broadcast is safe: the next run sees the
  reduced balance.
- Prefer `SWEEP_SIGN_COMMAND` (HSM/MPC) over `DEPOSIT_XPRV`. The xprv is
  signing material: keep it in the sweeper process only; the HTTP service and
  the scanner never receive it.
- The runner does **not** fund gas. Top up deposit addresses yourself, or add a
  native top-up step before sweeping.

## A8. Issuer go-live checklist

- [ ] `show` confirms token id, 6 decimals, supply and policy.
- [ ] `health` returns `ok: true`, `breaches: []`.
- [ ] One `once` pass with `ALLOW_LIVE_L1` **unset** scans nothing and signs
      nothing.
- [ ] One 1-unit mint with `ALLOW_LIVE_L1=1` to a staging holder; pending
      signatures drained; balance visible on L1.
- [ ] Reserve dropped by exactly one unit, supply rose by one, `health` clean.
- [ ] `GET /deposit-address` and `GET /deposits` answer for a real L1 account.
- [ ] `/deposit` shows the address, the 12-confirmation note, the minimum and
      the current L1 USDT balance.
- [ ] Per-user mode: two wallets get two **persistent** addresses, repeating
      `/deposit-address` returns the same value, and a deposit sent from an
      exchange hot wallet is credited to the right L1 account.
- [ ] The sweep job consolidates a deposit address above the threshold (gas
      funded); a sub-threshold balance is left alone.
- [ ] Caps raised only after a clean canary week.

---

# Part B — Deposit (Ethereum USDT → L1 USDT)

## B1. User steps in the wallet

1. Unlock the wallet. The page needs an EVM key: a **legacy EC wallet** or a
   dual-key wallet (PQ primary + EC key). A PQ-only wallet sees
   `deposit-ec-gate` with a link to Keys → *Add Ethereum key*.
2. Sidebar → **TRADE → Deposit** (`/deposit`).
3. **Select Asset** → `USDT` (`deposit-coin-USDT`).
4. **Select Network** → `Ethereum (ERC-20)` (`deposit-network-ethereum`). The
   row shows "Expected arrival · 12 confirmations", the minimum, and where the
   credit lands (the L1-order USDT token). A network on a different chain than
   the configured RPC is disabled with a wrong-chain warning (e.g. mainnet USDT
   while the app is on Sepolia).
5. **Deposit Address**:
   - QR + checksummed address (`deposit-address`), with Copy.
   - Memo/tag when the issuer returns one (`deposit-memo`) — include it.
   - Info rows: network, minimum, arrival, credited-to L1 address, current L1
     USDT balance (`deposit-l1-balance`).
   - Warning: *send only USDT on Ethereum* (`deposit-warning`).
6. Send **USDT (ERC-20)** from an exchange or another wallet to that address.
   **Do not** send USDT on BSC/TRON/Polygon, and do not send ETH.
7. Wait for the confirmations. The issuer credits the L1 address; the page's
   history (`deposit-history`) moves `pending → credited`, and the L1 balance
   updates on the next load.

### Optional: pay from this wallet

Below the address card, **Pay from this wallet** signs an ERC-20 `transfer`
from the wallet's own Ethereum USDT balance to the deposit address:

1. Enter an amount (≥ minimum, ≤ balance) in `deposit-amount`.
2. Tap **Deposit** (`deposit-submit`); approve the transaction sheet (auto under
   `E2E_AUTOCONFIRM`).
3. The app broadcasts, adds a pending history row, shows a notice and refreshes.

This is only the **Ethereum** leg; the L1 credit still comes from the issuer.

## B2. What happens behind the scenes (100 USDT example)

| Step | System | Detail |
|---|---|---|
| 1 | Wallet | `GET /deposit-address?account=<L1>` → `0xUser…` (per-user) or `0xIssuer…` (static) |
| 2 | User | ERC-20 `transfer(0xUser, 100000000)` — 100 USDT at 6 dp |
| 3 | Ethereum | Tx included; ~12 confirmations; the chain's `finalized` block passes it |
| 4 | Issuer scanner | `eth_getLogs` on the USDT contract, `Transfer` topic, `to ∈ {allocated addresses, custodyAddress}`, in 2,000-block ranges and 100-address batches |
| 5 | Issuer | Attribution: allocated address → L1 account; shared custody → `mapAccount(from)`. Idempotency key `(ethereum, txHash, logIndex)`; duplicate → skip |
| 6 | Issuer (finality) | Reads `eth_getBlockByNumber("finalized")`; if `observed > finalized`, **defer** (never treat `latest` as final) |
| 7 | Issuer | `externalRaw` 100000000, 6→6 → `l1AmountRaw` 100000000, dust 0; reserve += 100 USDT; operation `deposit` = `pending` |
| 8 | Issuer executor | Re-checks `supply ≤ reserve` and caps |
| 9 | Issuer executor | L1 mint: `reissue` USDT to the issuer wallet → drain `getTokenSignByTokenid` → `pay` the holder's L1 address |
| 10 | Issuer | Operation `completed`; supply += 100 USDT; holder balance += 100 |
| 11 | Wallet | `GET /deposits?account=<L1>` → `{ hash, amount: "100", status: "credited" }` |

Why the two-step mint: the chain addresses a token-creation output by **public
key**, while the issuer only knows the holder's **base58 address**, and the
chain's **domain key** is required in addition to the issuer key. Paying before
the signatures are drained leaves the mint unsolid and the token index never
moves.

## B3. Raw API examples

```bash
# Deposit address for this account
curl -s "https://issuer.example/deposit-address?account=<L1base58>&assetId=usdt" | jq
# { "address": "0xUser…" }        per-user mode
# { "address": "0xIssuer…" }      static mode

# Deposit status
curl -s "https://issuer.example/deposits?account=<L1base58>" | jq
# { "items": [ { "hash": "0xabc…", "amount": "100",
#                "status": "credited", "creditedAt": "2026-11-21T…" } ] }

# Full issuer service (if you run it)
curl -s "https://issuer.example/balances?account=<L1base58>" | jq
# { "items": [ { "assetId": "usdt", "available": "100000000", "pending": "0" } ] }

curl -s "https://issuer.example/statement?account=<L1base58>&limit=20" | jq
```

## B4. Status and failure handling

| Status | Meaning | Operator action |
|---|---|---|
| `pending` | Seen on Ethereum, not yet minted | Wait; check finality and signature drain |
| `credited` | Minted and paid on L1 | Done |
| `failed` | Executor error (cap/reserve/RPC) | Inspect operation error, fix, **explicit `requeue`** — never hand-mint |
| no row | Below 1 L1 unit, or not finalized, or wrong custody address | Check the scanner cursor, contract, `to`, and `finalized` |

Common causes of "deposit not credited":

1. Sent on the wrong network (BSC/TRON USDT) — unrecoverable without the other
   chain's key.
2. Sent to the static address but the issuer API expects a per-user address.
3. Confirmations present but not **finalized**.
4. The scanner cursor (`scan_cursors`) already passed the block without
   recording it (e.g. DB restored from an older snapshot). Reset the cursor row
   to re-scan the range; deposits are idempotent.
5. The token policy is paused.

---

# Part C — Withdraw

## C1. Pick the rail

| You hold | You want | Rail |
|---|---|---|
| USDT **on Ethereum** (your EC key) | USDT at an exchange/another 0x address | **Self-custody** `/withdraw` — works today |
| USDT **on L1-order** (credited token) | USDT on Ethereum | **Redemption** through the issuer — release leg not yet wired |

## C2. Self-custody withdraw (implemented)

Sidebar → **TRADE → Withdraw** (`/withdraw`); the Deposit page's **Withdraw**
tab also routes here.

1. **Select Asset** → `USDT` (`withdraw-asset-USDT`), showing the wallet's
   balance.
2. **Select Network** → `Ethereum (ERC-20)` (`withdraw-network-ethereum`). The
   fee is paid in **ETH**, not USDT.
3. **Recipient**: paste (`withdraw-paste`) or pick a saved address chip. The
   address must pass EIP-55; a mixed-case checksum failure is rejected
   (`withdraw-address-error`). Sending to your own address is rejected
   (`eth.errSelf`). Save a new one with a label (`withdraw-save-address`).
4. **Amount**: type it or tap **Max** (`withdraw-max`).
5. **Gas preset**: Slow / Standard / Fast (`withdraw-gas-slow|standard|fast`);
   priority ×0.8/1/1.5, `maxFee` keeps 2× base headroom.
6. Read the fee line (`withdraw-fee`), the receive amount
   (`withdraw-receive`) and, for ERC-20, "fee paid in ETH". The submit guard
   checks **ETH ≥ max fee** separately from the USDT balance.
7. **Withdraw** (`withdraw-submit`) → review sheet (asset, amount, recipient,
   network, fee) → confirm → **sign on device** (EIP-1559, chain id) →
   broadcast. The private key never leaves the device.
8. History (`withdraw-history`) is persisted and moves `pending → success |
   failed` with a system notification and an explorer link. Pending rows are
   re-checked on mount, so a tx that confirmed while the app was closed resolves
   itself.

Example: withdraw 25 USDT, max fee 0.00042 ETH → receive 25 USDT, ETH debit
0.00042; total USDT debit 25. For native ETH the total debit is
`amount + max fee`, so Max leaves fee headroom (21,000 gas × 1.2).

## C3. Bridge redemption (L1 USDT → Ethereum USDT)

A redemption needs **two** things: the L1 account authorizes the destination,
and the tokens actually come back on L1.

1. The wallet sends the amount with `payOnLayer1` to the asset's
   `redemptionAddress` (published in `/assets`), then builds and signs the
   intent with the L1 key (PQ or legacy EC):
   `{domain, network, assetId, account, amountRaw, destination, l1TxHash, nonce, expiry}`.
   See [`redeem-intent.md`](./redeem-intent.md) for the exact bytes and a
   `bigt-ai-ts` signing example. A hash can also be pasted into the card's
   `redeem-funding-tx` field if the tokens were sent elsewhere.
2. `POST /redeem-intents` with the proof (`keyType`, `publicKey`, `signature`).
3. The server verifies the signature and the fields, then verifies `l1TxHash`:
   a confirmed output of the **exact** token and amount to `redemptionAddress`.
   Not yet indexed/confirmed is `409 { retryable: true }`; the wallet retries the
   same intent.
4. Only then does it atomically store the intent (unique nonce + hash), create
   the `redeem` operation with `destination` and the L1 reference, and debit the
   holder balance when it covers the amount. The unique
   `(chain, tx_hash, log_index)` means one L1 return backs one release.
5. The executor re-verifies the L1 output at finality and calls
   `Treasury.release(assetId, account, destination, externalRaw)`; supply and
   reserve drop by the same amount and `health` stays clean. `payout_ref` is
   written before the ledger settles, so a requeue never pays twice.
6. `RefusingTreasury` fails loudly until the HSM/MPC command is configured:
   `TREASURY_RELEASE_COMMAND` **and** `ALLOW_LIVE_TREASURY=1`.

Fail-closed rules:

- `POST /redeem-requests` (unsigned) returns `400`; use `/redeem-intents`.
- No confirmed L1 return for the named transaction ⇒ no operation, no debit, no
  release (`503` when L1 verification is not configured at all).
- A `withdrawal` observed from a bare L1 transfer has **no destination** and
  fails (`release requires a verified destination`). It cannot choose where
  value leaves custody, and the blind scan is no longer part of the live pass.
- The holder balance is bookkeeping, not authorization: a buyer who acquired
  the token on-market can redeem even with no issuer balance, because the L1
  return is what is exchanged.
- The treasury command receives the verified destination; it must still enforce
  the approval policy and M-of-N.

To finish the leg you still need:

- [x] the wallet card that signs/submits the intent (`/deposit` → USDT →
      **Redeem to Ethereum**);
- [ ] an approval flow above a threshold in the custody signer;
- [ ] `requeue` only for genuinely retryable failures (RPC/gas), never for a
      policy pause.

## C4. Withdraw fee and limit reference

| Item | Rule |
|---|---|
| ERC-20 fee | Paid in ETH (`maxFeePerGas × gasLimit`), never deducted from USDT |
| Native ETH fee | `maxFee` reserved from the amount; Max subtracts it |
| Minimum | Issuer-side `minDeposit` only; the withdraw page has no fixed minimum |
| Safety | Submit is disabled while a send is in flight; the same send cannot be tapped twice |
| Address safety | EIP-55 enforced; sending to your own address is rejected; the review sheet shows the asset, amount, short recipient and fee |

---

# Part D — Reconciliation, monitoring, runbooks

| Signal | Source | Page? |
|---|---|---|
| `supply ≤ reserve` per asset | `GET /health`, `cli health` | **yes** |
| Pending operations age | `operations` table | yes |
| Failed mints / duplicate-guard hits | `operations` | yes |
| Deposit cursor lag | `scan_cursors.block` vs finalized head | warn |
| Hot-wallet ETH / USDT float | RPC | yes (low) |
| `/eth` 5xx rate | Caddy | warn |

Daily:

```bash
npx tsx src/cli.ts health    # exit 1 on breach
npx tsx src/cli.ts attest    # publish the reserve attestation
```

Incidents:

- **Deposit not credited** — network, address model, finality, cursor,
  idempotency key, policy pause (in that order). Replay idempotently.
- **Withdrawal stuck** — L1 burn pending vs confirmed vs finalized vs release
  queued (hot-wallet balance/gas) vs policy paused.
- **Reserve mismatch** — pause the asset immediately, stop mints, reconcile to
  the smallest unit; never "adjust" the ledger.
- **RPC/reorg** — mints stop (no finality). Verify `finalized` did not regress;
  switch the region's base, don't patch the app.
- **Key compromise** — pause, freeze the issuer key, rotate the M-of-N share,
  and for ETH pause the withdrawal queue before rotating the hot wallet.

---

## 5. End-to-end acceptance (USDT, staging)

1. Issue the token, publish the policy, mint 1,000 USDT float to the issuer.
2. Start the issuer with `ALLOW_LIVE_L1` unset; confirm it scans nothing and
   signs nothing.
3. Deposit **100 USDT** from a staging Ethereum wallet to the deposit address.
4. Confirm: one `deposit` operation, reserve +100, supply +100, holder +100,
   `health` clean, `/deposits` says `credited`.
5. Replay the same block range: zero new operations (idempotency).
6. Deposit while the issuer is stopped, then start it: exactly one mint.
7. Withdraw 25 USDT self-custody to an exchange deposit address; confirm
   `success`, fee paid in ETH only, notification + explorer link.
8. Redeem 10 USDT: send 10 L1 USDT to `redemptionAddress`, sign an intent with
   that transaction hash, `POST /redeem-intents` → `200`, operation `redeem`
   has the destination and the L1 reference. Without the treasury command it
   fails with the treasury message; with `TREASURY_RELEASE_COMMAND` +
   `ALLOW_LIVE_TREASURY=1` the command receives the verified destination.
   An unsigned `/redeem-requests`, an intent with no confirmed L1 return, and a
   second intent reusing the same L1 transaction all fail closed.
9. Sell the L1 USDT to a second wallet on the spot market, then try to redeem
   from the seller's old issuer balance: the request is refused because the
   seller no longer holds an L1 transfer to return (the buyer can redeem).
9. Fund the deposit address with gas, run `cli sweep` (plan): one job for the
   100 USDT balance. Run live: the USDT moves to the omnibus, the next plan is
   empty, and a sub-threshold balance is skipped (`below-min`).
10. Remove the address's ETH and plan again: the same balance is skipped
    (`no-gas`), nothing is signed.
11. After wiring the treasury adapter: redeem succeeds, supply and reserve each
    drop by 10, `health` clean.

---

## 6. Known gaps and gotchas

1. **Redemption release is not implemented.** `RefusingTreasury` is deliberate;
   do not simulate a release from a different wallet.
2. **Both calls now use the L1 account.** `deposit.tsx` sends
   `publicInfo.address` to `/deposit-address` and `/deposits`; an older client
   sent the EVM account to the first. Accept both if you still serve old builds.
3. **Per-user attribution is by destination address, not sender.**
   `EvmChainClient` maps an allocated address to its L1 account and only uses
   `mapAccount(from)` for the shared `custodyAddress`. With `static`, the sender
   is often an exchange hot wallet, which is exactly why `per-user` exists.
   Unknown senders/addresses are skipped, never credited to a stranger.
4. **The generic issuer registry has no `usdt` entry**
   (`expo-app/sources/lib/externalAssets.ts`), so `/assets`/`/balances` rows for
   `usdt` are dropped by the wallet's distributor screen. Add the registry entry
   if you want USDT on that screen; the `/deposit` page does not need it.
5. **Finality, not confirmations.** The page shows "12 confirmations", but the
   scanner mints only at `finalized`; never fall back to `latest`.
6. **Native ETH deposits need an address index.** The issuer's EVM client only
   decodes ERC-20 `Transfer` logs; native ETH is not discoverable over plain
   JSON-RPC. USDT (ERC-20) is unaffected.
7. **Decimals are 6 on both sides.** USDT has no conversion dust; assets with
   18 external decimals accumulate `dustRaw` and it must be reported, not
   rounded away.
8. **A network row is disabled when the app's chain differs.** Mainnet USDT on a
   Sepolia build shows the wrong-chain warning; the deposit assets list is not
   chain-filtered, the page is.
9. **No contract address in the wallet bundle** for the distributor rail; only
   the deposit page's registry carries the canonical USDT contract.
10. **`ASSETS_JSON` replaces the defaults**, so a partial list silently removes
    HKD/USD/GOLD/ETH. Ship the full set.
11. **Sweeping is a separate CLI, not part of the scanner.** `cli sweep` plans by
    default; live requires `ALLOW_LIVE_SWEEP=1` + a signing key. It does not
    fund gas, and the local `DEPOSIT_XPRV` path is for testnet/small float —
    production should use an HSM/MPC signer. Without a sweep, funds are safe but
    fragmented across addresses.
12. **The scan cursor is persisted.** Each pass catches up to the finalized head
    in `logChunk` windows and advances `scan_cursors` only after the window's
    deposits are committed. `FROM_BLOCK` only seeds a chain that has never been
    scanned. Reset the row to deliberately re-scan (deposits are idempotent).

---

**See also:** [`assets-deposit-withdraw.md`](./assets-deposit-withdraw.md) (§14–15),
[`ethereum.md`](./ethereum.md), [`external-assets-operations.md`](./external-assets-operations.md),
[`external-assets-order-trade.md`](./external-assets-order-trade.md),
`services/asset-issuer/README.md`, `../blockchain/helper/prod/asset-issue.sh`.
