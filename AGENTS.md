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