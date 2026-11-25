# Backlog — wallet and issuer work for HKD, USD, GOLD and ETH

**Status: audit, 2026-11-19.** Derived from the code in `../wallet`, not from the
plan. Design: [`external-assets-order-trade.md`](./external-assets-order-trade.md).
Runbook: [`external-assets-operations.md`](./external-assets-operations.md).

## 1. Already built

| File | State |
|---|---|
| `expo-app/sources/lib/externalAssets.ts` | registry — **HKD, USD, GOLD, ETH tradable** (+ HKDAP rail-only), `orderTrading` metadata, `findExternalAssetByTokenId` |
| `expo-app/sources/lib/markets.ts` | **new** — 8 launch pairs, quote resolution, `long` ceilings and bounds guard |
| `expo-app/sources/services/distributor.ts` | balances, statement, transfer, mint/redeem, poll, **`GET /assets` catalog merge** |
| `expo-app/sources/app/trade.tsx` | quote symbols come from `lib/markets` (no local const) |
| `screens/trade/TokenOrderScreen.tsx` | takes the pair's quote instead of hardcoded `bc` |
| `expo-app/sources/app/external-asset.tsx` | connect → balances → transfer → mint/redeem → statement |
| `_layout.tsx`, `components/Sidebar.tsx` | `/external-asset` route under NETWORK |
| `sources/lib/i18n.ts` | `extAsset` section in all 12 locales |
| `services/asset-issuer/` | **new** — domain invariants, HTTP contract, watcher, executor, attestations, metrics, `MemoryStore` + `PgStore`, 54 tests, `schema.sql` |
| `../blockchain/helper/prod/{asset-issue.sh,assets/AssetIssueTool.java}` | create / sign / mint / policy / show / preflight |
| `docs/external-assets*.md` | design, ops, backlog |

Verified: `npx tsc --noEmit` clean (app, service, spec); **398 wallet tests, 0 failures** (2 skipped) + **69 issuer tests**; Playwright 4/4 against the exported web build; the issuer image builds and serves `/assets` + `/health`; `cli.js health` returns `ok: true`.

## 2. Missing in the wallet (verified absent)

| # | Item | Why | Size | State |
|---|---|---|---|---|
| W1 | `orderTrading` + four tradable entries | the registry could not express a tradable asset | S | **done** |
| W2 | `lib/markets.ts` — pairs, tick, ceilings | pairs were scattered; `TokenOrderScreen` hardcoded `bc` | M | **done** |
| W3 | `trade.tsx` quotes from the registry | one source of truth | S | **done** |
| W4 | `TokenOrderScreen` takes the pair's quote | non-`bc` markets were priced wrong | S | **done** |
| W5 | Funding rails on `/external-asset` | **done (lean)** — no EVM refactor: the issuer `/assets` carries `depositKind` / `depositInstructions` / `depositAddress` / `referencePrefix`; the screen shows the instructions, a deterministic bank-safe reference (copy), and deep-links the ETH leg to `/withdraw?symbol=ETH&to=` | M | **done** |
| W6 | External operation notifications | **done** — `lib/externalNotifications.ts` (pure reducer, one notice per terminal transition), `services/externalOps.ts` (KV-tracked, polled every 25 s and on foreground), mounted in `_layout`; the screen records submitted ops | M | **done** |
| W7 | External balances on the home screen | **done** — `lib/externalPortfolio.ts` (pure merge) + `components/ExternalAssetsCard`; renders nothing unless a distributor is configured and a balance is non-zero | S–M | **done** |
| W8 | `GET /assets` catalog merge | otherwise every listing needs an app release | S | **done** |
| W9 | Playwright spec | **done and run** — `e2e/playwright/tests/external-asset.spec.ts`: 4/4 green against the exported web build. The mock gained CORS headers, per-test state reset and a CJS-safe CLI guard | S–M | **done** |
| W10 | i18n ×12 | 7 new `extAsset` keys in all 12 locales | S | **done** |

Wallet: **W5, W6, W7, W9, W10 done** (W9 executed: 4/4). No EVM screen was modified.

## 3. Issuer service (`services/asset-issuer`, scaffolded)

