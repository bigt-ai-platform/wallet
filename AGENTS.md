# AGENTS.md

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
