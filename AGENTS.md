# AGENTS.md

## Demo assets: never spend production funds

The P2P demo screenshots/PDFs are produced by the **funds-free** harness:
`./p2pdemo.sh capture walkthrough` → `e2e/capture-p2p-cny.mjs`, which runs a
local `p2p-engine` with a memory store and no chain client (synthetic lock and
release hashes). Nothing leaves a wallet. The demo is **BIG → CNY over WeChat**
only. Pass `LANGS=en,zh,de,…` to shoot the wallet UI in several languages: each
shot lands as `p2p-cny-wechat-NN-*-<lang>.png` and `scripts/docs-pdf.mts`
prefers `<file>-<lang>.png`, falling back to English — so a wallet set to
Chinese opens a Chinese PDF with a Chinese UI in the screenshots.

The screenshots **and the rendered PDFs** are gitignored build artifacts
(`docs/*-demo/assets/screenshots/`, `docs/*-demo/assets/*.pdf`). Nothing under
those paths is committed any more: a fresh checkout runs
`./p2pdemo.sh capture walkthrough`, then `scripts/publishpdf.sh`.
`gen-p2p-all-pdf.mjs` exits non-zero when an embedded shot is missing, so the
capture always runs first.

`scripts/publishpdf.sh` (`yarn publishpdf`) publishes every rendered guide PDF
to the public `apps` bucket under `wallet/docs/demo` on **s3.bigt.ai** — the
exact keys `expo-app/sources/lib/docs.ts` links to. It writes to the EU primary
and verifies each read site (us 302s to the primary, asia serves a GEO replica);
`--dry-run` prints the keys without touching the network. `scripts/docs-upload.sh`
is a deprecated alias.

`e2e/capture-p2p-prod.mjs` is an **operator-only** tool for a real
production-escrow capture. It refuses to run unless `ALLOW_REAL_FUNDS=1` is set,
because it funds a production wallet from a validator keystore and locks a real
BIG escrow on L0. Do not use it (or any other real-funds path) to produce demo
screenshots. If a demo vault ever needs to be unwound, use
`e2e/p2p-recover-escrow.mjs` (2-of-3: seller + buyer key).

## Remote integration tests are ported from the Java blockchain test suite

The remote (network/integration) TypeScript tests under
`packages/bigtangle-ts/test/testintegration/` are **ports** of the corresponding
Java remote test classes in `../blockchain/layer0-mcmc/src/test/java/net/bigtangle/mcmc/remote/`.

| TS test file | Java source (origin) |
|---|---|
| `RemoteTest.ts` | `RemoteTest.java` |
| `RemoteFromAddressTests.test.ts` | `RemoteFromAddressTests.java` |
| `RemoteTokenIT.test.ts` | `RemoteTokenTests.java` |
| `remoteorder.test.ts` | `RemoteOrderTests.java` |
| `token_and_bridge.test.ts` | `RemoteOrderAcrossRewardTests.java` / `RemoteOrderTests.java` |
| `RemoteBinaryTests.test.ts` | `RemoteBinaryTests.java` |
| `RemoteEpochRewardTests.test.ts` | `RemoteEpochRewardTests.java` |
| `RemoteFromAddressTests.test.ts` | `RemoteFromAddressTests.java` |
| `walletutil_integration.test.ts` | (wallet utils, no direct Java file) |
| `RemoteTransactionIT.test.ts` | (transaction/payment, no direct Java file) |

## Verification rule: Java first

The blockchain protocol logic lives in the Java codebase (`../blockchain`).
The TypeScript code is a **client port** of that logic. When a remote test fails,
**do not assume the TS test or the infra is the problem first.**

1. Reproduce and inspect the failing behavior.
2. Compare against the **Java remote test** and **Java implementation** in
   `../blockchain` (the origin). If Java behaves the same way, the TS port is
   faithful and the issue is in Java, the chain, or the infra.
3. Check the TS implementation (`packages/big-tangle-ts/src`) only if it
   diverges from the Java reference. TS test expectations mirror the Java test
   assertions exactly.

