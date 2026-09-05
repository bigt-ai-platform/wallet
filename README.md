# Wallet — Bigtangle blockchain wallet (iOS · Android · Web)

A cross-platform wallet app for the Bigtangle blockchain, built with React
Native and Expo. It manages post-quantum (PQ) key wallets, sends UTXO
transactions across Layer 0 / L1 order-match chains, places buy/sell orders,
browses and creates tokens, and renders price/volume charts — all in 6
languages, from a single TypeScript monorepo.

The blockchain protocol logic lives in the **Java** codebase
(`../blockchain`); this repo ships a TypeScript port of that logic
(`packages/bigtangle-ts`) plus the mobile/web client built on it.

## Features

### Wallet & keys
- Create, import (hex / WIF), load, and manage encrypted PQ-key wallets
- Import legacy `.wallet` protobuf files and unencrypted app-format wallets
- Scrypt (N=16384, r=8, p=1) + AES encryption at rest; decrypted keys held in
  memory only; auto-lock on app background / lock
- No fabricated server credentials — new wallets are self-contained key files

### Payments & transactions
- Send any token to an address on the settlement chain of your choice (L0 or a
  configured L1 order-match chain)
- UTXO selection, SIGHASH_ALL signing, fee estimation, change output, memo
- On-chain payment tracking with live status, and a filterable transaction
  history (layer, recipient, date range)

### Trading & markets
- Buy / sell orders matched on an L1 order-match chain
- Market data: live prices, gainers/losers, token count
- Price & volume chart (`chart.tsx`) with interval selection
- Order history and in-app tracked orders

### Tokens
- Browse tokens by name or ID; create / issue new tokens on-chain

### Balance explorer
- Layer-filtered balance, aggregated by token, with a full UTXO list
  (confirmed/pending, spendable/spent/locked, block, height, memo …)

### Settings & network
- Mainnet / testnet switching with configurable server URLs
- Manage multiple L1 order-match chains (add/remove, unique chain id)
- Language picker (persisted) and developer bridge (L1 pay / pay-back) harness

### Internationalization
- i18next + react-i18next with 6 languages: en, zh, de, fr, es, ja
- Translations are inline in `expo-app/sources/lib/i18n.ts`; the chosen
  language is persisted via MMKV (native) / localStorage (web)

## Repository layout

```
wallet/
├── expo-app/                 # React Native / Expo client (the app)
│   ├── sources/
│   │   ├── app/              # Expo Router routes (see below)
│   │   ├── components/       # Reusable UI (Sidebar, ChainBadge, …)
│   │   ├── screens/          # Larger screens / helpers
│   │   │   ├── wallet/       # WalletHelper.ts, Keys.tsx
│   │   │   └── trade/        # TokenOrderScreen.tsx (buy/sell)
│   │   ├── services/         # http.ts, transaction.ts, tracking.ts
│   │   ├── state/wallet/     # WalletProvider: unlock/lock/clear state
│   │   ├── storage/          # MMKV / localStorage abstraction
│   │   ├── lib/i18n.ts       # i18next setup + all translations
│   │   ├── text/             # typed `t()` helper / legacy dict
│   │   ├── unistyles/        # theme tokens & styling setup
│   │   ├── constants/        # networks, L1 chains, fonts, version
│   │   ├── utils/            # bigtangle, alert, status helpers
│   │   └── types/            # shared API types
│   ├── app.config.js         # Expo config (3 APP_ENV variants)
│   ├── eas.json              # EAS build profiles
│   ├── metro.config.js       # web stubs for jackson-js / node builtins
│   └── package.json
├── packages/bigtangle-ts/    # TypeScript blockchain client (Java port)
│   ├── src/                  # protocol, crypto (PQ/EC), wallet, scripts
│   └── test/                 # core + remote integration tests
├── e2e/                      # Playwright web e2e suite + infra helpers
├── deploy/                   # web-only regional deploy kit (nginx + Caddy)
├── docker/                   # dockerized blockchain + app build/test scripts
├── dev.sh                    # one-shot: Java infra (L0/L1) + Expo web dev server
├── e2eremote.sh              # run TS remote integration tests vs Java infra
├── scripts/                  # helper scripts (test wallet generation, …)
├── AGENTS.md                 # agent/dev conventions (read me first)
└── package.json              # yarn workspaces root (expo-app, packages/*)
```

