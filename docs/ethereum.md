# Ethereum in the wallet — plan (port of `../vmproject`'s ETH support)

**Status: P0–P2 implemented.** EC wallet creation/import, EVM balances, the
deposit address/EIP-681 QR, EIP-1559 withdrawals for ETH + ERC-20, the Settings
card and the `/eth` proxy are in the app (§11 lists what remains). Scope is
ETH + ERC-20 on EVM chains for **legacy EC wallets only**. Post-quantum (PQ, ML-DSA) wallets cannot use it: the
Bigtangle PQ key has no secp256k1 counterpart, so it cannot derive an Ethereum
address or sign an Ethereum transaction.

## 1. What the Java webapp does (reference implementation)

`../vmproject` exposes Ethereum through web3j, not through the Bigtangle node.
The wallet's **existing EC private key is used directly as the Ethereum private
key**; the address is web3j's `Credentials.create(hex).getAddress()`.

| Java artifact | Purpose |
|---|---|
| `vmcore/.../action/EthBalanceAction.java` | ETH balance (`ethGetBalance`) + ERC-20 `balanceOf` for every EC key in the wallet; page `cc/.../pay/balance.xhtml` |
| `vmcore/.../action/EthPayAction.java` | Send ETH (legacy `RawTransaction`) and ERC-20 `transfer`; gas limit/price fields, fee display, Etherscan gas-oracle refresh; page `cc/.../pay/pay.xhtml` |
| `vmcore/.../action/EthPublicBalanceAction.java` | Address **or public-key** → balance lookup, optional token contract; page `cc/.../public/eth/balance.xhtml` |
| `vmcore/.../eth/GasService.java` | Gas price from Etherscan `gastracker` (API key in source) / node `eth_gasPrice` |
| `vmcore/.../basic/CryptoTokenlist.java` | `ethtokens = { ETH, USDT }`; USDT mainnet contract `0xdac17f958d2ee523a2206206994597c13d831ec7` |
| `BigtangleDataService.getEthereumURL()` | Hard-coded Infura mainnet URL **with the project key in source** |

Behaviour worth keeping: ETH + ERC-20 in one list, fee shown before sending,
gas fields visible, public lookup by address *or* EC public key.

Behaviour we must **not** copy:

* the Infura/Etherscan API keys baked into source — our RPC credentials stay
  server-side behind the region proxy (§5.4);
* legacy (pre-EIP-155) transaction encoding — `TransactionEncoder.signMessage`
  without a chain id is replayable on every EVM chain; we use EIP-1559 with an
  explicit chain id;
* the server-side JSF flow where the private key is decrypted per request —
  the app signs on device and only ever sends a signed raw transaction.

## 2. Why EC works and PQ does not

```
Bigtangle EC key   32-byte secp256k1 secret            ← already in the wallet
   │
   ├─ Bigtangle address : base58( P2PKH( hash160(pubkey) ) )   (unchanged)
   └─ Ethereum address  : 0x + keccak256(uncompressed pubkey)[12..32]
       private key = the same 32-byte secret (vmproject parity)
```

PQ keys are ML-DSA-87 / SLH-DSA key material with no secp256k1 point, so no ETH
address exists. The wallet must therefore:

* show the Ethereum section **only** for `wallet.wallet.keyType === 'EC'`;
* for PQ wallets show one line explaining why (translated), with a link to the
  EC options below — never a dead "0x…" address;
* keep PQ wallets fully functional for everything else (no regression).

Today the app **creates PQ wallets only**: `createWallet()` and
`importPrivateKey()` both build a `PQKey`; only the legacy `.wallet` import
yields `keyType: 'EC'` (`screens/wallet/WalletHelper.ts`). So the first
deliverable is an EC entry path (§7, P0) — otherwise no new user can use ETH.

### Crypto primitives (already in the bundle — no new runtime dependency)

