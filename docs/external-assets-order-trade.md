# Plan — HKD, USD, Gold and ETH as tradable assets on `L1-order`

**Status: proposal.** No code yet beyond the external-asset framework in
[`external-assets.md`](./external-assets.md).

Goal: four assets that users can **deposit, withdraw and trade on the
`L1-order` book** — HKD, USD, gold and ETH — without adding a bridge to L0 and
without touching L0 deployment behaviour.

---

## 1. The decision that shapes everything

An order on `L1-order` escrows a **token UTXO on that chain** (`OrderOpenInfo`
carries `offerTokenid` / `targetTokenid` / `orderBaseToken`). So the real
question is not "how do we bridge Ethereum", it is:

> **What is each asset's representation on `L1-order`, and who mints it?**

`L1-order` can issue tokens itself: `OrderMatchL1Params` includes
`BLOCKTYPE_TOKEN_CREATION`, and `signToken` gates on
`getAllowedBlockTypes().contains(TOKEN_CREATION)`
(`BaseDispatcherController:584-590`). Production `Layer0Params` removed that
type, so **L0 cannot issue, L1 can**. That is the lever this plan uses.

**Four** representations follow, all on `L1-order`, none on L0. This is a
deliberate cap: four "fat" tokens, each our own liability, each with its own
reserve ledger.

| Asset | External source | On-`L1-order` representation | Who mints | Backing |
|---|---|---|---|---|
| **HKD** | HKD in a segregated bank account | `HKD-X`, native `TOKEN_CREATION`, 6 decimals | Us (issuer, M-of-N) | 1:1 HKD bank reserve + attestation |
| **USD** | USD in a segregated bank account | `USD-X`, native `TOKEN_CREATION`, 6 decimals | Us (issuer, M-of-N) | 1:1 USD bank reserve + attestation |
| **Gold** | Allocated gold at a vault/custodian | `GOLD`, native `TOKEN_CREATION`, 6 decimals | Us (issuer, M-of-N) | 1:1 allocated bars + audit |
| **ETH** | ETH on Ethereum | `ETH` (custodial), **issuer-credited**, 6 decimals | Us (custodian, M-of-N) | 1:1 custodied ETH + proof of reserves |
| *HKDAP, PAXG, USDC, …* | External token or bank rail | **no L1 token, not on the book** — deposit/convert rail only | Issuer/distributor | Corresponding external asset |

### 1.1 Tradable set vs deposit rails

The simplification is this split, not "one token per instrument":

- **Tradable set = the four tokens above.** Every market quotes against these,
  and nothing else is listed. Deep books, one decimals constant, one formatter,
  one set of long/price-ceiling tests.
- **Deposit rails = as many as we need.** A user can fund with bank HKD/USD,
  ETH, allocated gold, or later USDC/PAXG/HKDAP. The rail converts into the
  matching tradable token at the treasury layer. Nothing is wrapped, so a
  third-party freeze can never strand an L1 token.

This is the exchange model: one asset, many networks. It is what makes "add
USDC" a config row instead of a token, a listing, a market and an app release.

**No cross-backing.** HKD is backed by HKD, USD by USD, ETH by ETH, gold by
allocated bars. Backing HKD with USD or gold would create FX/market risk,
mismatched redemption expectations and likely a regulated activity. Four
independent 1:1 ledgers is the only defensible structure.

`HKDAP` deliberately stays un-wrapped, and this is a **decided** point (see
§9): it is not our asset, our `StablecoinPolicy` cannot control it, and a
wrapped copy would become unbacked the moment Anchorpoint freezes or
force-destroys our custody address (`ControllableAHKD`: blacklist, pause,
forced-destroy). Wrapping an institution-only token for a public order book
would also redistribute it against its distribution model. HKDAP therefore
remains the Track A distributor rail already implemented: deposit/withdraw,
transfer, mint/redeem requests — no L1 token, no pair. Trading it later, if
demanded, is a distributor-mediated RFQ/escrow flow (non-atomic with
timeout/refund), never an on-chain wrap.

## 2. Why not the bridge

`bigtangle-bridge` assumes the L1 is a bigtangle node (signed `LayerAnchor`,
`CROSSTANGLE` mints, `AnchorBurn` peg-out). Ethereum has none of that, so the
only "Ethereum as L1" option is an off-chain relayer signing roots L0 cannot
verify — `plan/hkd.md` §7.2 rates it *"Hard; separate project, not v1"*.