### Routes (`expo-app/sources/app/`)

```
/                       → Redirect to /home/payment
/home/payment           Send payment, live payment tracking, transaction history
/home/keys              Manage keys (create / import / load wallet)
/(tabs)/order           Market prices, buy/sell order placement, order history
/(tabs)/buy | /sell     Buy / sell order screens (hidden tab-bar entries)
/(tabs)/tokens          Token browser + token creation
/(tabs)/settings        Network, L1 chains, language, developer bridge harness
/balance                Layer-filtered balance & UTXO explorer
/chart                  Token price & volume chart
```

Navigation is **sidebar-first**: a persistent sidebar on desktop (≥768px) and a
hamburger drawer + bottom tab bar on mobile.

## Technology stack

- **Framework**: React Native 0.81.4, Expo SDK 54 (new architecture), Expo Router 6
- **Language**: TypeScript ~5.9 (strict)
- **Blockchain client**: `bigtangle-ts` (workspace package, v1.0.7)
- **Styling**: react-native-unistyles 3 (light/dark theme tokens)
- **State**: Zustand 5 + React Context (`WalletProvider`)
- **Crypto deps**: @noble/ciphers, @noble/hashes, @noble/post-quantum,
  secp256k1, scrypt-js, bs58
- **i18n**: i18next + react-i18next
- **Storage**: MMKV (native) / localStorage (web) behind `@/storage`
- **Tests**: Vitest (client + SDK), Playwright (web e2e), Detox (native e2e)
- **Package manager**: Yarn 1.22.22 (workspaces, enforced via `packageManager`)

## Prerequisites

- Node.js 20+, Yarn 1.22.22
- The Java blockchain repo checked out at `../blockchain`
  (`git clone` + built modules) — used for local dev infra and as the protocol
  reference
- iOS: macOS + Xcode; Android: Android Studio + SDK; Expo CLI comes via deps

## Getting started

### 1. Install dependencies (repo root)

```bash
yarn install
```

This installs the workspaces (`expo-app` + `packages/bigtangle-ts`).

### 2. Build the TS blockchain client

`expo-app` depends on the workspace `bigtangle-ts`, whose runtime entry is its
compiled `dist/`. Keep it in sync after any change:

```bash
cd packages/bigtangle-ts
yarn build
```

### 3a. Full local stack: `dev.sh` (recommended)

Starts the Java L0/L1/MCMC infra (via `e2e/infra.sh` → `../blockchain`
`remote.sh infra`) and then the Expo dev server:

```bash
./dev.sh              # infra on L0 :24089 / L1 :24086, web on http://localhost:8081
DEV_CMD="yarn ios" ./dev.sh     # boot the iOS simulator instead of web
./dev.sh down         # stop infra
```

> Requires Docker (postgres) and Maven. `dev.sh` also bootstraps dev-trade
> tokens and a partial order book for a populated test environment.

### 3b. Just the app (no chain)

Point the app at an existing chain via Settings:

```bash
cd expo-app
yarn start            # Expo dev server: i = iOS, a = Android, w = web
```

## Build variants

The app reads `APP_ENV` (`development` | `preview` | `production`) to pick the
network defaults and bundle id (currently placeholders `com.example.bapp.*` —
replace in `expo-app/app.config.js` before release):

```bash
cd expo-app
yarn start:dev        # development
yarn ios:production   # native production build
yarn web:build        # static web export → ../e2e/web-build
```

EAS Build profiles live in `expo-app/eas.json`; GitHub Actions workflows in
`.github/workflows/` (CI lint/typecheck/unit, iOS EAS build, preview + publish).
See `app-store-publish-plan.md` / `google-play-publish-plan.md` for release
checklists.

