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

Two infra paths exist:

### 1. `e2eremote.sh` (docker-compose, `packages/big-tangle-ts/test/testintegration`)
- Starts `e2e/docker-compose.yml` (L0/L0-mcmc/L1-order/L1-order-mcmc + postgres),
  registers the PoS validator, waits for blocks, then runs:
  ```
  cd packages/bigtangle-ts && npx vitest run --exclude '**/RemoteTest.ts' test/testintegration/
  ```
- Uses ports `18088` (L0), `18086` (L1).

### 2. `remote.sh` (maven/spring-boot, Java)
- Located in `../blockchain/layer0-mcmc/src/test/java/net/bigtangle/mcmc/remote/remote.sh`.
- Starts L0/L1/MCMC via `mvn spring-boot:run` and runs the **Java** remote test
  classes. This is the reference/oracle for expected behavior.
- Also backs `e2e/infra.sh` in this repo.

After any failing run, `e2eremote.sh` tears the docker-compose infra down.

## Docker images vs local build
- The docker compose file pulled GHCR images (`ghcr.io/bigt-ai-platform/...`).
  If Java compiled a class (e.g. `l1-order-server`'s `Layer1HandlerConfiguration`)
  before a dependency module (e.g. `bigtangle-bridge`) was on the classpath, the
  image jare contains a class with **"Unresolved compilation problems"** baked in
  and crashes at startup. If L1 won't start, rebuild the jar from `../blockchain`
  with the dependency on the reactor classpath:
  ```bash
  cd ../blockchain
  mvn clean package -DskipTests -pl l1-order-server -am
  docker build -t ghcr.io/bigt-ai-platform/l1-order-server:latest l1-order-server/
  ```
  then rerun `e2eremote.sh`.