Instead, the external leg is **custodial/issuer-credited**, the same model the
wallet already uses for USDT deposits (`services/ethBridge.ts`). It is honest
about its trust: the issuer holds the external asset and the reserve ledger is
the source of truth. No L0 changes at all.

## 3. Asset specifications

Common: `tokenid` = the issuer public key (per `plan/hkd.md` §2.2),
`signnumber` = M-of-N threshold, `tokenstop=false` while minting is open,
metadata in `TokenKeyValues`.

### 3.1 HKD-X (`HKD`) and USD-X (`USD`) — the two fiat tokens

Identical shape, one reserve ledger each:

```text
tokentype   currency
decimals    6          (uniform across all four tokens — see below)
keyvalues   asset.class=stablecoin, asset.currency=<HKD|USD>,
            asset.jurisdiction=<HK|issuing entity>, asset.issuer=<licensed entity>,
            asset.decimals=6, asset.reserveAttestation=<latest>,
            asset.policyHash=<signed policy>
policy      StablecoinPolicy: mode=ALLOWLIST, paused=false,
            entries=<KYC'd addresses>, legalRefHash=<licence/terms>
```

Mint = reissuance (`tokenindex=n+1`) on confirmed bank credit; redeem = burn +
bank payout.

**Why uniform 6 decimals.** One constant for all four tokens means one
formatter, one set of price-ceiling tests, and no per-asset rounding bugs. The
`long` price ceiling is `9.22e18 / 10^(6+6)` ≈ 9.2M quote units per whole
token, which covers ETH (~30k) and gold (~600/g) with room to spare, and the
order-size ceiling is 9.2e12 units. Earlier drafts used 2 decimals for HKD;
uniform 6 is simpler and avoids confusing HKD-X with HKDAP's 6.

**Naming.** `USD` bare is the same hazard as `ETH` (§3.3): our token is a
liability of our entity, not USDC and not Tether. Display `USD · L1-order`,
never just `USD`, and disclose the issuer. `HKD` carries the same rule for
HKDAP — see §1.

**Reserve independence.** Each token has its own bank account and attestation.
No basket, no cross-collateralization (§1.1).

### 3.2 GOLD (`GOLD`) — our issuance, allocated backing

**Backing model: allocated, bankruptcy-remote.** Holders own *specific bars*
(serial numbers) held by a professional vault under a custody structure that
survives our insolvency — not a claim on our balance sheet. Unallocated gold
would make holders a general creditor and must never be described as allocated.
The chain stores only a hash of the bar list; the audit itself is off-chain and
must not be presented as on-chain verification.

```text
tokentype   token
decimals    6          (1 unit = 1 microgram of allocated gold)
keyvalues   asset.class=commodity, asset.underlying=GOLD, asset.form=allocated,
            asset.vault=<custodian>, asset.barList=<sha256 of latest bar list>,
            asset.audit=<auditor + date>, asset.jurisdiction=<vault/home>,
            asset.decimals=6
policy      StablecoinPolicy: mode=DENYLIST, pause on audit/insurance failure
```

- **Mint**: gold bought and allocated at the vault → custodian confirms the
  bars → issuer mints 1:1 to the L1 address; idempotent on `(receipt, bar set)`.
- **Redeem**: burn GOLD on L1 → vault delivers allocated bars or sells and wires
  fiat. Physical delivery needs a realistic minimum (e.g. 1 kg bar, or a 100 g
  small bar at a spread); below it, cash settlement. Minimum, fee and settlement
  window are ours to set.
- **Liquidity**: an order book with no quotes is a dead product — launch needs a
  treasury desk quoting GOLD/HKD around spot or a signed market maker. This is a
  business commitment, not code.

**Why our GOLD instead of a PAXG rail on the book.** The order book needs an L1
token, and PAXG is a Paxos-issued ERC-20 that can be frozen: using it means
either no on-book trading at all (custodian DvP, like HKDAP) or wrapping it —
which recreates the unbacked-supply problem. We would also give up the
redemption terms and the issuance economics while carrying custody risk for
free. PAXG's real advantage is external liquidity and a recognised brand, which
matters for credibility, not for order mechanics.

