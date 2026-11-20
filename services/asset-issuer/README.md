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
| HTTP contract (`/assets`, `/balances`, `/statement`, `/transfers`, `/mint-requests`, `/redeem-requests`, `/transfers/:id`, `/health`) | done + tested with `fastify.inject` |
| Postgres schema (`schema.sql`) incl. a DB-level solvency CHECK and a "completed is terminal" trigger | applied to a real Postgres 16 and verified |
| Postgres `Store` (`src/store.pg.ts`) | **verified** against real Postgres: idempotency indexes, completed-terminal trigger, `supply <= reserve` CHECK, BigInt round-trip, attestations |
| Deposit watcher (`src/watcher.ts`) + `src/chain.evm.ts` | done — ERC-20 `eth_getLogs` into custody, `finalized` gate, idempotency, reserve credit, dust |
| Mint executor (`src/executor.ts`) + `src/l1.ts` / `src/l1.bigtangle.ts` | done — reissue → **drain pending signatures** → pay the holder; verified end to end on the Java L1-order infra, gated by `ALLOW_LIVE_L1` |
| Redeem watcher (`BigtangleRedemptionSource`) | done — only confirmed transfers to the asset's `redemptionAddress`, never the issuer's float |
| Release (`Treasury`) | **not implemented** — `RefusingTreasury` fails loudly until the HSM/MPC custody adapter exists |
| Reconciliation + attestations (`src/attestation.ts`, `/health`, `/metrics`) | done — publication target still to be chosen |
| Runner (`src/cli.ts`) | done — `once` / `loop` / `attest` / `health` / `serve` |
| Image | `deploy/Dockerfile.asset-issuer` (workspace build) — built and smoke-tested |

`src/main.ts` runs the in-memory store and **refuses to start outside
`NETWORK=Test` without `DATABASE_URL`**, because losing idempotency keys on
restart is exactly the double-mint this service exists to prevent.

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
src/store.ts    Store interface + MemoryStore (test double / schema reference)
src/config.ts   asset table (must match expo-app/sources/lib/externalAssets.ts)
src/server.ts   fastify routes + `advance()` for the executor
src/main.ts     entry point
schema.sql      Postgres schema
test/           29 tests
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
npx vitest run                                  # 69 tests, no database needed

# HTTP (wallet-facing contract)
NETWORK=Test PORT=8090 npx tsx src/main.ts

# One scanner pass (cron) / every 60 s / attestations only / solvency check
NETWORK=Test npx tsx src/cli.ts once
NETWORK=Test npx tsx src/cli.ts loop
NETWORK=Test npx tsx src/cli.ts attest
NETWORK=Test npx tsx src/cli.ts health          # exit 1 on a reserve breach
```

The pass is inert without adapters: set `ETH_RPC_URL` to scan deposits,
`L1_URL` + `L1_ISSUER_KEY` to mint/scan redemptions, and `ALLOW_LIVE_L1=1` to
actually sign. Without them it still records nothing and reports what it would
have done, which is the safe default.

Image: `docker build -f deploy/Dockerfile.asset-issuer -t wallet-asset-issuer .`
(built from the repo root — the service imports the `bigtangle-ts` workspace
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
