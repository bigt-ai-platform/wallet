# E2E Token Test Bugs and Fix Plan

## 1. JS SDK Block Type Serialization (FIXED)

**File:** `packages/bigtangle-ts/src/net/bigtangle/core/Block.ts`

**Bug:** `writeHeader()` serialized block type as ordinal string (e.g. `"3"`) via `.toString()`, Java server expects enum name string (e.g. `"BLOCKTYPE_TOKEN_CREATION"`).

**Fix:** Changed to `BlockType[this.blockType]` (TypeScript reverse enum lookup).

---

## 2. PoW solve never terminates on testnet (FIXED)

**File:** `Block.ts`

**Bug:** Testnet has `difficultyTarget = 0`. `solveTarget()` looped 1M iterations comparing hash > 0, which is always true for any positive hash → never exits.

**Fix:** Added early return when `powTarget === 0n` in both `solveTarget()` and `checkProofOfWork()`.

---

## 3. SpentBlock binary format mismatch with Java (FIXED)

**File:** `SpentBlock.ts`

**Bug:** Java's `SpentBlock extends DataClass` directly (NOT `Spent`), but JS `SpentBlock extends Spent`, producing duplicate fields in serialization. Also Java writes hashes via `writeNBytes` (boolean + int length prefix + bytes) while JS wrote raw 32 bytes.

**Fix:** Changed to `extends DataClass`, rewrote `toByteArray()`/`parseDIS()` to match Java format.

---

## 4. TokenInfo / Token binary serialization used JSON instead of Java binary (FIXED)

**Files:** `TokenInfo.ts`, `Token.ts`, `MultiSignAddress.ts`

**Bug:** JS `TokenInfo.toByteArray()` produced `JSON.stringify()` bytes. Java's `TokenInfo.parse(byte[])` reads binary via `DataInputStream` (big-endian `readInt` for lengths, `readNBytesString` for strings, etc.).

**Fix:** Rewrote all three classes to use binary format matching Java's `DataOutputStream`/`DataInputStream` protocol:
- `writeInt` / `readInt` (4-byte big-endian)
- `writeLong` / `readLong` (8-byte big-endian)
- `writeNBytesString` / `readNBytesString` (boolean + int length + UTF-8)
- `writeNBytes` / `readNBytes` (boolean + int length + bytes)

---

## 5. PQKey public key format missing 0x05 prefix (FIXED)

**Files:** `PQKey.ts`, `ScriptBuilder.ts`, `Script.ts`, `Wallet.ts`

**Bug:** Java `PQKey.getPublicKeyBytes()` returns `0x05 + bundle.serialize()` (prefixed), JS `getPubKey()` returned only `bundle.serialize()` (raw). Java's `PQScriptUtils.extractKeyBundle(byte[])` strips the first byte (`0x05`) before deserializing.

**Impact:** All scripts (output scripts) and multi-sign address pubkeys stored raw bundle bytes. Server's `saveMultiSign()` called `PQKey.fromPublicOnly()` which stripped the first byte (version `0x01`) and tried to deserialize the remaining bytes as a KeyBundle, failing with `truncated key bytes`.

**Fix:**
- Added `getPrefixedPublicKeyBytes()` returning `0x05 + bundle.serialize()`
- Changed `ScriptBuilder.createOutputScript(PQKey)` to use `getPrefixedPublicKeyBytes()`
- Changed `Script.getPubKey()` to strip `0x05` prefix when reading
- Changed `Wallet.saveToken()` to use `getPrefixedPublicKeyBytes()` for `MultiSignBy.pubKeyHex`
- Added `fromPrefixedPublicKey()` method

---

## 6. MCMC submitAttestation URL hardcoded to localhost:ownPort (FIXED in blockchain)

**File:** `bigtangle-servercore/.../ValidatorDutyService.java:131`