**Recommended synthesis:** GOLD is the on-book asset; PAXG is an optional
**deposit rail later** (user sends PAXG → we redeem with Paxos, allocate bars,
mint GOLD). That gives PAXG holders an on-ramp without wrapping a third-party
token and keeps a single HKD–gold order book.

### 3.3 ETH token (`ETH`) — custodial, not native

**Why a wrapped token at all.** `L1-order` has one native asset, `bc`
(`genesisMintsBIG=false`), so there is no chain-native ETH slot. Every ETH on
that chain is by construction a 1:1 claim on ETH held elsewhere, and an order
can only escrow an `L1-order` token UTXO (`offerTokenid`). A representation is
forced, not chosen.

**Naming decision: the token is called `ETH`.** That is a product choice, and it
puts the burden on the UI, because this is *not* native ETH and *not* Ethereum's
canonical contract-wrapped wETH. Hard rules that make the name safe:

1. Every surface shows the network badge: `ETH · Ethereum` vs `ETH · L1-order`
   — the same rule `lib/depositAssets.ts` already applies to one coin on two
   networks.
2. Withdraw/send rejects `0x` recipients for this asset (L1 uses base58).
3. Redemption is issuer-only (receive → release); no UI may imply a user-side
   unwrap.
4. Market and price labels use this token's name and its `L1-order` badge, never
   the underlying's.
5. Copy must say "custodial": the holder has a claim on the issuer, not a coin.
   `wrapModel: 'issuer-credit'` in the registry is the machine-readable marker.

```text
tokentype   token
decimals    6          ← see §4.2; 18 would cap an order at ~9.22 ETH
keyvalues   asset.class=wrapped, asset.underlying=ETH, asset.chain=ethereum,
            asset.custodian=<us>, asset.proofOfReserves=<latest>, asset.decimals=6
policy      StablecoinPolicy: mode=DENYLIST; pause freezes redemptions only
```

Deposit: the user signs a plain ETH transfer to an issuer-controlled Ethereum
address (shared, or HD-derived per user via the issuer API, as
`services/ethBridge.ts` does today). We never see their key. The issuer mints
`ETH` 1:1 on `L1-order` only after Ethereum **`finalized`** (~12.8 min), never
on confirmations, and idempotently on `(txHash, logIndex)`.

Withdraw: the user transfers the token to the issuer on L1 → wait L1 finality →
queue an ETH release from the hot wallet (batched), reconciled against the
Ethereum balance.

Custody controls required: hot/cold split, MPC or HSM for the cold key,
withdrawal approval policy, per-user and global mint caps, gas strategy, and a
`ETH token supply ≤ custodied ETH` reconciliation with a published attestation and
(ideally) the address set so users can verify the balance themselves.

**Self-custody ETH is a funding rail, not collateral.** Collateral on an order
book must be something the chain can hold and seize, and `L1-order` only sees
its own UTXOs. Keeping ETH on Ethereum and escrowing it for an L1 order needs a
relayer (a bridge again), an HTLC (pairwise only — no resting book or partial
fills) or platform-held key shares (custody with worse disclosure). Even with a
relayer, liquidation is not atomic: seizing on Ethereum needs a signer, gas and
legal process.

So the split is:

- **self-custody ETH** — user holds it, signs a transfer to the issuer when they
  want to trade. Unchanged from today, and explicitly **not tradable**.
- **`ETH` on `L1-order`** — the only tradable ETH representation.

The UI must say this, or users will assume the ETH in the self-custody screen is
tradable.

### 3.4 Other ERC-20 listings — same rail

The custodial rail is token-agnostic; USDT was already the first ERC-20 on it
(`services/ethBridge.ts`). ERC-20 is *easier* than native ETH for deposits:
`eth_getLogs` on `Transfer` replaces the address-index scan, and idempotency is
`(txHash, logIndex)` instead of `(txHash)`.

One issuer config row per listing, one L1 token per listing:

```text
{ assetId, chainId, contract, symbol, underlyingDecimals,
  l1Decimals: 6, mintCap, minDeposit, custodyAddress, enabled }
```

