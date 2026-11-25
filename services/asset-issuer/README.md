# asset-issuer

Issuer service for the four tradable `L1-order` assets — HKD, USD, XAU and the
custodial ETH token — implementing the API the wallet already speaks
(`expo-app/sources/services/distributor.ts`).

Design: [`../../docs/external-assets-order-trade.md`](../../docs/external-assets-order-trade.md).
Runbook: [`../../docs/external-assets-operations.md`](../../docs/external-assets-operations.md).

## Status

Scaffold, with the parts that must be provable already tested:

| Piece | State |
|---|---|
| Operation state machine (`completed` terminal, explicit requeue) | done + tested |
| Idempotency: chain ref `(chain, txHash, logIndex)` and client key | done + tested |
| Finality gate (`observed <= finalized`) | done + tested |
| External → L1 conversion with dust accounting | done + tested |
| `supply <= reserve` invariant, per asset, plus caps | done + tested |
| HTTP contract (`/assets`, `/balances`, `/statement`, `/transfers`, `/mint-requests`, `/redeem-intents`, `/transfers/:id`, `/health`) | done + tested with `fastify.inject`; `/redeem-requests` now rejects unsigned redeems |
| Deposit-page contract (`/deposit-address`, `/deposits`) | done + tested — static or per-user, display units, `pending/credited/failed` |
| Postgres schema (`schema.sql`) incl. a DB-level solvency CHECK and a "completed is terminal" trigger | applied to a real Postgres 16 and verified |
| Postgres `Store` (`src/store.pg.ts`) | **verified** against real Postgres: idempotency indexes, completed-terminal trigger, `supply <= reserve` CHECK, BigInt round-trip, attestations |
| Deposit watcher (`src/watcher.ts`) + `src/chain.evm.ts` | done — ERC-20 `eth_getLogs` into custody **or per-user addresses**, `finalized` gate, idempotency, reserve credit, dust |
| Per-user deposit addresses (`src/depositAddress.ts`, `src/depositService.ts`, `src/store.ts` `deposit_addresses`) | done — BIP32 xpub derivation, one stable address per L1 account, `/deposit-address` + `/deposits` for the wallet page |
| Sweeper (`src/sweep.ts`, `src/sweep.evm.ts`, `src/ethTx.ts`) | done — threshold/gas planning; live only with `ALLOW_LIVE_SWEEP=1` + `DEPOSIT_XPRV`; verifies the key controls the address before signing |
| API auth (`src/auth.ts`) + executor claim/revalidation (`src/executor.ts`) | done — default-deny outside Test, bearer or account-bound HMAC, `FOR UPDATE SKIP LOCKED` claim, receipt/finality re-check before minting |
| HSM/MPC adapter (`src/signers.ts`) | done — command protocol for `sweep-sign`, `l1-mint`, `treasury-release`; no key material in the service; local key paths remain Testnet/small-float |
| Mint executor (`src/executor.ts`) + `src/l1.ts` / `src/l1.bigt-ai.ts` | done — reissue → **drain pending signatures** → pay the holder; verified end to end on the Java L1-order infra, gated by `ALLOW_LIVE_L1` |
| Redemption verification (`BigtAiRedemptionVerifier`) | done — an intent's `l1TxHash` must have a confirmed output of the exact token/amount at `redemptionAddress`; the unique L1 reference backs one release. `BigtAiRedemptionSource` (blind scan) remains for diagnostics only |
| Deposit scan cursor (`scan_cursors`) | done — catches up to the finalized head window by window and advances only after a window commits |
| Release (`Treasury`) | **not implemented** — `RefusingTreasury` fails loudly until the HSM/MPC custody adapter exists |
| Reconciliation + attestations (`src/attestation.ts`, `/health`, `/metrics`) | done — publication target still to be chosen |
| Runner (`src/cli.ts`) | done — `once` / `loop` / `attest` / `health` / `serve` |
| Image | `deploy/Dockerfile.asset-issuer` (workspace build) — built and smoke-tested |

`src/main.ts` runs the in-memory store and **refuses to start outside
`NETWORK=Test` without `DATABASE_URL`**, because losing idempotency keys on
restart is exactly the double-mint this service exists to prevent.

## Authentication

Outside `Test`, `serve` refuses to start with `AUTH_MODE=off`:

| Mode | Env | What it proves |
|---|---|---|
| `off` | — | nothing; **Test only** |
| `bearer` | `API_TOKEN` | shared secret (`Authorization: Bearer …`); transport auth, not account-bound |
| `hmac` | `API_HMAC_SECRET` | account-bound: `x-account`, `x-timestamp` (ms), `x-signature` = HMAC-SHA256 over method, path, account, timestamp and canonical JSON body |

