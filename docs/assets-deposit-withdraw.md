# Multi-asset deposit / withdraw (Binance-style) — plan

**Status: the EVM slice (incl. the USDT deposit page) is implemented** (Ethereum mainnet/Sepolia: ETH, USDT,
USDC deposit + withdraw, network picker, fee/minimum display, EC-only gate, e2e
with a mock RPC). TRON and Bitcoin remain at plan stage. This is the follow-up to [`docs/ethereum.md`](./ethereum.md):
that document brings **ETH + ERC-20** into the wallet for legacy EC keys; this
one turns it into a **Binance-style Deposit / Withdraw surface for the other
assets** (BTC, USDT on several networks, BSC/Polygon tokens, …), with the same
safety rules Binance uses.

The wallet is **self-custodial**, so "deposit" and "withdraw" mean:

* **Deposit** = show *our own* address/QR/memo for the chosen coin **and
  network**, and watch the chain until the incoming transfer is credited.
* **Withdraw** = build, sign (on device), broadcast and track a transfer to an
  external address on the chosen network.

No custodian, no KYC, no exchange account, no admin keys.

## 1. What Binance does (the UX we copy)

From Binance's own guides (`How to Deposit Crypto`, `How to Withdraw Crypto`,
`Crypto Deposit & Withdrawal Fees`):

**Deposit**

1. Wallet → Deposit → Deposit Crypto → **pick coin**.
2. **Pick network** (e.g. USDT: ERC20 / BEP20 / TRC20; BTC: BTC / SegWit bech32;
   BNB: BEP2 / BEP20) with the warning *"the network must match the platform you
   are withdrawing from — a wrong network can lose the funds"*.
3. Shows **address + QR**, plus a **Memo/Tag** where the chain needs one
   (BNB-BEP2, XEM, XLM, XRP, KAVA, ATOM, BAND, EOS, …).
4. **Save/share address**, choose destination wallet (Spot/Funding).
5. Credit after N confirmations; the history shows pending → completed.

**Withdraw**

1. Wallet → Withdraw → **pick coin**.
2. Paste the address → the **network is auto-selected** from the address format;
   the UI asks you to confirm the target supports that network.
3. Amount with a **"Receive amount" vs "Withdrawal amount"** toggle; the screen
   shows the **network fee**, the final receive amount and the **minimum
   withdrawal**.
4. **Memo/Tag** field where required.
5. Review (coin, address, network, amount, fee) → confirm.
6. Status: pending → processing → completed / failed, with a history list.

**Fee page** (`binance.com/en/fee/cryptoFee`): per coin **and network** —
minimum deposit, minimum withdrawal, deposit fee (usually 0), withdrawal fee
(fixed per network).

Not copied: custody, KYC, exchange accounts, internal transfers, fiat ramps
(the wallet already has the CNY P2P rail and PayPal rail for fiat).

## 2. What `../vmproject` does (and why we do not copy it)

| vmproject artifact | What it really is |
|---|---|
| `shop/deposit.xhtml` + `DepositAction` | **fiat** (PayPal) shop credit, not a crypto deposit |
| `UserBinanceAction` / `UserHuobiAction` (`payBinance`, `checkBinanceWithdraw`) | **exchange-mediated** withdrawal: the platform's admin API key asks Binance/Huobi to pay the user, then polls the withdraw id — custodial, needs exchange secrets |
| `EthBalanceAction` | read-only ETH + USDT balance; also BTC via a BlockCypher HTTP call |
| `EthPublicBalanceAction` | public balance by address / EC public key |

So vmproject has **no self-custody deposit/withdraw** for other assets. We take
Binance's UX + safety rules, and implement the chain interaction ourselves
(starting from the Ethereum plan).

## 3. Model

