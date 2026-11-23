# HSM/MPC signer adapter

The issuer can move every value-bearing signature out of the Node process. The
service talks to a **command** over stdin/stdout and never sees key material; a
missing or malformed response fails closed.

This replaces:

| Operation | Local fallback | HSM/MPC |
|---|---|---|
| L1 reissue + pay | `L1_ISSUER_KEY` in the worker | `L1_SIGNER=command` + `L1_MINT_COMMAND` |
| Deposit sweep signing | `DEPOSIT_XPRV` in the sweep job | `SWEEP_SIGN_COMMAND` |
| Redemption release | `RefusingTreasury` | `TREASURY_RELEASE_COMMAND` + `ALLOW_LIVE_TREASURY=1` |

The local paths are for Testnet/small float. In command mode there is **no L1
key, xprv, or custody key in the service environment** (only the command path).

## Configuration

```text
L1_SIGNER=command | local | refusing   (default: command if L1_MINT_COMMAND,
                                        else local if L1_ISSUER_KEY, else refusing)
L1_MINT_COMMAND=/usr/local/bin/l1-mint
SWEEP_SIGN_COMMAND=/usr/local/bin/sweep-sign
TREASURY_RELEASE_COMMAND=/usr/local/bin/treasury-release
ALLOW_LIVE_TREASURY=1                  (required to use the treasury command)
SIGNER_TIMEOUT_MS=30000
```

The sweep still needs `ALLOW_LIVE_SWEEP=1`; the mint still needs
`ALLOW_LIVE_L1=1`. Those gates are unchanged — the command is an additional
requirement, not a replacement.

## Protocol

One JSON object on stdin, one JSON object on stdout, exit code 0. Anything else
is an error. No shell is involved: the command is executed directly with no
arguments, so paths and arguments are fixed by the deployment.

### `sweep-sign`

```json
{
  "op": "sweep-sign",
  "address": "0x…",
  "addressIndex": 7,
  "chainId": "1",
  "nonce": "3",
  "maxPriorityFeePerGas": "1000000000",
  "maxFeePerGas": "3000000000",
  "gasLimit": "65000",
  "to": "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  "data": "0xa9059cbb…"
}
```

Response:

```json
{ "rawTransaction": "0x02…", "signer": "0x…" }
```

The service verifies that `signer` equals the allocated address, that the raw
transaction is type-2, and only then broadcasts it.

### `l1-mint`

```json
{ "op": "l1-mint", "assetId": "usdt", "account": "<base58 L1>", "amountRaw": "100000000" }
```

Response:

```json
{ "txHash": "…" }
```

The command owns the token id, the signer set/threshold and the
reissue → drain signatures → pay sequence. It must be idempotent per
`(assetId, account, amountRaw, operation)` or refuse a replay; the service's
operation row is the idempotency key, not a second ledger.

### `treasury-release`

```json
{ "op": "treasury-release", "assetId": "usdt", "account": "<base58 L1>", "externalRaw": "2000000" }
```

Response:

```json
{ "txHash": "0x…" }
```

**The command must resolve the holder's verified Ethereum destination itself.**
The service only knows the L1 account; releasing to it directly (or to a
DB-supplied address) is the redirect risk from the key review. Keep
`ALLOW_LIVE_TREASURY` off until that mapping and the approval policy exist.

## Wrapper shape

A command is a small executable that reads stdin and calls the vendor CLI:

```bash
#!/usr/bin/env bash
set -euo pipefail
payload="$(cat)"
# Parse op + fields, enforce policy, call the HSM/MPC CLI, print one JSON object.
exec /opt/vendor/bin/sign <<<"$payload"
```

Do not put secrets in the JSON, argv, or logs. The service caps stdout at 1 MB,
stderr at 8 KB, and kills the child after `SIGNER_TIMEOUT_MS`.

## What the service validates

- non-empty command output and valid JSON;
- `sweep-sign`: `rawTransaction` starts with `0x02`, `signer` matches the
  allocation;
- `l1-mint` / `treasury-release`: non-empty `txHash`;
- non-zero exit, timeout, or an over-size response fails the operation.

## Still required on the signer side

1. **M-of-N** — a single command process must not be able to mint alone; the
   threshold lives in the HSM/MPC policy or an approval service.
2. **Caps** — enforce `maxSupplyRaw` / `maxMintRaw` at the signer as well as in
   the service.
3. **Redemption destination** — verify the L1 account ↔ Ethereum address binding
   and the approval before signing a release.
4. **Nonce authority** — if several signer instances can sign sweeps, serialise
   nonce allocation at the signer; the current sweeper uses `pending` from one
   RPC.

## Tests

`services/asset-issuer/test/signers.test.ts` covers local signing, the command
payloads/responses, non-type-2 rejection and the missing-signer case. The
sweeper tests inject a signer and assert the address check before broadcast.

---

**See also:** [`issuer-key-risk-review.md`](./issuer-key-risk-review.md),
[`usdt-issuer-deposit-withdraw.md`](./usdt-issuer-deposit-withdraw.md),
`services/asset-issuer/src/signers.ts`.