In short: **when there is a problem, check the Java implementation and Java test
first. The TS code is only there to test the TS implementation.**

## How the remote tests run

### 1. `e2eremote.sh` (TS remote tests, infra via `infra.sh` → Java `remote.sh`)
- Runs the TS remote tests under
  `packages/bigtangle-ts/test/testintegration/`:
  ```
  cd packages/bigtangle-ts && npx vitest run --exclude '**/RemoteTest.ts' test/testintegration/
  ```
- Infra is brought up through `e2e/infra.sh` (→
  `../blockchain/.../remote.sh infra`), so the TS tests run against the **same
  Java-built L0/L1/MCMC infra as the Java remote tests** — no docker-compose
  drift. `e2e/docker-compose.yml` is no longer used for the TS remote tests.
- Default ports: `18088` (L0), `18086` (L1) — forwarded to the tests via
  `TEST_CONTEXT_ROOT` / `TEST_L1_URL`. `remote.sh` must be started with
  `FUND_ENABLED` (`server.fundEnabled=true`), which it does by default.

### 2. `remote.sh` (maven/spring-boot, Java)
- Located in `../blockchain/layer0-mcmc/src/test/java/net/bigtangle/mcmc/remote/remote.sh`.
- Starts L0/L1/MCMC via `mvn spring-boot:run` and runs the **Java** remote test
  classes. This is the reference/oracle for expected behavior.
- `e2e/infra.sh` is a thin wrapper that execs `remote.sh infra` (up) or
  `remote.sh stop` (down).

After any failing run, `e2eremote.sh` stops the infra via `infra.sh down`.

## Java build vs remote.sh
- `remote.sh` runs from the Java source via `mvn spring-boot:run`, so it always
  reflects the current `../blockchain` source. Rebuild `../blockchain` modules
  when the Java code changes:
  ```bash
  cd ../blockchain
  mvn package -DskipTests -pl layer0-server,l1-order-server -am
  ```
  (The old GHCR-image path with "Unresolved compilation problems" jars only
  applied to the removed docker-compose flow.)

## Notes as of 2026-10-11