**Decimals rule.** `maxPrice = 9.22e18 / 10^(l1Decimals + 6)` (the `long`
ceiling, §4.2). Default `l1Decimals = 6` → ~9.2M quote units per whole token,
which covers WBTC (~600k HKD) but **not** an 8-decimal BTC at that price. Raise
to 8 only for low-priced assets that need sub-1e-6 precision. Converting 18 → 6
leaves dust: the reserve ledger must track it and the redemption math must
disclose the rounding.

**Reject at intake:**

| Pattern | Why |
|---|---|
| fee-on-transfer | Received delta < `Transfer` value; 1:1 mint breaks |
| rebasing (stETH, AMPL) | Balance moves without transfers; supply invariant dies |
| hooks / ERC-777 | Reentrancy and callbacks in the custody path |
| undisclosed arbitrary mint / upgrade | "Reserve" can be inflated by the issuer |

Pausable/blacklistable tokens (USDC, USDT) are acceptable **only with
disclosure** — a freeze at the underlying layer strands the L1 token, the same
failure mode as wrapping HKDAP.

**Identity is `(chainId, contract)`, never the symbol.** Pin contracts in the
issuer config with a human-verified provenance record, for the same reason
HKDAP ships no bundled address: fake USDT/DAI contracts are everywhere.

**Custody concentration.** Per-asset custody addresses, per-asset mint caps and
cold storage for the bulk — one hot wallet holding N assets is one key from
losing all of them.

**Sequencing.** Tier 1: USDC (6 decimals, no dust, deep liquidity), then WBTC at
6. Tier 2: DAI and peers, exercising the dust policy. Tier 3: the long tail,
only if listing is genuinely automated.

**Three states that must not blur:**

| State | Meaning |
|---|---|
| Displayed | User-local via `addEthToken`; no issuer involvement |
| Listed | In the issuer config; deposit/withdraw and reserve ledger |
| Tradable | Has an L1 token and a market pair |

Every listing is also a business decision (compliance, market maker, quote
pair), not a config change.

## 4. Order-trading constraints (verify these first)

### 4.1 Pair model

`OrderOpenInfo` is keyed by `orderBaseToken`; `NetworkParameters.getOrderPriceShift`
returns **0 for `bc`** and **6 for every other base token**. So any new base
token already works without a core change.

Planned markets — **six at launch**, because depth beats breadth:

| Pair | Base (quote) | Offer |
|---|---|---|
| ETH/HKD | HKD-X | ETH |
| ETH/USD | USD-X | ETH |
| GOLD/HKD | HKD-X | GOLD |
| GOLD/USD | USD-X | GOLD |
| HKD/USD | USD-X | HKD-X |
| ETH/BC, GOLD/BC, HKD/BC | `bc` | respective token |

HKD/USD is an FX market, not a workaround: it lets a user move between the two
quote currencies without leaving the chain, and it is the pair regulators will
look at first.

Legacy `USDT` and `CNY` quotes keep working untouched; they are not extended to
new listings.

### 4.2 The `long` ceiling — this dictates decimals

`offerValue`, `targetValue` and `price` are **signed 64-bit**
(`OrderOpenInfo`). Two ceilings:

- **Order size** = `9.22e18 / 10^decimals`. At 18 decimals that is **9.22 ETH
  per order** — unusable. At 6 decimals it is 9.2 million ETH. Hence all four
  tokens at **6** (§3.1).
- **Price** = `9.22e18 / 10^(offerDecimals + priceShift)`. At 6+6 = 12 the
  ceiling is ~9.2 million quote units per token — comfortable for HKD quotes.

Acceptance: a unit test with boundary vectors per pair (max amount, max price,
overflow rejection) in both the wallet and a Java L1 test. Enforce caps in the
wallet and issuer service — **do not** edit `ServiceBaseOrder`, which L0 reward
generation also uses.

### 4.3 Fees — creation and policy both need BIG

L1 *payments* are fee-free (`lib/txFee.ts`: `payOnLayer1` sets `setFee(false)`),
but issuer operations are not:

- **Token creation** pays `Coin.FEE_DEFAULT`. `AbstractIntegrationTest.saveTokenUnitTest`
  calls `payBigTo(outKey, Coin.FEE_DEFAULT)` before every creation, and the
  wallet's prediction flow waits on `waitForFeeOutput` for the same reason.
- **`StablecoinPolicy`** pays the fee in the same transaction
  (`Wallet.createStablecoinPolicyTransaction` filters BIG outputs explicitly).