| Need | Available today |
|---|---|
| secp256k1 sign + recovery id | `secp256k1.ecdsaSign(msg32, priv)` → `{ signature: 64B, recid }` (the lib `bigtangle-ts`'s `ECKey` already uses) |
| keccak-256 | `@noble/hashes/sha3.js` `keccak_256` (dependency of `bigtangle-ts`) |
| uncompressed pubkey | `secp256k1.publicKeyCreate(priv, false)` |

Verified locally: privkey `0x…01` → `0x7e5f4552091a69125d5dfcb7b8c2659029395bdf`
(= `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`), and
`0x4c0883a6…362318` → `0x2c7536e3605d9c16a7a3d7b1898e529396a65c23`.

We should still add `@noble/hashes` and `secp256k1` as **direct** `expo-app`
dependencies (they are currently transitive) so imports are intentional and
version-pinned at the app level.

## 3. Security and product decisions (must be explicit in the UI)

1. **Key reuse.** The Ethereum key is the Bigtangle EC key. That is what
   vmproject does, and it makes the EC wallet a single recovery secret. It also
   means: whoever obtains the EC secret controls both chains, and the two
   addresses are linkable (same public key). The Ethereum screen shows a
   one-time, dismissible notice; the Keys screen says "Ethereum uses this
   legacy EC key".
2. **The private key never leaves the device.** The L0 client already posts the
   private key to the node for `getBalances`; the ETH path must not: RPC calls
   carry only addresses, and only signed raw transactions are broadcast.
3. **Chain id is always signed** (EIP-155/EIP-1559). No cross-chain replay.
4. **EC-only gate** (§2). A PQ wallet cannot see, receive-for, or send ETH.
5. **Address display**: EIP-55 checksum, monospace, middle-truncated; the send
   confirm sheet shows full `0x…` with the checksum character difference
   flagged (`lib/eth/address.ts` validates checksum and rejects mixed-case
   addresses that fail it — poisoned-address protection).
6. **No addresses in logs/analytics**; notifications show truncated addresses
   like the rest of the app.

## 4. What ships in v1

| Area | v1 | Later |
|---|---|---|
| Balance | ETH native + ERC-20 tokens (built-in USDT + add-by-contract) | token discovery/indexer, NFT |
| Receive | 0x address, EIP-55, EIP-681 QR (`ethereum:0xADDR@1`) | ENS names |
| Send | ETH + ERC-20 transfer, EIP-1559 fees with `eth_estimateGas`, nonce handling, receipt tracking, notifications | swaps, arbitrary contract calls |
| History | locally tracked sends (existing `services/tracking.ts`) + pending/confirmed status | explorer/indexer-backed full history |
| Public lookup | existing Address Balance screen gains an Ethereum mode (0x address **or** EC public key → ETH + token balances) — `EthPublicBalanceAction` parity | |
| Networks | Ethereum mainnet (1) + Sepolia (11155111) + custom RPC in Settings | more chains |
| Wallet | EC import/create (needed, §7 P0) | hardware/keystore, WalletConnect |

Out of scope: dapps, WalletConnect, ENS, NFTs, arbitrary ABI calls, PQ-derived
Ethereum, server-side keys, fiat pricing of ETH (reuse a price source later).

## 5. Architecture

### 5.1 Pure library (`expo-app/sources/lib/eth/`, unit-tested without React)

| File | Responsibility |
|---|---|
| `address.ts` | `privkeyToAddress`, `pubkeyToAddress` (65/33-byte input), `toChecksumAddress`, `isAddress`, `validChecksum` |
| `units.ts` | wei ↔ display BigInt math (reuse `lib/amountformat.formatValue`, 18 decimals) |
| `rlp.ts` | minimal RLP encoder for tx payloads |
| `tx.ts` | legacy + EIP-1559 (`0x02`) signing: RLP of `[chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList]`, keccak hash, `secp256k1.ecdsaSign` with recovery, `v = recid` for type-2 / `35+2*chainId+recid` for legacy |
| `abi.ts` | ERC-20 `balanceOf`, `decimals`, `symbol`, `transfer(address,uint256)` encode/decode (selector + 32-byte words; BigInt) |
| `eip681.ts` | build/parse payment URIs (`ethereum:0x…@1?value=…`, `/transfer?address=…&uint256=…`) |
| `chains.ts` | chain config: id, name, native symbol, RPC base, explorer base, USDT contract |

Follows the existing `lib/*` + `lib/__tests__/*` pattern (no React Native imports).

### 5.2 Services

* `services/ethRpc.ts` — JSON-RPC client: batching-free POST, 15 s timeout,
  same-origin base on web (`/eth`) and the proxy host on native, retry/failover
  across 2–3 bases ranked by latency (mirror `services/discovery.ts`). Allowlist
  the methods we use.
* `services/eth.ts` — `getBalances(account, tokens)` (ETH + ERC-20),
  `estimateFee` (`eth_estimateGas` × 1.2, `eth_feeHistory` → maxFee/maxPriority
  with `eth_gasPrice` fallback), `sendEth`, `sendErc20`, `getReceipt`,
  `getNonce('pending')` with a small in-memory pending-tx guard (serialize
  sends; vmproject hit exactly this with "serialize payments, reject duplicate
  resubmit").
* `services/tracking.ts` — extend records with `kind: 'eth-payment'`,
  `chainId`, `token`; a `EthTxWatcher` (pattern: `ChainEventWatcher`) polls
  `eth_getTransactionReceipt` and raises `system.paymentFinalized*` /
  `paymentFailed*` notifications, including on app foreground.

### 5.3 Screens

| Route | Content |
|---|---|
| `app/ethereum.tsx` (new stack screen, sidebar entry under TRADE/PORTFOLIO or a new "Ethereum" group) | EC gate; account card (0x address + copy + QR); balances (ETH + tokens); send/receive buttons; recent ETH activity |
| `app/receive.tsx` | reuse; add an Ethereum mode (EIP-681 QR, EIP-55 text) |
| `app/home/payment.tsx` | add a chain selector (Bigtangle L0 / L1 chains / Ethereum) that switches the token source, address validation and confirm sheet |
| `app/public-balance.tsx` | add a chain toggle: Bigtangle (today) / Ethereum (0x address or EC pubkey; ETH + optional token contract) |
| `app/(tabs)/settings.tsx` | "Ethereum" card: network (Mainnet/Sepolia/custom RPC), RPC URL, USDT/custom token list |
| `app/home/keys.tsx` | EC wallet create/import (§7 P0) + "Ethereum uses this key" note for EC wallets |

TestIDs follow the existing convention (`eth-screen`, `eth-balance-eth`,
`eth-send-amount`, `eth-confirm`, …) so the Playwright specs can drive it.

### 5.4 RPC transport (same-origin, no API key in the bundle)

The web build cannot call a provider directly (CORS) and must not embed a key.
Extend the region stack exactly like `/l0`, `/l1`, `/p2p`:

```
browser  ──/eth/*──►  Caddy (region vhost)  ──►  ETH_RPC_URL (provider or own node)
```

* `deploy/region.sh` + `deploy/region.conf`: add the `/eth` route and an
  `ETH_RPC_URL` per region (in `deploy/env/.env.eth.<region>`, never committed).
* Native builds use `https://<region>.wallet.bigt.ai/eth` (same proxy), not a
  provider URL, so no key ships in the APK either.
* Abuse control: Caddy `rate_limit` per IP; a small allowlist proxy
  (`services/eth-rpc-proxy`, optional phase) if quota becomes a problem. Our
  own node can replace the provider later without an app release.
* Testnet (Sepolia) uses the same shape with `ETH_RPC_URL_TESTNET`.

### 5.5 Config constants (`constants/app.ts`)

`ETH_CHAIN_ID` (1 / 11155111), `ETH_RPC_BASE` (`/eth` on web,
`https://eu.wallet.bigt.ai/eth` on native), `ETH_USDT_CONTRACT`, explorer URL.
Custom RPC override is stored through the existing `device` KV (like
`settings.serverUrl`), never in the bundle.

## 6. Transaction flow (send)

1. Resolve account: `keyType === 'EC'` → address from the EC secret (§2).
2. Validate recipient: `isAddress` + EIP-55; reject non-checksummed mixed case.
3. Amount: BigInt parse of the display value with token decimals (18 for ETH,
   `decimals()` for ERC-20, cached).
4. `eth_getTransactionCount(addr, 'pending')`; if a send is in flight, wait/queue.
5. Gas: `eth_estimateGas` (`{from,to,value,data}`) × 1.2 (min 21000 ETH / 60000
   ERC-20); `eth_feeHistory`/`eth_maxPriorityFeePerGas` → `maxFee`,
   `maxPriorityFee`; show the fee in ETH and the total debit before confirming.
6. Confirm sheet (existing `TransactionConfirm`, auto-approved under
   `E2E_AUTOCONFIRM`) → sign on device → `eth_sendRawTransaction`.
7. Store a tracking record; poll the receipt; on success notify
   `system.paymentFinalized*`, on revert `paymentFailed*` with the revert reason
   when `eth_call` can reproduce it.

ERC-20 sends use `transfer(address,uint256)` as `data` to the token contract,
`value: 0`, gas from `eth_estimateGas` (the usual 45–65k).

## 7. Phases

**P0 — EC wallet entry point (blocking, 2–3 d)**
Create "Legacy EC wallet (Ethereum-compatible)" and "Import EC private key"
(raw 32-byte hex; keystore v3 optional) in Keys; make the ETH key derivation
visible (`wallet keys` shows the 0x address). Without this, existing PQ users
cannot use Ethereum at all.

**P1 — Read-only Ethereum (3–4 d)**
`lib/eth/*` + `services/ethRpc.ts` + `services/eth.ts` balances; `app/ethereum.tsx`
balance/account UI; receive with EIP-681; settings card; public lookup mode;
`/eth` proxy in `deploy/`; i18n keys in all 12 locales.

**P2 — Send ETH (3–4 d)**
Signing library (legacy + EIP-1559) with vectors; fee/nonce; send + confirm;
receipt tracking + notifications; `EthTxWatcher`; e2e against a local chain.

**P3 — ERC-20 (2 d)**
USDT built-in + add-by-contract; `balanceOf`/`decimals`/`transfer`; token list in
Settings; fee display for token sends (native ETH fee).

**P4 — History & polish (2–3 d)**
Explorer-backed history behind the proxy (`GET /ethapi/address/:addr/txs`,
provider-specific) if we want `EthRecordAction` parity; gas presets
(slow/standard/fast), QR scan of `ethereum:` URIs, docs + demo screenshots.

**P5 — Release (1 d)**
`./deploy/deploy.sh` for web + `/eth` proxy env on each region; `deploy.apk.sh`
for Android; update `AGENTS.md` notes; `docs/ethereum.md` user guide in 12
languages (same pipeline as the P2P/prediction guides).

Total ≈ 12–16 working days for P0–P3 + release.

## 8. Testing

* **Unit (vitest, `sources/lib/eth/__tests__/`)** — address vectors
  (`0x…01` → `0x7E5F…5Bdf`, `0x4c0883…` → `0x2c75…5c23`), EIP-55 checksum
  accept/reject, RLP vectors, EIP-1559 signing against a known transaction
  (chainId 1 and 11155111), ERC-20 ABI encode/decode, EIP-681 parse/build,
  18-decimal formatting boundaries.
  *Also assert a PQ wallet cannot produce an address (throws, no 0x).*
* **Mock RPC (node)** — a tiny JSON-RPC stub like the P2P memory engine
  (`e2e/eth-stub.mjs`) returning fixed balances/fees/receipts, so the web e2e
  needs no provider and no funds.
* **Local chain e2e** — `anvil` (foundry) in the e2e harness: fund the EC test
  key, send ETH + USDT (a deployed mock ERC-20), assert balance change,
  receipt, notification; run as `e2e/playwright/tests/ethereum.spec.ts`.
* **Read-only mainnet smoke** — a public address balance check against the
  deployed `/eth` proxy (no keys, no funds).
* **Manual matrix** — Android/iOS/web; EC vs PQ wallet; mainnet/Sepolia/custom;
  offline/RPC-down; rapid double send (nonce guard); QR scan of an
  `ethereum:` URI.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Hand-rolled tx signing | Well-specified + vectors + anvil e2e; keep `tx.ts` tiny and pure; fall back to `viem`/`ethers` only if a second use case appears |
| Same key on two chains | Explicit UI notice; documented; optional future "derive a separate ETH key" mode |
| RPC provider outage/quota | 2–3 bases + failover; server-side key; own node later; read-only screens degrade with a clear error |
| Browsers/CORS | same-origin `/eth` proxy (already the `/l0` pattern) |
| RN/Metro compatibility | only libs already bundled (`secp256k1`, `@noble/hashes`); no node builtins; verify web export + Android build in P1 |
| Users with PQ wallets expect ETH | EC gate with the PQ explanation + P0 entry point |
| Gas mis-estimation / stuck tx | `eth_estimateGas` × 1.2, EIP-1559 with a max fee ceiling, "speed up" later; nonce guard |
| Address poisoning | EIP-55 validation + full-address confirm sheet |

## 10. Open decisions

1. **EC wallet creation UX** — add a "legacy EC" option to the create flow
   (one key, two chains) or an explicit "Ethereum wallet" section that creates
   an EC key alongside the PQ key?
2. **ERC-20 scope** — USDT-only in v1 (vmproject parity) or add-by-contract from
   day one (recommended: USDT + add-by-contract, both are cheap once ABI is in).
3. **Networks** — mainnet + Sepolia as planned, or mainnet only until the
   proxy/own node is settled.
4. **History** — local tracking only for v1 (recommended), or block on an
   explorer/indexer API before shipping.

---

**See also:** [`docs/assets-deposit-withdraw.md`](./assets-deposit-withdraw.md)
— the Binance-style Deposit / Withdraw surface for the other assets (network
picker, memo/tag, fees/minimums, deposit history, TRON and Bitcoin phases).

## 11. Implementation status (this release)

| Piece | Where |
|---|---|
| Key → address, EIP-55 checksum | `expo-app/sources/lib/eth/address.ts` (+ tests, verified vectors) |
| RLP + EIP-1559 signing (chain-id bound, low-S), signer recovery | `lib/eth/rlp.ts`, `lib/eth/tx.ts` (+ tests incl. `ecdsaRecover`) |
| ERC-20 ABI (balanceOf/decimals/symbol/transfer) | `lib/eth/abi.ts` (+ tests) |
| Amounts + EIP-681 URIs | `lib/eth/units.ts`, `lib/eth/eip681.ts` (+ tests) |
| Chain registry (mainnet, Sepolia, USDT/USDC) | `lib/eth/chains.ts` |
| JSON-RPC + per-device network/RPC settings + token list | `services/ethRpc.ts` |
| Balances, fees, nonce, send (native + ERC-20), receipts | `services/eth.ts` |
| Deposit/withdraw screen (EC gate, QR, fee, confirm, activity) | `expo-app/sources/app/ethereum.tsx` (sidebar → Ethereum) |
| Settings → Ethereum (network, RPC, wallet address) | `app/(tabs)/settings.tsx` |
| EC wallet create/import | `screens/wallet/WalletHelper.ts`, `screens/wallet/Keys.tsx` |
| `/eth` same-origin proxy (provider key server-side) | `deploy/region.sh` (`ETH_RPC_URL` / `deploy/env/.env.eth.<region>`) |
| e2e without a chain | `e2e/eth-rpc-mock.mjs`, `e2e/playwright/tests/ethereum.spec.ts` |
| Gas presets (slow/standard/fast) | `getFeeData(chain, preset)` + chips in the withdraw form |
| Deposit history (ERC-20) | `getIncomingTokenTransfers` — bounded `eth_getLogs` Transfer scan (last ~50k blocks) with a "Deposits" card; native-coin deposits still need a full block indexer |

Still to do: a native-deposit indexer (or an Etherscan-style history proxy),
ERC-20 logo/price metadata, TRON and Bitcoin phases, and a mainnet read-only
smoke run.