* **Asset** = `{ coin, network }` — `USDT@ERC20`, `USDT@TRC20`, `USDT@BEP20`,
  `ETH@Ethereum`, `BTC@Bitcoin`, `BIG@Bigtangle-L0`, `<token>@L1-<chain>`.
  The same coin on two networks is **two different assets** with two different
  addresses and balances (exactly what Binance's network picker means).
* **Account** = the address derived for that network from the wallet's key
  material.
* **Deposit** = account + memo/tag + QR + incoming-transfer watcher.
* **Withdraw** = transfer builder + fee/min + sign + broadcast + tracker.

## 4. Chain support and phases

| Family | Chains | Key derivation | Signer | Deposit detection | Phase |
|---|---|---|---|---|---|
| **EVM** | Ethereum, BSC, Polygon, Base, Arbitrum, Optimism (+ Sepolia, Amoy) | **same EC secret** (ETH plan / vmproject parity) | secp256k1 + RLP/EIP-1559 (`lib/eth`) | `eth_getLogs` + indexer | **1** |
| **TRON** | TRC-20 (USDT) | **same EC secret** — TRON address = `0x41‖keccak(pub)[12..]` base58check | protobuf tx + secp256k1 | TronGrid | **2** |
| **Bitcoin** | BTC (P2PKH / P2SH-P2WPKH / bech32) | BIP32/44/49 **from** the EC secret (documented path) | UTXO + PSBT, fee sat/vB | Esplora | **3** |
| Others | SOL, ADA, XRP, ATOM, EOS, … | **different key types** (ed25519, …) → new key material | per chain | per chain | not scheduled |

Why this order:

* **EVM first** — one signer covers Ethereum and every EVM chain; only
  `chainId`, RPC, explorer and token list change. It is 100 % the work already
  planned in `docs/ethereum.md`.
* **TRON second** — the same secp256k1 key derives a TRON address, and TRC-20
  USDT is the second most used rail in the wallet's markets.
* **Bitcoin third** — needs UTXO selection, change, dust and fee-rate logic
  (a new subsystem, not a new chainId).
* **Everything else** needs new key types; that is a separate product decision
  (a second seed/key in the wallet), so it is explicitly out of v1.

## 5. Keys and addresses per network

| Network | Derivation | Address display |
|---|---|---|
| Bigtangle L0/L1 | unchanged (PQ or EC) | base58 |
| EVM (all) | the **EC 32-byte secret directly** | `0x…`, EIP-55 checksum |
| TRON | the same EC secret → `0x41+keccak(pub)[12..]` | base58 `T…`, base58check validated |
| Bitcoin | BIP44 `m/44'/0'/0'/0/0` (or BIP49 for P2SH-P2WPKH) from the EC secret, path shown in the UI | `1…`/`3…`/`bc1…`, base58check/bech32 validated |

The Keys screen gains a **"Networks"** panel listing every derived address with
copy/share and the derivation path, so a user can always find where an asset
went. PQ wallets see the same panel with "Ethereum/TRON/Bitcoin need a legacy
EC key" (see `docs/ethereum.md` §2).

**Compatibility trade-off to decide in P3:** using the EC key *directly* for
Bitcoin (WIF) keeps one key for all chains (vmproject-style) but is non-HD; the
BIP44 derivation is the ecosystem norm but a different address. Recommendation:
BIP44 for BTC, direct key for EVM/TRON.

## 6. Screens and flows

### 6.1 Assets (new screen, entry from the home portfolio + sidebar)

* searchable list grouped by coin; each row: coin icon, **network badge**,
  balance, and `Deposit | Withdraw` actions.
* Bigtangle rows keep the existing Send/Receive (folded in as `BIG`,
  `USDT@L1-order`, …).
* empty state explains that an asset needs a network.

### 6.2 Deposit

1. pick coin → **network list** with `min deposit`, `confirmations`, `fee`
   (from the registry, §7).
2. address card: **QR** (chain URI: EIP-681 `ethereum:`, `tron:`, BIP21
   `bitcoin:`), address with copy/share, and a **Memo/Tag** row (copy) when the
   network requires one.
3. inline warnings: *"Send only <coin> on <network>"*, *"wrong network = funds
   lost"*, *"a memo/tag is required"*.
4. expected credit time (`N confirmations`).
5. **deposit history**: incoming transfers detected by the indexer with
   `pending → confirming → completed`, plus a notification on credit (reuse the
   `IncomingPaymentWatcher` pattern already used for L0).

### 6.3 Withdraw

1. pick coin → network (auto-selected from the pasted address when the format is
   recognized; switching is allowed but shows a hard warning).
2. address field: format + checksum validation, and a **block** when the format
   clearly belongs to another supported network (a `bc1…` value in an EVM field
   cannot be sent).
3. amount with a **`Withdraw amount` / `Receive amount`** toggle, available
   balance, **network fee**, **minimum withdrawal**, total debit and remaining
   balance.
4. **Memo/Tag** field when the network requires it (required, validated).
5. review sheet with the **full** address, network, amount, fee and receive
   amount → confirm (reuse `TransactionConfirm`; auto-approved under
   `E2E_AUTOCONFIRM`).
6. sign on device → broadcast → tracking record → status + explorer link.

## 7. Fees, minimums and limits

| Family | Fee model | Estimation |
|---|---|---|
| EVM | gas × maxFee, paid in the chain's native coin (ETH/BNB/MATIC…) | `eth_estimateGas` × 1.2 + `eth_feeHistory` (ETH plan §6) |
| TRON | bandwidth/energy; burns TRX when resources run out | `triggerconstantcontract` + `getaccountresource` |
| Bitcoin | fee rate (sat/vB) × vsize, change policy, dust limit | mempool fee estimate; RBF optional |

A small **registry** (server-side JSON, cached, overridable) holds per
asset+network: `minDeposit`, `minWithdraw`, `withdrawFee` (only where we cannot
estimate), `confirmations`, `memoRequired`, `explorer`. Deposit fee is always 0
(we are not an exchange). Max-per-tx safety caps are enforced client-side.

## 8. Safety rules (where users actually lose money)

1. **Network match** is the primary rule: format auto-detection, an explicit
   network badge on every address, and a hard block on clearly-mismatched
   formats.
2. **Memo/Tag**: required flag per network, blank is rejected, the deposit card
   shows it next to the address with its own copy button.
3. **Checksums**: EIP-55 (EVM), base58check (TRON/BTC), bech32 (BTC).
4. **Full address in the confirm sheet**; lists show `0x1234…abcd` only.
5. **First-time address** warning (differs from everything in the history) —
   address-poisoning protection.
6. **One in-flight send per account**: pending tx / UTXO lock blocks a second
   send until resolved (vmproject's "serialize payments, reject duplicate
   resubmit" lesson).
7. **QR scan** parses chain URIs and prefills coin + network + address + amount;
   a URI whose network does not match the coin is rejected.

## 9. Deposit detection and history

| Family | Source |
|---|---|
| EVM | `eth_getLogs` for ERC-20 `Transfer` topics + native transfers via an indexer (Etherscan-compatible or our own); receipt for confirmations |
| TRON | TronGrid `/v1/accounts/<addr>/transactions/trc20` |
| Bitcoin | Esplora `/address/<addr>/txs` |
| Bigtangle | existing `IncomingPaymentWatcher` (already shipped for L0) |

The wallet polls our own **`/index/<chain>/address/<addr>`** proxy, never a
third-party indexer directly (CORS, keys, rate limits), and reuses the
notification pipeline for "deposit credited".

## 10. Backend / deploy

Same shape as the existing routes (`/l0`, `/l1`, `/p2p`), all server-side:

```
/eth, /bsc, /polygon, …     JSON-RPC proxies (method allowlist)
/tron                       TronGrid proxy
/btc                        Esplora proxy
/index/<chain>/address/…    normalized history (per provider)
```

* Credentials in `deploy/env/.env.chain.<region>` (never in the bundle).
* `deploy/region.sh` + `region.conf`: add the routes and env; per-IP rate limits
  in Caddy; optional `services/chain-indexer` if third-party indexers are not
  wanted.
* Testnets: Sepolia + Amoy (EVM), Nile (TRON), testnet BTC via Esplora.

## 11. i18n and tests

* All new strings in the 12 locales (deposit/withdraw/network/memo/min/fee/
  confirmations/statuses/warnings), same guard test as today.
* Unit: address format + checksum validation, network auto-detection and
  mismatch blocking, fee/min math per family, memo requirement, asset registry.
* e2e: EVM on `anvil`, TRON against a mock TronGrid, BTC against a mock Esplora;
  a web run with the mock RPC/indexer needs no provider and no funds.
* Read-only mainnet smoke for balances and the indexer proxy.

## 12. Phases (on top of `docs/ethereum.md`)

| Phase | Content | Estimate |
|---|---|---|
| **P1** | Assets screen + deposit/withdraw sheets + EVM assets (ETH, USDT/USDC on Ethereum; BSC/Amoy in the same signer) + fee/min registry + deposit history + `/eth`, `/bsc` proxies | 5–7 d after the ETH plan lands |
| **P2** | TRON: address derivation, signer, TronGrid proxy, TRC-20 USDT deposit/withdraw | 4–6 d |
| **P3** | Bitcoin: BIP44 derivation, UTXO/PSBT signer, fee/dust/change, Esplora proxy, deposit history | 6–10 d |
| **P4** | Other key types (SOL/ADA/XRP…) — separate decision, not scheduled | — |

## 13. Open decisions

1. **Asset set for P1** — ETH + USDT only, or ETH/USDT/USDC + BSC from day one?
   (Recommendation: ETH + USDT/USDC on Ethereum and BSC, since the EVM signer is
   the same code.)
2. **Exchange integration** — do we want vmproject's Binance/Huobi API flow at
   all (user API keys, admin withdrawal), or strictly self-custody? (
   Recommendation: self-custody only; exchange keys in a wallet are a large
   security surface.)
3. **Fee/min registry** — static in-repo JSON (recommended, refreshed per
   release) or fetched from our proxy.
4. **BTC derivation** — BIP44 (recommended) vs reusing the EC key as a legacy
   WIF (vmproject compatibility).

## 14. Implemented: exchange-style USDT deposit (`/deposit`)

Sidebar → TRADE → **Deposit** (below Portfolio), matching the exchange flow
**Select Asset → Select Network → Deposit Address**:

1. Asset list (`lib/depositAssets.ts`, badge + symbol; USDT today, more rows are
   data-only additions) and a `Deposit | Withdraw` tab shell — Withdraw routes to
   `/ethereum`, and the fiat entry links to the P2P rails.
2. Network picker (`Ethereum (ERC-20)`), showing where the credit lands (the
   L1-order USDT token).
3. Address step: QR (EIP-681), checksummed address, memo/tag when the issuer
   returns one, the "send only X on network Y" warning, minimum, the L1 credit
   address and its USDT balance, plus deposit history.
4. Optional **Pay from this wallet**: signs an ERC-20 `transfer` to the issuer
   address on Ethereum (same signer as `/ethereum`) and adds a pending row.

Issuer side (contract in `services/ethBridge.ts`):

```
GET <api>/deposit-address?account=<l1 address>  -> { address, memo? }
GET <api>/deposits?account=<l1 address>         -> { items: [{ hash, amount, status }] }
```

With no API, a single static issuer address is used (vmproject's
`BinanceETHPayADDRESS` model: track deposits by balance delta). The issuer
credits the **same token** (USDT created on the L1 order chain) to the user's L1
address; the app cannot do that leg (it would need the issuer's L1 key).
Configured in Settings → Ethereum (`issuerAddress`, `apiUrl`, `minUsdt`).

## 15. Implemented: exchange-style withdraw (`/withdraw`)

Sidebar → TRADE → **Withdraw** (below Deposit), the counterpart of the deposit
page and the destination of its `Withdraw` tab:

1. **Select Asset** — ETH + the chain's ERC-20 tokens (USDT/USDC + user-added),
   with balances and badges.
2. **Select Network** — the configured EVM network (Ethereum / Sepolia).
3. **Form** — recipient (EIP-55 checked), amount, available balance,
   Slow/Standard/Fast gas presets, the live fee estimate (for native coins the
   **total debit = amount + max fee**; for tokens the fee is paid in the native
   coin), the confirm sheet, then on-device signing and broadcast. History rows
   go pending → confirmed/failed with a notification and an explorer link.
   Sending to the wallet's own address is rejected with a translated message.