Since an `L1-order` genesis mints no BIG (`genesisMintsBIG=false`), the issuer
wallet must first be funded by a **vault peg-in** (the existing L0→L1 rail).
That is an operational prerequisite, not a code change, and
`helper/prod/asset-issue.sh preflight` blocks until a spendable BIG output
exists.

## 5. Workstreams

### A. Chain (L1 only) — `../blockchain`

1. Issuer tool: **done** — `helper/prod/assets/AssetIssueTool.java` +
   `helper/prod/asset-issue.sh` (create / sign / policy / show / preflight).
2. Publish the initial `StablecoinPolicy` block per asset.
3. Java test: create → sell → buy → match for `GOLD/HKD` and `ETH/HKD`,
   asserting payouts and the price-shift vectors.
4. **No changes to L0, `bigtangle-bridge`, or `ServiceBaseOrder`.**

### B. Issuer service — new `../wallet/services/asset-issuer`

Implements exactly the contract already declared in
`expo-app/sources/services/distributor.ts` (`/balances`, `/statement`,
`/transfers`, `/mint-requests`, `/redeem-requests`), so the wallet needs no new
transport.

- **Deposit watchers**: Ethereum (`/ethindex` + `getIncomingDeposits`, wait for
  `finalized`); bank/reserve confirmations for HKD and gold (manual or API).
- **Mint**: reissuance signed by the M-of-N issuance keys, idempotent on
  `(chain, txHash, logIndex)`.
- **Redeem**: detect the L1 burn, release the external leg, same idempotency.
- **Reserve ledger**: invariant `L1 supply ≤ external reserve`, reconciled per
  asset; expose the attestation hash for `asset.reserveAttestation`.
- **Reorg safety**: no mint before Ethereum finality; no release before L1
  finality.

### C. Wallet — `../wallet/expo-app`

1. Extend `ExternalAsset` with an `orderTrading` block (`enabled`, `l1TokenId`,
   `decimals`, `defaultQuote`, `wrapModel`) and add `HKD`, `USD`, `GOLD`, `ETH`
   entries; keep `HKDAP` (and every future external instrument) as
   `orderTrading.enabled=false` — it is a deposit rail, not a tradable asset.
2. `QUOTE_SYMBOLS` in `app/trade.tsx` gains `HKD`, `USD`, `GOLD`, `ETH` —
   discovery already tolerates a missing token, so this is safe before issuance.
3. `lib/depositAssets.ts`: add HKD/USD (bank rails) and gold (vault rail)
   networks; ETH already exists. These are rails, not listings.
4. Deposit/withdraw: route the ETH token through the issuer credit flow;
   HKD/USD/gold through the bank/vault instructions with reference codes.
5. Market surfacing: one `lib/markets.ts` registry (pair, base, tick size,
   max order, display decimals) consumed by `trade.tsx` and `TokenOrderScreen`.
   Six launch pairs (§4.1), not a cartesian product.
6. Clarify custody in the UI: self-custody ETH ≠ the tradable ETH token, and
   every fiat/gold surface shows the `L1-order` network badge.
7. i18n in all 12 locales (the `i18n.test.ts` parity guard enforces it).

### D. Compliance / legal (parallel, gating)

- HKD issuance licence position, reserve attestation cadence, allowlist/KYC,
  travel rule; **never brand HKD-X as HKDAP**.
- USD: the most regulated of the four (e-money / stablecoin regime, possibly
  two jurisdictions). Do not ship it under a bare `USD` ticker; disclose the
  issuer and the reserve account.
- Gold: custody agreement (allocated, bankruptcy-remote), bar-list audit,
  redemption desk and minimums, insurance coverage, commodity/securities
  classification per jurisdiction.
- ETH token: custody + proof of reserves, disclose that it is **not trustless**.
- Sanctions screening and freeze procedure wired to `StablecoinPolicy` entries.

## 6. Phases

| Phase | Deliverable | Estimate |
|---|---|---|
| P0 | Decision freeze: decimals, issuers, custody, quote hierarchy; key ceremony design | 2–3 d |
| P1 | L1 token creation + policy + Java match tests | 3–5 d |
| P2 | Issuer service (watchers, mint/redeem, reserve ledger) | 8–12 d |
| P3 | Wallet registry, markets, deposit/withdraw screens, i18n | 5–8 d |
| P4 | Testnet soak: deposit → trade → withdraw, reorg drills, invariant checks | 5 d |
| P5 | Legal sign-off + attested launch per asset | gated |