| # | Item | Notes | State |
|---|---|---|---|
| I1 | Schema + `PgStore` | `(chain, txHash, logIndex)` + client key; DB `CHECK (supply <= reserve)`; `completed`-terminal trigger | **verified** on Postgres 16 (idempotency, trigger, CHECK, BigInt, attestations) |
| I2 | Deposit watcher + EVM source | `src/chain.evm.ts` (ERC-20 logs, `finalized`, account mapping seam); native ETH still needs the address index | **done (ERC-20)** |
| I3 | Mint executor + L1 binding | `src/l1.ts` + `src/l1.bigt-ai.ts` (reissue → multi-sign → pay holder), gated by `ALLOW_LIVE_L1`; wrapper tested, **chain binding unverified** | **done (needs Test run)** |
| I4 | Redeem watcher + release | watcher done (`redemptionAddress`, confirmed only); release **not implemented** — `RefusingTreasury` | **partial (blocked on custody)** |
| I5 | State machine + retries + duplicate guards | domain logic, tested | **done** |
| I6 | Endpoints matching `services/distributor.ts` | 8 routes incl. `/assets` and `/health` | **done** |
| I7 | Reconciliation + attestation | `/health`, versioned attestations + `statementHash` tested; chain publication adapter open | **done (core)** |
| I8 | Dust ledger for 18→6 | conversion reports dust; reserve persists it; tested | **done** |
| I9 | Tests | 54 tests: domain, HTTP, watcher, executor, attestation, metrics | **done (in-process)** |
| I10 | Ops: metrics, compose, image, runner | `/health` + `/metrics`; compose with the runner env; image **built and smoke-tested**; `src/cli.ts` (`once`/`loop`/`attest`/`health`); lockfile committed | **done** |

Issuer remaining: **treasury/custody release** (HSM/MPC adapter + approval flow), native-ETH deposits (address index), attestation publication target, and one end-to-end run on Test. `PgStore`, the ERC-20 source, the mint binding, the runner and the image are in place.

## 3.2 End-to-end coverage

| Test | Scope | Result |
|---|---|---|
| `e2e/playwright/tests/external-asset.spec.ts` | wallet UI vs the contract mock | **4/4** |
| `e2e/issuer-wire.sh` + `external-asset-wire.spec.ts` | wallet UI vs the **real issuer** (Fastify + Postgres, seeded balance) | **2/2** |
| `packages/bigt-ai-ts/test/testintegration/externalAssetsChain.test.ts` | the four tokens on the **real L1-order chain** (`e2e/infra.sh up`) | **2/2**, including reissuance (mint) |

What the real-chain run found (and fixed):

- **`createToken` could not reissue.** `getTokenIndex` returns `blockhash` as a
  Jackson object (`{bytes, reversedBytes}`), which `createToken` stored as a
  plain object; the server then saw a null previous hash with `tokenindex > 0`
  and rejected the block with `MissingDependencyException`. `Wallet.createToken`
  now normalises the hash (`parseJsonHash`).
- **A token created with `increment = false` is stopped** (`tokenstop = true`),
  so it can never be minted again. Issuance must pass `increment = true`.
- **`getTokenById` returns the first issuance record**, so its `amount` never
  grows; supply comes from the emissions, not that row.

**Mint is now proven end to end.** The remaining piece was not the client hash
but the *signature protocol*: a token block is only solid once the node has all
the signatures it asks for (`getTokenSignByTokenid`), and the chain's **domain
key** is required on top of the issuer signature. `getTokenIndex` stays 0 until
then, which is why the earlier assertions looked wrong. The test (and the
issuer's `BigtAiL1Minter`) now drain pending signatures before paying, and
the token index advances 0 → 1 with a new block hash.

**Operational consequence:** minting needs the domain key as well as the issuer
key. Either the issuer service holds both, or minting runs through
`helper/prod/asset-issue.sh` (`create`/`mint` + `sign` until no pending) under
the operator's custody.

## 4. One thing still to prove on a real chain

1. ~~**TS reissuance parity**~~ **proven** on the Java test infra (issuance +
   reissuance, 2/2); the signature-drain requirement is documented above.
2. **Redeem detection.** Redemptions are read from a dedicated
   `redemptionAddress` (never the issuer's float), and only confirmed outputs.
   Confirm the token's `StablecoinPolicy` allowlist does not block the issuer
   from receiving, and that the issuer's redistribution float never lands on
   that address.

## 5. Suggested order

1. W1 + W2 + W3 + W4 — makes the four assets expressible and tradable.
2. I1 + I2 + I3 + I6 on Test — one asset (HKD) end-to-end.
3. ~~W5~~ **done**; W6 (notifications) remains.
4. W7 + W8 + W10, then W9.
5. Repeat I4 + I5 for redeem, then the remaining assets.

The deposit card needs `I6` (`/assets` with the funding rail) — that contract now exists.