**Bug:** Line 131: `String contextRoot = "http://localhost:" + serverConfiguration.getPort() + "/";` — This constructs `http://localhost:8084/submitAttestation` (MCMC's own port) instead of using the L0 server URL.

**Fix:** Changed to use `serverConfiguration.getRequester()` (which is the L0 server URL, e.g. `http://l0-server:8088`).

**Status:** Fixed in Java source. Docker image needs rebuild (`mvn package` + `docker build`).

---

## 7. Root permission key mismatch — MainNetParams uses EC key, not PQ key (UNFIXED in blockchain)

**File:** `bigtangle-core/.../MainNetParams.java:50`

**Bug:** `permissionDomainname = ImmutableList.of("0222c35110844bf00afd9b7f08788d79ef6edc0dce19be6182b44e07501e637a58")` — This is a 33-byte EC compressed public key (starts with `02`). But `PermissionDomainname.getOutKey()` checks `pubKey[0] != PQ_PUBKEY_PREFIX (0x05)` and returns `PQKey.createNew()` (a **random key**!) for non-PQ keys. This makes the root domain permission check **impossible to pass** on `MainNetParams`.

**Workaround:** Changed `docker-compose.yml` `SERVER_NET: Preprod` → `SERVER_NET: Test`. `TestParams.permissionDomainname = ImmutableList.of(genesisPub)` where `genesisPub` is a PQ-prefixed key (starts with `05`), so `getOutKey()` works correctly.

**Root cause:** The `MainNetParams.permissionDomainname` entry was an EC key from before the PQ migration and was never updated to a PQ-formatted key. The `PermissionDomainname.getOutKey()` silently falls back to a random key instead of throwing, masking the bug.

**Fix Plan:**
1. Generate a PQ key pair for the mainnet root permission
2. Update `MainNetParams.permissionDomainname` with the PQ public key hex
3. Store the private key in a secure configuration (vault / env var)
4. OR: Update `PermissionDomainname.getOutKey()` to throw when the key format is invalid, so the bug is detected at startup

---

## 8. Token creation via signToken requires domain permission signature (SERVER CONSTRAINT)

**Java:** `ServiceBaseCheck.java:920-929`

**Bug (by design):** First-time token issuances (`tokenindex == 0`) require a signature from the genesis domain key (`permissionDomainname`). Without this signature, `checkDomainPermission()` removes all signatures, and `InsufficientSignaturesException` is thrown. `signTokenAndSaveBlock` catches this and saves the block as pending in the `multisign` table instead of the `blocks` table.

**Impact:** Tokens created via the HTTP API (`signToken`) are saved as **pending multi-sign** requests. They only appear in `searchTokens` after MCMC confirmation, which requires the domain signature flow to complete.

**Test flow (Java `AbstractIntegrationTest`):**
1. `saveTokenUnitTest` → calls `signToken` → saves to `multisign`
2. `pullBlockDoMultiSign(tokenid, outKey, aesKey)` → adds owner's signature → calls `signToken` again
3. `pullBlockDoMultiSign(tokenid, wallet.walletKeys().get(0), aesKey)` → adds genesis key signature → calls `signToken` again
4. `makeRewardBlock(lastBlock)` → MCMC confirms the block
5. Token appears in `searchTokens`

**Current state (JS e2e):** `wallet.createToken()` → `saveToken()` → `adjustSolveAndSign()` → `signToken` → block saved to `multisign` as pending (errorcode: 0). Token NOT in `searchTokens` until MCMC processes it.

---

## 9. Conflicting Docker container on port 8081 (WORKAROUND)

**Bug:** Another Docker Compose project (`l0-svr-0`) listens on `0.0.0.0:8081`, conflicting with the web app required by Playwright UI tests.

**Workaround:** `docker stop l0-svr-0` before starting the web app.

**Fix Plan:** Either:
- Use a dedicated port for the e2e web app (e.g. 8282) and update `playwright.config.ts`
- Add `docker stop l0-svr-0` to `infra.sh`

---

## Summary of Remaining Work

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1-5 | JS SDK binary format mismatches | HIGH | FIXED |
| 6 | ValidatorDutyService URL | HIGH | FIXED in source, needs Docker rebuild |
| 7 | MainNetParams EC permission key | HIGH | WORKAROUND (use `Test` net) |
| 8 | Domain signature requirement | MEDIUM | Accepted (pending multisign) |
| 9 | Port conflict | LOW | Workaround available |

**To fully fix token creation end-to-end:**
1. Add `pullBlockDoMultiSign` equivalent to the JS SDK (query pending multisign + sign + re-submit)
2. OR: Configure the server with a PQ-formatted `permissionDomainname` key and make its private key accessible
3. Rebuild the Docker image with the `ValidatorDutyService` fix