Roughly **5–7 weeks** for P0–P4 with two engineers; each asset launches only
after its legal gate.

## 7. Testing

- **Unit**: decimal/price vectors per pair, `long` boundaries, registry
  `orderTrading` validation.
- **Java L1**: token creation, order open/cancel/match per pair, price-shift
  and payout arithmetic.
- **Issuer**: deposit→mint idempotency, double-credit, replay, Ethereum
  reorg-before-finality, L1 reorg-before-finality, supply invariant fuzz.
- **e2e**: deposit HKD/gold/ETH → place sell and buy → match → withdraw;
  RPC/issuer-down degradation.
- **Existing guards**: `npx tsc --noEmit`, `vitest run sources`, i18n parity.

## 8. Risks

| Risk | Mitigation |
|---|---|
| `long` overflow on price/amount | Fixed decimals (2/6/6), documented ceilings, client + issuer caps, boundary tests |
| Custodial ETH token is not trustless | Explicit UI wording, proof of reserves + published addresses, HSM/MPC, segregated wallets, no rehypothecation, mint caps |
| Issuer key compromise | M-of-N issuance, vault-free L1 keys, freeze via `StablecoinPolicy` |
| Reserve/supply drift | Ledger invariant + attestation hash on chain, alerting |
| Gold/HKD legal classification | Legal gate before launch; no marketing until cleared |
| Empty GOLD book at launch | Treasury desk quoting around spot or a signed market maker; seed inventory before P4 |
| Allocated-gold custody gap (insurance limit, bar loss) | Bankruptcy-remote structure, insured custody, bar-list audit, pause on any discrepancy |
| Mixing HKD-X and HKDAP in copy | Separate registry ids, separate screens, review checklist |

## 9. Open decisions

1. ~~HKD: native `HKD-X` only, or also a custodial wrap of HKDAP?~~ **Decided:
   `HKD-X` only. No `wHKDAP`. HKDAP stays `orderTrading.enabled=false` and is
   traded, if ever, through a distributor RFQ/escrow flow.**
2. ~~Gold: our GOLD vs a PAXG distributor rail for the external leg?~~ **Decided:
   our GOLD with allocated, bankruptcy-remote backing. PAXG is at most a later
   deposit rail (PAXG → redeem → allocate → mint GOLD), never an on-book
   representation.**
3. ~~ETH: custodial `wETH` only for trading, or also accept self-custody ETH as
   order collateral?~~ **Decided: custodial `ETH` is the only tradable
   representation. Self-custody ETH stays a funding rail (sign a transfer to the
   issuer), never collateral — keeping it on Ethereum would require a relayer,
   an HTLC or key-share custody, and non-atomic liquidation.**
4. ~~Decimals 2 / 6 / 6~~ **Decided: uniform 6** across HKD-X, USD-X, GOLD and
   the ETH token — one constant, one formatter, one price-ceiling test.
5. Primary quote: HKD or `bc` for the first markets? *(Recommend: HKD for gold
   and ETH, `bc` kept for BIG pairs.)*
6. ~~L1 ticker for custodial ETH~~ **Decided: `ETH`**, with the network badge,
   `0x`-recipient rejection and issuer-only redemption that make the name safe
   (§3.3).
7. Listing source for ERC-20s: bundled registry (an app release per asset) vs an
   issuer-published `GET /assets` merged over the bundled allowlist. Server-
   driven is the only workable option for a long tail, but the client must still
   validate ids/decimals and keep compliance flags bundled.

---

**See also:** [`external-assets-operations.md`](./external-assets-operations.md)
(runbook: bring-up, issuance, custody, go-live gates, day-2),
[`external-assets-backlog.md`](./external-assets-backlog.md) (what is left to
build, with sizes), [`external-assets.md`](./external-assets.md) (implemented
distributor rail), [`ethereum.md`](./ethereum.md) (self-custody ETH),
[`assets-deposit-withdraw.md`](./assets-deposit-withdraw.md),
`../blockchain/plan/hkd.md` (Track A/B/C), `../blockchain/layers.md` §5 (bridge).
