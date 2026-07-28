# E2E Token Test Bugs

## 1. Block type serialization (JS SDK)

`Block.ts` serialized block type as ordinal string (`"3"`) but Java server expects enum name (`"BLOCKTYPE_TOKEN_CREATION"`). Fix: `BlockType[this.blockType]`.

## 2. PoW solve never terminates on testnet

`difficultyTarget=0` causes `solveTarget()` to loop 1M iterations checking `hash > 0` which never passes. Fix: early return on `powTarget === 0n`.

## 3. SpentBlock binary format mismatch

JS `SpentBlock extends Spent` (Java extends `DataClass`), duplicating fields. Wrote hashes as raw 32 bytes instead of `writeNBytes` (boolean + int + bytes). Fixed: match Java format.

## 4. TokenInfo / Token serialization used JSON

JS `TokenInfo.toByteArray()` produced JSON. Java expects binary `DataInputStream`/`DataOutputStream` format. Fixed: binary serialization matching Java.

## 5. PQKey missing 0x05 prefix

Java `getPublicKeyBytes()` returns `0x05 + bundle.serialize()`. JS returned raw bundle. `extractKeyBundle` strips first byte → `truncated key bytes`. Fixed: `getPrefixedPublicKeyBytes()`, updated `ScriptBuilder`, `Script.getPubKey()`, `Wallet.saveToken()`.

## 6. MCMC attestation URL wrong

`ValidatorDutyService.java:131` used `http://localhost:{ownPort}/submitAttestation` instead of L0 server URL. Fixed: use `serverConfiguration.getRequester()`.

## 7. MainNetParams permission key is EC (not PQ)

`MainNetParams.permissionDomainname` contains 33-byte EC key (`02...`). `PermissionDomainname.getOutKey()` returns random key for non-PQ prefix → domain permission check impossible. Workaround: `SERVER_NET=Test` (uses `TestParams` with PQ key).

## 8. Token creation requires domain signature + multi-sign flow

First-time issuances need genesis domain key signature. Otherwise saved as pending multisign. Java `RemoteTokenTests` uses `wallet.multiSign()` (which calls `getTokenSignByAddress` + `signToken`) — the Java wallet has the correct genesis key (`fromSeeds(0x01,0x02)`) with domain permission.

### Token creation flow (Java `RemoteTokenTests`):
1. `createToken(key, name, ...)` — calls `wallet.createToken(key, domainname, increment, token, addresses, pubKey, memoInfo)` → submits via `signToken`
2. `wallet.multiSign(pubkey, wallet.walletKeys().get(0), aesKey)` — fetches pending multisign via `getTokenSignByAddress`, signs, resubmits
3. `makeRewardBlock(signed)` — `Thread.sleep(2000)` for server micro-batch to confirm
4. Poll `wallet.checkTokenId(tokenid)` up to 30s until token appears

### JS `RemoteTokenIT`:
- Same flow via `wallet.createToken()` + `wallet.multiSign()`
- JS `fromSeeds(0x01,0x02)` produces different key material than Java's `fromSeeds`
- → token stays in multisign-pending, never confirmed
- This is a known limitation: the JS SDK cannot replicate the genesis key

## 9. Port 8081 conflict

`l0-svr-0` container blocks port 8081. Workaround: `docker stop l0-svr-0` before starting web app.

---

## RemoteTokenTests.java (6 tests)

| Test | Method | Description |
|------|--------|-------------|
| 1 | `testServerHealth` | Server root responds with "Bigtangle" or "duration" |
| 2 | `testGenesisTokenExists` | Genesis BIG token (`bc`) exists via `searchTokens` |
| 3 | `testGetTokenByHash` | `getTokenById("bc")` returns at least 1 token |
| 4 | `testCreateTokenViaSignToken` | Create token via `signToken`, verify with polling |
| 5 | `testBeaconChainExists` | `getAllConfirmedReward` returns non-null response |
| 6 | `testCreateTokenViaWallet` | Create token via wallet, verify with polling |

Key patterns:
- All tests extend `RemoteTest` for shared wallet/server setup
- Token creation uses `batchBlock` endpoint + multi-sign + reward block
- Token verification polls `getTokenById` 15 times with 2s intervals
- Token IDs are hex-encoded public keys of the creating keypair

## Fix Plan

1. Rebuild Docker image with deployed JARs (done) ✅
2. Start infra, stop conflicting container, start web app, run tests (done) ✅
3. All 6 Java token tests pass (done) ✅
4. JS `RemoteTokenIT.test.ts` updated to use wallet-only API (`createToken`, `multiSign`, `searchToken`, `checkTokenId`). Token creation reaches multisign-pending; full confirmation blocked by JS/Java `fromSeeds` key derivation mismatch.