## Testing

Test expectations mirror the **Java** remote test suite. When a test fails,
follow AGENTS.md's **Java-first** rule: reproduce, compare with
`../blockchain` behavior, then touch the TS code only if it diverges.

### TypeScript / unit tests (no chain)

```bash
cd packages/bigtangle-ts
yarn test             # vitest: core, crypto, script, wallet, PQ/EC compat, …

cd expo-app
yarn typecheck
```

### Remote integration tests (chain required)

`e2eremote.sh` brings up the Java infra and runs the TS remote suites under
`packages/bigtangle-ts/test/testintegration/` (ports 18088 / 18086):

```bash
QUICK=1 ./e2eremote.sh        # fast smoke subset
./e2eremote.sh                # full suite
```

These suites are ports of the Java remote test classes in
`../blockchain/.../remote/` — see the mapping table in `AGENTS.md`.

### Playwright web e2e

Drive a real browser against the web app (Dev infra from `dev.sh`, then):

```bash
cd e2e
npx playwright test --config playwright.config.ts   # mobile + desktop projects
```

### Detox native e2e

```bash
cd expo-app
yarn e2e:build:ios && yarn e2e:test:ios      # macOS / iOS simulator
```

## Deployment (web)

`deploy/` ships the static Expo web export as a single nginx container behind
a host Caddy vhost — fully containerised, mirroring `../aifeeds/deploy`; the
chain itself is **not** part of this stack (the app talks to the prod chain
from the browser). See `deploy/README.md`.

```bash
./deploy/tag.sh                       # expo export → docker image → tar/registry
./deploy/region.sh deploy prod        # provision a region VM (idempotent)
```

## Architecture notes

### bigtangle-ts (`packages/bigtangle-ts`)

A TypeScript client mirroring the Java `bigtangle-core`: post-quantum key
bundles (ML-DSA + SLH-DSA via `PQKey`, default ML-DSA-87) alongside EC,
`Wallet`, UTXO `Transaction`/`Script` building, params for main/testnet, and
HTTP/WebSocket transport. See `packages/bigtangle-ts/README.md` for the
carefully-maintained **differences from Java** (prefixed vs unprefixed public
key bytes, Jackson parser limitations, tx version upgrade to
`PQConstants.TX_PQ_VERSION`, etc.) and cross-platform PQ/EC test fixtures.

### Web bundle stubs

`metro.config.js` routes `jackson-js` and the Node builtins `https/http/net/tls`
to stubs so the SDK's Jackson-decorated classes and axios transport load in the
browser (`expo-app/jackson-stub.js`, `expo-app/node-web-stub.js`).

### Wallet security model

- Encrypted wallet JSON persisted under MMKV / localStorage
- Password-derived scrypt key decrypts only into an in-memory `WalletFile`
- `WalletProvider` (`sources/state/wallet`) zeros the in-memory private key and
  locks on `background`/`inactive`; public info (address) stays available
- `.wallet` protobuf import uses `WalletProtobufSerializer`; keys may be PQ
  (new) or EC (legacy, migrated)

### HTTP service layer

`expo-app/sources/services/http.ts` is the singleton API client for balances,
UTXOs, tokens, market prices, order placement and bridge info, with
mainnet/testnet switching and app-wide L1 chain selection
(`subscribeL1Change`). Transaction building / order creation lives in
`transaction.ts`; on-chain status polling in `tracking.ts`.

## Contributing

- Read `AGENTS.md` first — it defines the Java-first verification workflow and
  the remote-test ↔ Java mapping.
- Format/typecheck before opening a PR (`yarn typecheck` in `expo-app`,
  `yarn build && yarn test` in `packages/bigtangle-ts`).
- No fabricated credentials or server-side secrets: wallets must remain
  self-contained key files.

## License

MIT (see `packages/bigtangle-ts/LICENSE`).