`/health` is the only public route. `hmac` needs a client that signs; the
current wallet sends only a bearer token. `AUTH_MAX_SKEW_MS` defaults to 300000.
A token baked into a web bundle (`EXPO_PUBLIC_ISSUER_API_TOKEN`) is **public**:
treat `bearer` as a coarse gate, not a secret, and prefer injecting it at the
edge or using `hmac` for account binding.
The helper `signRequest`/`hmacPayload` in `src/auth.ts` is the reference for a
client or a signing proxy.

The executor's claim is atomic (`claimPending`: `FOR UPDATE SKIP LOCKED`) and a
chain-observed `deposit` is **re-verified at execution time** against
`eth_getTransactionReceipt` + `finalized`; a DB row alone cannot authorize a
mint.

## The two invariants

1. **Never mint before the source chain is final.** Confirmations are not
   enough: an Ethereum reorg after minting leaves unbacked supply and the only
   remedy is a burn the holder never authorised.
2. **`supply <= reserve`, per asset, never aggregated.** Checked in the domain,
   in `/health`, and by a `CHECK` constraint in `schema.sql`. A breach pauses
   the asset; it is never "adjusted" in the ledger.

## Layout

```
src/domain.ts   pure: state machine, idempotency keys, conversion, invariant
src/depositAddress.ts  BIP32 xpub → EIP-55 address (no private key)
src/depositService.ts  idempotent per-user address allocation
src/sweep.ts           pure sweep planning (threshold + gas)
src/sweep.evm.ts       RPC reads, signer call, broadcast
src/signers.ts         HSM/MPC command adapters (sweep/l1-mint/treasury)
src/ethTx.ts           RLP + EIP-1559 + ERC-20 transfer calldata
src/store.ts    Store interface + MemoryStore (test double / schema reference)
src/config.ts   asset table (must match expo-app/sources/lib/externalAssets.ts)
src/server.ts   fastify routes + `advance()` for the executor
src/main.ts     entry point
schema.sql      Postgres schema
test/           140 tests
```

## Database

The service owns its **own** Postgres. Never point it at a chain node's
database (`ordermatch`, `info`): those are node-local and owned by the chain,
while this database holds the reserve ledger, holder balances and the
idempotency keys that prevent a double mint.

**Dev / staging (docker):**

```bash
# 1. a throwaway database
docker run -d --name asset-issuer-db \
  -e POSTGRES_DB=asset_issuer -e POSTGRES_USER=asset_issuer \
  -e POSTGRES_PASSWORD=test1234 -p 55432:5432 postgres:16-alpine

# 2. the schema (idempotent — safe to re-run)
docker exec -i asset-issuer-db \
  psql -v ON_ERROR_STOP=1 -U asset_issuer -d asset_issuer \
  < services/asset-issuer/schema.sql

# 3. verify the store against it
DATABASE_URL=postgres://asset_issuer:test1234@127.0.0.1:55432/asset_issuer \
  npx tsx services/asset-issuer/test/pg-smoke.ts
# -> RESULT=OK
```

**Deployed (compose):** `deploy/compose.asset-issuer.yml` provisions
`postgres:16-alpine` with its own `asset_issuer` database, role, volume and
password (`ASSET_ISSUER_DB_PASSWORD`), and mounts `schema.sql` into
`/docker-entrypoint-initdb.d` so a fresh volume is initialised correctly. The
service reads `POSTGRES_URL` (or `DATABASE_URL`) and refuses to start outside
`NETWORK=Test` without it.

## Run

```bash
cd services/asset-issuer
npx vitest run                                  # 140 tests, no database needed

# HTTP (wallet-facing contract)
NETWORK=Test PORT=8090 npx tsx src/main.ts

# One scanner pass (cron) / every 60 s / attestations only / solvency check
NETWORK=Test npx tsx src/cli.ts once
NETWORK=Test npx tsx src/cli.ts loop
NETWORK=Test npx tsx src/cli.ts attest
NETWORK=Test npx tsx src/cli.ts health          # exit 1 on a reserve breach
```

### Per-user deposit addresses (USDT / ERC-20)

Two address models, chosen per asset in `ASSETS_JSON`:

| `depositAddressMode` | Receive address | Attribution |
|---|---|---|
| `static` (default) | `depositAddress`/`custodyAddress` for everyone | the sender (`from`), via `mapAccount` |
| `per-user` | one BIP32 address per L1 account | **the address itself** |

`per-user` is the Binance shape and is required for exchange-origin deposits: an
ERC-20 transfer carries no memo, so a shared address cannot tell two users apart
when the sender is an exchange hot wallet. Allocation is idempotent and stored in
`deposit_addresses` (unique account, **globally** unique address and index); the
watcher scans every allocated address plus the shared custody address.