- **L1 order/prediction chain wedge fixed (Java)**. The L1 chains have their own
  fresh genesis (`751b2006…`) but list L0 as `server.requester`; `syncChain`
  reward-synced L0's chain (genesis `b005e4de…`) anyway, importing 589 of L1's
  647 blocks as foreign, unconnectable history. L1's proposal reference-sweep
  then referenced those L0 blocks (`MissingPredecessor`), so its own beacons
  could never solidify and the chain wedged at cl 42 — every bc transfer
  (`order.spec.ts`, `trade.spec.ts` funding) timed out, and a bogus
  `FINALITY RECONCILE` loop treated the unrelated chains as a sibling fork.
  Fixed in `../blockchain` `SyncBlockService.remoteOnOurChain()`: a sync peer
  that does not serve our genesis block is provably on a different chain and is
  skipped for reward sync (non-chain transfers still arrive via
  `syncNonChained`; the bridge reads L0 over HTTP). Same-chain meshes are
  unaffected (they serve the genesis). `trade.spec.ts` also asserted the old SVG
  `trade-chart-price` while the web build renders the canvas `trade-chart-pro`
  (`lightweight-charts`); the chart assertion now accepts either. Full run:
  43 passed / 3 skipped / 0 failed (`trade.spec.ts` "renders a CNY-quoted
  market" now green). Rebuild `../blockchain` (`mvn install -pl
  bigtangle-servercore`) before re-running so the running L1 picks up the jar.
- **Still pre-existing**: the repo-wide `vitest` collection of
  `expo-app/e2e/tests/*` dies with `truncated ML-DSA private key` (wallet unit
  tests are the `test/unit/` suites — 108 passing).
- **No standalone Chart screen**: it was removed (commit `9f85c11`) — the chart
  lives inside Spot/trade only, `chart.spec.ts` is gone, `e2etest.sh` runs only
  `order.spec.ts` in its order part, and `capture-order.mjs` captures the chart
  from the Spot screen (`ok order-06-chart`).

## Notes as of 2026-10-23

- **L1 peg-in needs a test-net issuance-key override (Java)**. `0a404ee89` /
  `daa5cbbe5` moved CROSSTANGLE mint validation from each node's
  `bridge.issuancePubKeyHex` to a key shipped in the build
  (`/<chainid>-issuance.pub`), whose private halves are operator-held prod
  secrets (`helper/prod/…/issuance-*.env`). The fulltest harness signs peg-ins
  with its deterministic `ISSUANCE_SEED=0x2222…`, so every L1 mint failed
  `L1 CROSSTANGLE issuance signature does not verify under the chain's issuance
  key`; the L1 genesis wallet then had **0** spend candidates and
  `order.spec.ts` / `trade.spec.ts` died at
  `calculateAllSpendCandidates(...)` (`Expected: > 0, Received: 0`).
  `remote.sh` cannot be fixed on its own (no matching private key exists), so
  `ChainIssuanceKey.resolve(params, configuredKey)` now lets an explicitly
  configured `bridge.issuancePubKeyHex` win on `TestParams` chains only —
  mainnet still uses the shipped key, so nodes cannot disagree on a mint there.
  Sanity check after an infra restart: the L1 genesis wallet (ML-DSA seed
  `0x01`) must have > 0 spend candidates before running order/trade.
- **`E2E_AUTOCONFIRM` hides the confirm sheet**: e2e web builds auto-approve
  `confirmImportant` (`TransactionConfirm.tsx`), so specs must not assert
  `confirm-transaction` — a buy/order click posts its signed request straight
  away. `p2p-page.spec.ts` now mocks `/orders/<id>/match` + `/swaps/mine` and
  asserts the payload. It also had to follow `checkP2pFill`'s remainder rule: an
  amount may not leave the ad below `minOrder` (20 USDT on a 25 USDT remainder
  leaves 35 CNY < 70, so it is rejected; 15 USDT → 105 CNY is allowed).
  `p2p-ui` part: 10/10 green.
## Notes as of 2026-11-01

- **Android payments failed on every binary chain write (fixed)**. The
  Capacitor app's `native-bridge.js` `convertBody()` UTF-8-decodes a
  `Uint8Array` request body before the native layer, so a signed transaction
  lost every non-UTF-8 byte to U+FFFD and grew (~300 → ~550 bytes); the node
  answered `ProtocolException … ArrayIndexOutOfBoundsException: arraycopy: last source index 658 out of
  bounds for byte[547]` at `TransactionOutput.parse` and the app showed that
  body verbatim. The web wallet was unaffected (browser sends the bytes
  as-is) and L1 orders were unaffected (JSON `{txhex}`), which is why only
  payments/saveBlock/signToken broke on device. Fixed with
  `expo-app/sources/services/binaryPost.ts` (`dataType: 'file'` + base64 +
  `responseType: 'arraybuffer'`, installed into `OkHttp3Util` from
  `app/_layout.tsx`); see `android.md` → **Binary POSTs**. Tests:
  `expo-app/sources/services/__tests__/binaryPost.test.ts`,
  `packages/bigtangle-ts/test/utils/OkHttp3UtilTransportTest.ts`.
  The plugin import must stay **static**: `import('@capacitor/core')` becomes
  Metro's `_asyncRequire(id, {paths})`, which never settles in the WebView
  (payment stuck at "发送中…", no request made, no resource entry) — the
  first version of this fix hung exactly there until the import was made
  static.
- **The generated Gradle wrapper is pinned by `webapp/scripts/patch-android.mjs`**
  (8.14.3). A wrapper refresh to Gradle 9.6+ fails configuration with
  "relies on `org.gradle.api.problems.internal.InternalProblems`" because AGP
  8.13 still uses that removed internal API.

- **OS notifications now mirror `../dai`.** Android had no notification path at
  all (in-app banners only, no `POST_NOTIFICATIONS`, no channel). Ported dai's
  stack: `webapp/native/notifier/.../NotifierPlugin.java` (channel
  `wallet_events`, IMPORTANCE_HIGH, `notify({title,body,tag})`, tap → app),
  `expo-app/sources/services/nativeNotify.ts` (same four calls as dai's
  `lib/nativeNotify.ts`) and `systemNotifications.ts` (gate = Settings pref +
  OS permission + `document.visibilityState === 'hidden'`, mirroring dai's
  `lib/notify.ts`). `notifySystemMessage()` mirrors to the OS, so
  payment/order/P2P/prediction events land outside the app. `patch-android.mjs`
  copies the plugin, adds `POST_NOTIFICATIONS` and writes `ic_stat_wallet`.
  Verified on a debug build: channel present, `dumpsys notification` shows
  `pkg=ai.bigt.wallet tag=sys_…`, shade renders "Wallet / Payment finalized".
  Still process-alive only (WebView poller), same limitation dai documents.

- **Wallet unlock is credential-based after the first password unlock.** The
  lock screen now offers fingerprint/face/PIN (via the existing `DeviceAuth`
  plugin) instead of the password every time, like `../dai`'s remembered
  device. `services/walletRecall.ts` stores the password under
  `wallet.deviceUnlock`, which `storage/secureWeb.ts` routes to the
  Keystore-backed plugin (never localStorage); it is read only after
  `confirmWithDeviceUnlock()` succeeds and is dropped by Settings → *Unlock
  with fingerprint or face* or wallet deletion. Two bugs fixed on the way:
  `state/wallet` locked on AppState `inactive` (which the OS unlock prompt
  itself triggers, wiping the wallet mid-unlock — now `background` only), and
  the unlock was not remembered on create/import.
  Follow-up found on device: auto-opening `BiometricPrompt` on mount lost its
  `AuthenticationCallback` and the button stuck on "解锁中…" (the plugin call
  never resolved), so the prompt is now user-triggered and
  `confirmWithDeviceUnlock()` races a 90 s timeout.

- **One payment shows up as several TRANSFER blocks (branch blocks).** The
  node builds its block prototype from two tips (`CacheBlockPrototypeService`:
  `Block.createBlock(trunk, branch)`), so a mempool transaction is proposed
  into the trunk block *and* into branch siblings — the same tx hash appears in
  one block with positive depth and one or more with **negative** chainlength
  (verified on eu1: `7c30e864…` in 4098 + two −4098 blocks; same for every
  transfer there). Funds move once and the fee is charged once. The explorer
  now flags `chainlength < 0` as `branch` (`lib/blockinfo.ts`) and hides those
  rows behind a "显示分支块" toggle (count line shows
  `N 个区块 · 已隐藏 M 个分支块`), with a 分支 badge when shown.

## Notes as of 2026-11-02

- **P2P works with a legacy EC wallet again.** `P2pScreen` set `identity = null`
  for `keyType === 'EC'` (P2P signs with ML-DSA + a `did:key`), so an unlocked
  legacy secp256k1 wallet showed "请先解锁钱包" on the create form (the "create
  P2P buy shows unlock first" report) — the mine tab is the only place the create
  form lives. `p2pIdentityFromWallet` (`lib/p2pIdentity.ts`) now derives the P2P
  identity deterministically from the EC 32-byte secret (`PQKey.fromPrivateKeyHex`
  → ML-DSA seed); the EC address stays the receive/refund address. Covered by
  `lib/__tests__/p2pIdentity.test.ts` and
  `e2e/playwright/tests/p2p-legacy-wallet.spec.ts` (seeds a plain EC wallet,
  needs a P2P-enabled web build).
- **The wallet no longer auto-locks during its own OS unlock prompt.** On OEM
  builds the device-credential step of `BiometricPrompt` runs in another
  activity, so the WebView goes `background`; the AppState handler wiped the
  wallet mid-create/pay and the screen returned to "unlock first" after the
  user authenticated. `services/deviceAuth.ts` now counts in-flight prompts
  (`isDeviceUnlockPromptActive`) and the wallet locks on background only when no
  prompt is up (plus a 1.5 s settle re-check if the user really left). Plain
  (unencrypted) wallets are never moved to the locked state — they have no
  password to unlock them again.
- **Diagnosing the device wallet type**: the app is release-signed but
  `webapp.sh` builds a *debuggable* APK with the same cert, so installing it
  over the release app keeps the data and exposes `webview_devtools_remote`
  (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then CDP).
  The wallet itself is scrypt-encrypted, so key type was proven from chain
  history instead: `getBlockByHash` → the spending input's scriptSig has a
  33-byte secp256k1 pubkey (an ML-DSA pubkey is ~2.6 KB).
- **The pinned relay `https://92.5.34.128` works now (not just a cert problem).**
  s1002 ran only the seeds registry: there was no `/l0/` or `/l1/` route at all.
  Caddy there now proxies `/l0/*` → `https://eu1.bigtangle.org`, `/l1/*` →
  `https://ordereu1.bigtangle.org`, keeps `/getPeers`, and sets the global
  `default_sni 92.5.34.128` (Android sends no SNI for an IP-literal URL, which
  made Caddy answer `TLSV1_ALERT_INTERNAL_ERROR`). The IP cert is from Caddy's
  local CA (IP SAN, 12 h auto-renew); the app pins that root in
  `webapp/native/relay-ca/relay-ca.crt`, and `patch-android.mjs` trusts it
  **only** for `92.5.34.128` via `network_security_config.xml`. Verified on the
  phone: CapacitorHttp `POST https://92.5.34.128/l0|/l1/getChainNumber` → 200.
  The relay config is mirrored in `deploy/s1002-relay.caddy`; if Caddy's
  `/var/lib/caddy` is wiped the CA changes and the app must be rebuilt with the
  new root. Do not "fix" this by disabling verification or trusting system CAs.

- **P2P engine runtime image is ~2x smaller (206 MB vs 443 MB).** The runtime
  stage used to copy the build stage's full `node_modules` (installed with
  `--production=false`), `packages/` and `services/` — 443 MB / 141.6 MB
  compressed. It now ships only the 4.5 MB esbuild bundle plus the three
  packages the bundle keeps external (`pg`, `ajv`, `ajv-formats`, with the
  versions read from the build's resolution) → **206 MB / ~72 MB compressed**
  (remaining weight is the `node:20-slim` base; `node:20-alpine`/distroless
  would cut another ~60-80 MB). Verified the slim image boots in mem and blob
  modes, serves `/healthz` + `/capabilities`, accepts a DID-signed `POST
  /orders`, matches it and derives the 2-of-3 escrow address, and verifies a
  classic EC-DID signed read (same results as the old image).

- **Chinese P2P demo on the Android app (funds-free) + mobile PDF.** The
  on-device walkthrough is `e2e/capture-p2p-android-cny.mjs`: it starts a local
  memory-store `p2p-engine`, reverses it into the phone, drives the installed
  demo APK via its WebView devtools with two plain demo wallets (temporarily
  replacing the device wallet, backed up/restored in `finally`), and writes the
  14 `p2p-cny-wechat-NN-*-zh.png` shots. Rate is **BIG/CNY = 0.01** (10,000
  BIG → 100 CNY). Build the demo APK with
  `EXPO_PUBLIC_P2P_ENGINE_URL=http://127.0.0.1:18089 EXPO_PUBLIC_E2E_AUTOCONFIRM=1 APP_VERSION_NAME=1.0.124 APP_VERSION_CODE=1000124 ./webapp.sh --device=… --no-launch`,
  and reinstall the release APK afterwards. Mobile PDF:
  `DOCS_PDF_MOBILE=1 npx tsx scripts/docs-pdf.mts --md docs/p2p-demo/p2p.zh.md --out docs/p2p-demo/assets/p2p-android.zh.mobile.pdf --lang zh`
  (390×844 page, one section per page). Screenshots/PDFs stay gitignored.

## Notes as of 2026-11-05

- **Legacy EC wallets can sell BIG again (P2P funds gate).** The advisory
  `SETTLEMENT_ORDER_FUNDS_CHECK` read the token giver's balance at the
  **P2P DID's** key hash. A legacy EC wallet signs as an ML-DSA DID derived
  from its secret, so that key is not the wallet's EC address: a funded seller
  was rejected with `seller balance insufficient: 0 BIG on L0` (or, on a buy
  bid, `counterparty has insufficient BIG balance for this match`), e.g.
  selling 1000 BIG into a 1,000,000 BIG / 10 CNY bid (quoted 0.01 CNY). The
  client now attaches a funds proof to sell-ad and match bodies — `fundsDid`
  (classic did:key over the secp256k1 pubkey) + `fundsSignature` over the
  canonical payload including `fundsDid` — and the engine verifies it in
  `verifyFundsProof` (`src/sign.ts`), checks that EC h160, and stores it as
  `p2p_orders.funds_hash` (added by the boot ALTER) so book reads and matches
  keep using the right key. PQ wallets are unchanged (their DID key *is* the
  address) and send no proof. `funds_hash` is internal: stripped from the
  public book like `buyerReceiveAddress`. Tests: `funds.test.ts` (EC sell ad,
  buy-bid taker, tampered proof) and `p2pIdentity.test.ts`. The deployed
  `wallet-p2p-engine:latest` must be rebuilt/redeployed to pick this up.

- **P2P payment profiles are per rail; PayPal was only off in the engine env.**
  The Mine-tab profile form re-used one set of inputs for every method, so a
  WeChat account typed once was still in the fields when saving Alipay/bank.
  The form now loads the selected rail's saved profile (or clears) whenever the
  method or the saved list changes. PayPal never appeared because the shared
  engine's `SETTLEMENT_CNY_RAILS` was `wechat,alipay,bank`; it now includes
  `paypal` (`SETTLEMENT_FIAT_RAILS` is the newer name, `CNY_RAILS` still read).
  The rails are already protocol-supported, so no engine code changed.

- **A matched swap no longer vanishes when the engine rebuilds its projection.**
  In blob mode orders/swaps are replayed from L1-SOCIAL at boot. The replay
  dropped a `MATCHED` `social.p2p-swap` record whenever the ad's
  `social.p2p-order` was missing (engine-intake ads never anchor one) or its
  fill exceeded the projected remaining — `replay.ts` returned before
  `appendEvent`, so `/swaps/mine` lost the trade with no later transition to
  bring it back. The swap is now always appended (the order bookkeeping stays
  best-effort and reports a conflict), so a matched trade survives restarts and
  its parties can continue. Test: `replay.test.ts` "keeps an anchored swap when
  its engine-intake order is not on chain".

- **P2P: the seller can fund the escrow with one click, and the lock check accepts
  token aliases.** The matched-seller card had only a manual `txHash` field (send
  the tokens yourself, paste the hash). `fundEscrowAndLock` now sends
  `giveAmount` from the wallet to the swap's escrow address (`payOnLayer0`,
  P2SH-capable), polls L0 until CONFIRMED, then submits `escrow_lock` and
  presigns — the fiat leg stays manual (no WeChat/Alipay API; it is gated until
  ESCROW_LOCKED on purpose). Under it, `verifySettlement` compared the order's
  `giveToken` ("BIG", the token **name** the picker stores) with the escrow
  output's `token` ("bc", the id) **strictly**, so a correctly funded BIG lock
  failed with `insufficient`. `normalizeOutputs`/`outputsHistory` now attach the
  node's `tokennames` metadata to each row and `sameToken` matches any of
  token/id/symbol/name, so both spellings verify. Tests:
  `p2p-protocol/test/settlement.test.ts`, `chain.test.ts` metadata row.

- **P2P escrow funding is idempotent and its feedback is visible.** A first
  "Pay escrow & lock" click sent 1000 BIG but the auto-lock did not complete
  (the tx confirmed after the client's poll/while the tab was throttled), so the
  user saw "nothing happened" — the result banner is at the top of a long
  scroll page. The action now checks the escrow address for an existing
  confirmed output covering the amount (`fundedEscrowTx`) and reuses that tx
  hash instead of sending again, so a second click only locks. The notice effect
  scrolls the page to the banner, making every P2P result visible.

- **P2P presign is attempted automatically after every escrow lock.** The lock
  path skipped it when `caps.chain.l0` was falsy (an older/failed
  `/capabilities` fetch), leaving a locked escrow unarmed with only a manual
  Presign button — the reported "why not automatic presign?". It now always
  presigns after `escrow_lock` (3 attempts, 2.5 s apart: the app's selected L0
  node can lag the just-confirmed output) and shows `presignFailed` with the
  reason instead of hiding it; Presign remains for a retry. Presigning is still
  the seller's own key (the engine cannot sign for a party); it arms
  release/refund for automatic settlement.

- **P2P release address is store-only; a lost one can be repaired by the buyer.**
  `social.p2p-swap` omits the buyer's `receiveAddress` (privacy), and blob mode
  rebuilt swaps from that record, so after an engine restart a locked swap had
  no release destination: presign failed with `Address is too short` and
  `verifyChainPayment` had nowhere to pay. Stores now keep a `swap_receive`
  copy (`setSwapReceiveAddress`; blob meta, pg table) merged back into
  `getSwap`/`listSwaps*`, and every match event writes it. `/swaps/:id/receive-address`
  lets the **buyer** (only) repair an already-locked swap; `walletView` exposes
  `hasReceiveAddress` (boolean) so the buyer's card shows the save field. The
  seller cannot set it (that would let them redirect the buyer's tokens). If a
  swap is locked without it, the buyer must save it before the seller can
  presign/release. Tests: `blob.test.ts` restart merge, `funds.test.ts` route.

- **P2P match reminds the seller to fund the escrow.** The global
  `P2pEventWatcher` only emitted a generic "swap is now MATCHED" and skipped
  legacy EC wallets entirely (`keyType === 'EC'` → no identity), so a seller
  could sit on an unfunded match forever (and the user's wallet is EC). It now
  derives the identity with `p2pIdentityFromWallet` and, for a `MATCHED` swap
  where `sellerDid` is this wallet, raises an actionable
  `system.p2pFundEscrowTitle` / `p2pFundEscrowBody` notice ("You sold …
  fund the escrow and tap Pay escrow & lock") — including on the first poll, so
  a match made while the app was closed is not missed. The generic status
  notice still covers the other transitions. `matchNotified` is per session, so
  reopening the app re-reminds until the escrow is locked.

- **Incoming payments get a finality notification too.** `ChainEventWatcher`
  only followed *outgoing* tracked payments, so money arriving produced no
  message. `IncomingPaymentWatcher` (mounted beside it) polls this wallet's L0
  `getOutputsHistory` every 30 s with a `starttime` window (last poll − 10 min),
  groups confirmed outputs by tx+token, and raises `system.paymentReceivedTitle`
  / `paymentReceivedBody` ("{{amount}} {{token}} received. Tx …"). It skips
  change/self transfers (`fromaddress` = us), transactions in the local outgoing
  tracker, and coinbase outputs; the first run only seeds `lastTime=now`, so the
  wallet's history is not replayed as notifications, and at most 5 notices fire
  per tick after a long offline period. State (`seen` keys + `lastTime`) is
  persisted under `notifications/incoming`. Same process-alive/WebView poller
  limitation as the other watchers.

- **Taking a sell ad prefilled the buyer's release address.** `toggleOrder`
  cleared `buyRecv` for every ad, so tapping Buy on a `limit_sell` hit the
  app-side `!buyRecv.trim()` guard and showed the generic "Match failed" (the
  engine requires `receiveAddress` for the taker-buyer). It now defaults to
  `publicInfo.address` (and `submitBuy` falls back to it, disables Buy when
  empty, and uses `transaction.errRecipient` for the message). Also the taker
  profile gate now applies only to a **buy bid** (taker = seller); a buyer on a
  sell ad needs no collection profile.

- **Open P2P ads survive an engine restart.** Blob mode rebuilds orders from
  L1-SOCIAL, but the web/native client has no `P2P_SOCIAL_URL`, so ads are
  engine-intake and were lost on every deploy (the reported "seller p2p
  disappeared": the 1000 BIG / 3 CNY ad vanished at the v1.0.139 restart).
  `BlobSettlementStore` now persists each order to the `orders` collection
  (loaded into a cache once), re-seeds missing orders into the projection on
  `getOrder`/`listOrders`, and rewrites the stored copy on
  match/cancel/reopen/funds-hash changes. Chain-anchored orders still win in
  the projection; the blob copy is only the engine-intake fallback. Test:
  `blob.test.ts` "persists engine-intake orders across a projection rebuild".

- **A funded escrow no longer stays unlocked on a chain-read race.** After
  "Pay escrow & lock" sends the tokens, the app polls its own L0 view for
  CONFIRMED and then submits `escrow_lock` once. The engine reads a different
  node; if that node still says PENDING the transition fails 422 and the swap
  stays MATCHED with the tokens already in escrow (the "sent, nothing happened"
  / "first time failed, second fine" report). `lockAndPresign` now retries the
  transition up to 4 times, 4 s apart, for chain-verification errors only; the
  existing `fundedEscrowTx` pre-check keeps a retry from sending twice.

- **My swaps refreshes itself and "buyer paid" is a specific notice.** The P2P
  screen only refreshed on mount/tab change (or a manual Refresh tap), so the
  counterparty's "I have paid" sat invisible until the user reloaded. The Mine
  tab now polls `mySwaps` silently every 15 s and on app foreground, and
  `P2pEventWatcher` raises `system.p2pPaidTitle`/`p2pPaidBody` for a
  `PAYMENT_CLAIMED` transition where this wallet is the seller ("{{amount}}
  {{currency}} … check your {{rail}} account, then tap Confirm received")
  instead of the generic status line.

## Notes as of 2026-11-07

- **Ethereum (EVM) deposit/withdraw for legacy EC wallets** (docs/ethereum.md,
  docs/assets-deposit-withdraw.md). The wallet's EC key is used directly as the
  Ethereum key (vmproject parity): address = `0x` + keccak256(uncompressed
  pubkey)[12..], EIP-55 display. PQ keys have no secp256k1 point, so the
  Ethereum screen gates on `keyType === 'EC'` and points at Keys, which now
  offers "Create legacy EC wallet (Ethereum)" and "Import EC key (Ethereum)"
  (`createEcWallet`/`importEcPrivateKey` in `screens/wallet/WalletHelper.ts`).
  Signing is EIP-1559 with the chain id (never vmproject's replayable legacy
  tx), and the EC private key never leaves the device — only the signed raw
  transaction is broadcast (unlike `getBalances`, which posts the key to L0).
  Crypto uses libs already in the bundle: `secp256k1.ecdsaSign` (gives the
  recovery id) and `@noble/hashes/sha3.js` keccak.
- **`/eth` is a same-origin proxy.** `region.sh config_caddy` adds
  `handle_path /eth` **and** `handle_path /eth/*` → `$ETH_RPC_URL`
  (`region.conf` default `https://ethereum-rpc.publicnode.com`, override with the
  env, or `deploy/env/.env.eth.<region>`); native builds use
  `https://wallet.bigt.ai/eth`. No provider key in the bundle. Both matchers are
  needed and both must use `handle_path`: the app POSTs to the bare `/eth`, which
  `handle_path /eth/*` does not match, and a plain `handle /eth` leaves the
  `/eth` prefix on the upstream path (publicnode answers
  `{"error":{"code":-32001,"message":"Resource not found"}}`). `/ethereum` is the
  SPA route, so `/eth*` must not be used. The Caddy `reverse_proxy` sets
  `header_up Host <provider host>` — public endpoints reject a foreign Host.
- **Testing without a chain**: `e2e/eth-rpc-mock.mjs` (deterministic balances/
  fees/receipts, captures the raw tx) + `e2e/playwright/tests/ethereum.spec.ts`
  inject a plain EC wallet (`0x4c08…` → `0x2c7536E3…`) and drive deposit +
  withdraw. Unit tests: `expo-app/sources/lib/eth/__tests__/*` (address vectors,
  EIP-55, RLP vectors, type-2 sign/recover/low-S, ERC-20 ABI, EIP-681, units).