```text
DEPOSIT_XPUB=xpub…           account-level xpub (m/44'/60'/0' or m/44'/60'/0'/0)
DEPOSIT_XPUB_PATH=0          non-hardened path below it; '' when the xpub is …/0
DEPOSIT_ASSET_ID=usdt        default asset for /deposit-address
```

The xpub is public material and stays in the environment, not in `ASSETS_JSON`.
`/deposit-address` fails **closed** (503) when `per-user` is requested without
one — silently falling back to a shared address would misattribute funds.

### Signed redemption intents

`POST /redeem-intents` requires an L1-key signature over
`{domain, network, assetId, account, amountRaw, destination, l1TxHash, nonce, expiry}`.
The signature proves **who chose the destination**; it does not prove the tokens
came back. The request is refused unless `l1TxHash` has a confirmed L1 output of
the exact token and amount to the asset's `redemptionAddress`
(`409 { retryable: true }` while it is not confirmed yet). The intent (unique
nonce + hash), the operation (unique L1 reference) and the balance debit commit
in one transaction, and `operations.destination` carries the verified Ethereum
address. `executeRelease` re-checks the L1 return and refuses without it — an
observed L1 transfer alone cannot choose a destination. Format and client
examples: [`../../docs/redeem-intent.md`](../../docs/redeem-intent.md).

`/mint-requests` is operator-only (`MINT_API_TOKEN` + `x-mint-token`): the
wallet-facing bearer ships in the web bundle and must not be able to mint
against the pooled reserve. Without the token the route answers `403`.

### HSM/MPC signers

`L1_SIGNER=command` with `L1_MINT_COMMAND`, `SWEEP_SIGN_COMMAND`, and (gated by
`ALLOW_LIVE_TREASURY=1`) `TREASURY_RELEASE_COMMAND` moves every value-bearing
signature into an external process over stdin/stdout. The service holds no L1
key, xprv, or custody key in that mode; the protocol and validation are in
[`../../docs/issuer-hsm-adapter.md`](../../docs/issuer-hsm-adapter.md). The local
`L1_ISSUER_KEY` / `DEPOSIT_XPRV` paths stay for Testnet/small float.

### Sweeping

`npx tsx src/cli.ts sweep` plans (never signs) by default. It reads every
allocated address's token and native balance, estimates gas, and skips
`omnibus`, `zero`, `below-min` and `no-gas` addresses with a reason. Live mode
requires all three:

```text
ALLOW_LIVE_SWEEP=1
DEPOSIT_XPRV=xprv…              # signing material: HSM/MPC in production
SWEEP_MIN_RAW=20000000          # 20 USDT at 6 dp
```

Optional: `DEPOSIT_XPRV_PATH` (same convention as the xpub), `SWEEP_GAS_LIMIT`
(fallback 65000), `SWEEP_NATIVE_RESERVE_WEI` (ETH left behind),
`SWEEP_ASSET_ID`. Before signing, the runner derives the key and refuses the job
if it does not control the allocated address. The sweep is balance-based, so a
crash after broadcast is safe: the next run plans only the remainder.

A per-deposit sweep is usually uneconomical (≈65k gas); set the threshold to
several times the gas cost, or batch through a forwarder. Gas must already be at
the deposit address — the runner skips an address without it rather than
funding it from the omnibus.

The pass is inert without adapters: set `ETH_RPC_URL` to scan deposits,
`L1_URL` + `L1_ISSUER_KEY` to mint/scan redemptions, and `ALLOW_LIVE_L1=1` to
actually sign. Without them it still records nothing and reports what it would
have done, which is the safe default.

Image: `docker build -f deploy/Dockerfile.asset-issuer -t wallet-asset-issuer .`
(built from the repo root — the service imports the `bigt-ai-ts` workspace
package).

### Installing dependencies (read this)

This package is part of the root yarn workspace. Running `npm install` here
without the workspace off makes npm resolve the **root** project and rewrite
`/package-lock.json` and `/yarn.lock` — registry URLs change and versions move.
Always scope it:

```bash
cd services/asset-issuer
npm install --workspaces=false           # or --package-lock-only for the lockfile
```

`scripts/git-hooks/pre-commit` refuses to commit a root lockfile change
(`./scripts/install-git-hooks.sh` enables it), and CI fails on the same drift.

## Next

1. ~~`PgStore` against `schema.sql`~~ **verified on Postgres 16**.
2. ~~Deposit watcher~~ **done** (ERC-20 + finality + idempotency).
3. ~~Mint executor~~ **done and proven on the Java test infra** (`issues` +
   `reissues` 2/2). Minting needs the chain's **domain key** as well as the
   issuer key, or must run through `helper/prod/asset-issue.sh`.
4. **Treasury (next)**: HSM/MPC release adapter + approval flow. Until then
   `redeem` requests fail with a clear error rather than half-releasing.
5. Attestation publication target (on-chain policy keyvalue vs issuer API).
