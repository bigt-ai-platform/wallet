# Predict — Kalshi/Polymarket-style Prediction Market on Bigtangle

Status: proposed
Date: 2026-10-10

Binary event markets ("Will X happen by date D?") with YES/NO outcome shares
priced 0–1 (displayed 0–100¢), full collateral backing (1 winning share
redeems for exactly 1 collateral unit), traded on the order books of a
**new dedicated L1 chain, `l1-prediction`** (derived from `l1-order-server`).
Resolved by a 2-of-3 committee with a permissionless dispute window (v1
oracle). Binary events only; multi-outcome and staked oracles are post-MVP.

## Landscape: Predict vs Kalshi vs Polymarket (as of 2026-10)

| Dimension | Kalshi | Polymarket | **Predict (this plan)** |
|---|---|---|---|
| Legal model | CFTC-designated derivatives exchange (DCM); fighting state regulators (the article: AZ criminal charges, NV/NJ vs MD court split) | Offshore for years (blocked US persons); re-entering US via licensed acquisition (2025); sports via UMA-resolved markets | Unlicensed greenfield; **testnet-only MVP**; compliance out of scope (§8); dedicated chain keeps the compliance door open |
| Matching | Centralized matching engine (operator-run) | Off-chain CLOB (operator-run) + on-chain settlement | **Fully on-chain** deterministic order books — no operator discretion over fills |
| Custody | Customer USD held by the clearinghouse (segregated, regulated) | USDC locked in Polygon smart contracts (non-custodial) | **Non-custodial on-chain vault** on our own L1; conservation asserted by every node |
| Collateral | USD ($1 = 1 share) | USDC on Polygon | BIG or USD-pegged currency token, per-event; pegged in from L0 via bridge |
| Token model | Shares at an exchange (no transferable token) | CTF conditional tokens (ERC-1155-style) + split/merge | Native chain tokens YES/NO + **CTF-style split/merge** (decision 2) — the math is ported, the plumbing is native |
| Oracle / resolution | The exchange itself resolves; legal liability is the bond (regulated clearinghouse as trusted oracle) | UMA optimistic oracle: propose with bond → challenge → token-holder vote; liar slashed | v1: 2-of-3 resolver committee + permissionless bonded disputes + liveness rules (§3.3); **phase 4: UMA-style staked oracle** |
| Chain / infra | Off-chain (with crypto-settlement pilots) | Polygon PoS (external L1) | Dedicated bigtangle L1 (`prediction`) anchored to L0; inherits bigtangle PoS security (young validator set) |
| Market making | Designated market makers at the central book | Open — anyone provides CLOB liquidity | Open — anyone can split/merge and place orders |
| App / access | Kalshi app, KYC, geo-fenced | Web app, wallet connect (MetaMask etc.) | Integrated Expo wallet app; native chain — no web3 wallet glue |

**What we deliberately borrow:** Kalshi's event UX (¢ prices, categories,
resolution deadlines) and its *lite* version of the clearinghouse-resolver
role (our 2-of-3 committee); Polymarket's CTF split/merge mathematics and
its UMA-style oracle roadmap (our phase 4).

**Where we actually differ:** we combine Polymarket-grade non-custody with
*on-chain* matching (both incumbents match off-chain — Kalshi is fully
custodial, Polymarket's CLOB is operator-run), and we get regulatory
isolation via a dedicated chain instead of fighting regulators from inside
a shared venue.

**Honest weaknesses vs both:** no established liquidity or brand, no legal
wrapper, a young validator set, and resolution trust that is only
committee-grade until phase 4. Anonymity/kyc posture: chain-level
pseudonymity by default — the opposite of Kalshi's KYC-everything, and a
compliance liability if real money is ever at stake (§8).

## 1. Current state (verified 2026-10-10)

- **No prediction-market code exists** in `wallet` or `../blockchain`
  (no Kalshi/CTF/outcome/conditional primitives anywhere;
  `RemoteBinaryTests` is only a block-serialization round-trip).
- **Primitives to build on:**
  - L1 order-match chain (`l1-order-server`): limit order books
    (`bigtangle-servercore/.../OrderBook.java`), 8h order escrow with virtual
    payout txs (`ServiceBaseOrder`), token creation
    (`OrderMatchL1Params.java` allows `BLOCKTYPE_TOKEN_CREATION` — but **no
    contract-event blocks yet**).
  - Contract-event system: `BLOCKTYPE_CONTRACT_EVENT` /
    `BLOCKTYPE_CONTRACTEVENT_CANCEL` (currently only on `l1-contract-server`),
    `ContractExecutorRegistry` (classname-dispatched executors registered at
    startup), `ContractEngine` with the lottery contract as the template
    (`ContractEngine.java` dispatches on the contract token's tokenKeyValues
    `classname`, `// TODO run others`).
  - Expo app: `expo-app/sources/app/(tabs)/trade.tsx` already renders chart +
    order book + buy/sell for **any token pair** — event-detail screens can
    reuse it wholesale.
  - TS client already has unused `Wallet.payContract` /
    `Wallet.contractEventCancel` / `searchContractTokens`.

## 2. Key decisions

1. **Dedicated `l1-prediction` chain, derived from `l1-order-server`**
   (decision: 2026-10-10, revised from "patch ordermatch").
   New module `l1-prediction-server` (chainId `prediction`): copy
   `l1-order-server` (20 main-source files), params = order-match params
   **plus** `BLOCKTYPE_CONTRACT_EVENT` + `BLOCKTYPE_CONTRACTEVENT_CANCEL`
   (so token creation, order books, and contract events all live on one
   chain), and register a `PredictionContractExecutor` via the existing
   `ContractExecutorRegistry` pattern (servercore looks executors up at
   BEACON confirmation; no compile-time dependency).
   Rationale: (a) **regulatory isolation** — this is the one feature facing
   cease-and-desists and criminal charges (Arizona); a separate chain gives
   separate validators and the ability to geo-block/offline *just this
   venue* without touching general trading; (b) **ordermatch stays
   untouched** — zero regression risk to the battle-tested spot trading
   chain; (c) the liquidity objection is moot — prediction markets are a
   distinct venue (¢ prices, resolution dates), which is why Kalshi and
   Polymarket are separate venues from stock exchanges; all prediction
   liquidity lives on the one prediction chain anyway; (d) repo-idiomatic
   — 7 purpose-built L1s already exist.
   Costs accepted: bridge/peg-in UX (no bridge UI exists yet — §6), extra
   infra (own DB, validator, Kafka chain topic in
   `helper/fulltest/remote.sh` `KAFKA_CHAINS`), a second L1 URL in the app.
   Rejected alternatives: patching ordermatch (regulatory coupling, params
   churn on a live chain); `l1-contract` (has contract events but no token
   creation and no order books); `l1-social` (payments chain, no token
   creation, no books); full-EVM CTF port on the contract chain (Polymarket
   literally does this on Polygon, but abandons the native trade
   screen/order book/wallet SDK for Solidity + web3 integration).
2. **CTF-style split/merge model** (Polymarket's Conditional Token
   Framework): depositing collateral mints an equal YES+NO pair from a
   pre-funded vault; merging returns collateral. Conservation is trivial and
   anyone can market-make.
3. **Resolver committee v1** (2-of-3) + permissionless bonded disputes +
   liveness rules (§3.3). Staked optimistic oracle with bonds/slashing
   (`StakeService` exists) promoted to phase 4 — the decentralization
   milestone.
4. **Collateral is per-event configurable**: BIG in dev; a USD-pegged
   currency token for mainnet (chain already has `currency` token type;
   tests use CNY-quoted pairs).

## 3. Protocol design (Java, phase 1)

### 3.1 Event model

**Event** = contract token on the **prediction chain** with tokenKeyValues:

| Key | Value |
|---|---|
| `classname` | `net.bigtangle.server.service.PredictionContract` |
| `question` | market question text |
| `collateralTokenid` | token id redeemable 1:1 per winning share |
| `outcomeTokenids` | `["<YES tokenid>","<NO tokenid>"]` |
| `resolutionTime` | unix seconds |
| `disputeWindowSeconds` | challenge window after `resolve` |
| `resolvers` | M-of-N resolver pubkeys (v1: **2-of-3**) — see §3.3 |
| issuer | event creator pubkey (beneficiary of `create`, funding only — not a trust role once resolvers are set) |

Issuer flow: create YES/NO tokens (supply S each, existing
`BLOCKTYPE_TOKEN_CREATION`) → submit `create` contract event escrowing S
collateral and pushing S YES + S NO into the event vault.

### 3.2 Operations

All operations are `CONTRACT_EVENT` blocks carrying an `action` field in the
event data. Event state is **recomputed from the ordered chain of accepted
events** (like the lottery recomputes from records) — no mutable token
metadata required.

| Action | Effect |
|---|---|
| `create` | escrow S collateral; vault = {S YES, S NO} |
| `split` | burn C collateral from user → pay C YES + C NO from vault |
| `merge` | burn C YES + C NO → pay C collateral |
| `resolve` | an M-of-N resolver (v1: 2-of-3) posts outcome (`yes`/`no`/`invalid`) after `resolutionTime`; starts dispute window |
| `dispute` | **anyone**, during the dispute window, posts a conflicting outcome with a bond → outcome frozen/re-opened per §3.3; failed disputor's bond is slashed to the resolvers |
| `redeem` | post-finalization: burn 1 winning share → pay 1 collateral; `invalid` → both sides redeem 1:1 |

### 3.3 Resolution & the oracle ladder

Every prediction market must answer "what happened?" — that is the oracle.
Sports is the easiest oracle domain: outcomes are objective and publicly
verifiable (final scores), redundantly sourced (league API, ESPN, box
scores), and final within hours, so disputes are cheap to adjudicate. The
plan climbs a ladder; a sophisticated oracle is not a launch prerequisite.

| Tier | Model | How it resolves sports | Precedent |
|---|---|---|---|
| **v1 (this plan)** | 2-of-3 resolver committee + permissionless dispute window (bonded) | Resolvers post the final score from official sources; anyone can dispute with a bond during the window (payouts frozen, re-resolution) | Kalshi (centralized clearinghouse) at committee scale instead of single-entity scale |
| **Next (phase 4)** | Staked optimistic oracle: propose with bond → challenge period → on dispute, token-holder vote; liar slashed | Anyone can post the score; security comes from economics, not trust | Polymarket (UMA) |
| **Later** | Data-feed adapters push official league scores on-chain | Automatic | Chainlink-style sports feeds |

Design notes:

- `invalid` (void → both sides redeem collateral) is mandatory, not
  optional: sports events genuinely void (rainouts, cancellations), and
  without it the vault gets stuck.
- **Resolution liveness (issuer-hostage fix)**: resolution must not depend
  on any single party's goodwill.
  - After `resolutionTime` + `graceSeconds`, **anyone** may post the
    outcome optimistically with a bond (the normal dispute window applies).
  - If nobody resolves by `resolutionTime` + `graceSeconds` +
    `autoInvalidSeconds`, the engine **auto-finalizes the event as
    `invalid`** — all shares redeem collateral 1:1. A dead resolver set can
    lose its fee, never the traders' vault.
- The dispute window is the minimum viable oracle: even "issuer resolves"
  is a (single, trusted) oracle — the only choice is how much
  dispute machinery surrounds it. v1 narrows trust from 1-of-1 to 2-of-3
  and makes disputes a permissionless right, not a favor.

### 3.4 Conservation invariant

At all times:

```
collateral_escrowed == YES_in_vault == NO_in_vault
YES_circulating    == NO_circulating
```

Trades only move shares between users; the engine touches the vault only on
split/merge/redeem. At resolution, winning shares outstanding == collateral
remaining in the vault. Test like `OrderPayoutConservationTest`.

### 3.5 Engine implementation

- New `PredictionContractExecutor implements ContractExecutor` +
  `PredictionContractRegistrar` (startup registration via the same
  `@PostConstruct`/`@Bean` pattern as `ContractEngineRegistrar`).
- Collect `CONTRACT_EVENT`/`CONTRACTEVENT_CANCEL` blocks during confirmation
  (mirror `ContractEngine.collectWithCancel`), apply the state machine
  (guarded transitions: `resolve` only after `resolutionTime`; signer must
  be in the M-of-N `resolvers` set — anyone with a bond after the grace
  period; dispute window before final; auto-`invalid` timeout per §3.3),
  emit a virtual payout tx via the existing `createPayoutTransaction`
  pattern.
- New solidity checks for contract-event offer/target (mirror
  `checkFullOrderOpenSolidity`).

### 3.6 Risks to resolve first

- Exact escrow semantics of `CONTRACT_EVENT` inputs (offer vs target) —
  confirm against `connectTypeSpecificUTXOs` before designing block payloads
  (the lottery stakes via `targetValue`).
- Oracle trust in v1 (2-of-3 resolver committee can still collude or
  mis-resolve) — mitigated by permissionless bonded disputes and the
  liveness rules (§3.3); replaced by the staked optimistic oracle in
  phase 4.
- Order matching is limit-only with an 8h timeout — fine for MVP shares, but
  "buy at 55¢" UX and day-long events may want market-order sugar
  client-side and longer windows.

## 4. Decentralization & trust model

Scorecard for the whole design (honest by component — the plan is
trust-minimized on custody and matching, deliberately weaker on resolution
in v1, and deliberately keeps a compliance kill switch):

| Component | Level | Notes |
|---|---|---|
| Consensus | inherited PoS | Same as ordermatch (`stakeDeposit`/slashing). Reality check: bigtangle L1 validator sets are young and small — consensus-grade decentralization is aspirational for all these chains equally |
| Matching | ✅ fully on-chain | Deterministic engine in servercore, runs on every node — no operator discretion over fills |
| Custody | ✅ non-custodial | Vault escrow + conservation asserted by every node; no operator can touch funds; `invalid` void guarantees exit |
| Issuance | ✅ permissionless | Anyone can create events; anyone can split/merge — no gatekeeping on liquidity provision |
| Resolution v1 | ⚠️ committee (2-of-3) | Narrowed from single-issuer; bonded permissionless disputes; liveness rules prevent vault hostage (§3.3). Still the trust bottleneck until phase 4 |
| Dispute window | ⚠️ optimistic | Security = "≥1 honest watcher exists"; disputes are a permissionless right with bonds, not a favor from the resolvers |
| App / RPC | ⚠️ trusted server | App trusts its L0/L1 RPC for chain data (standard light-client limitation; bigtangle's bridge SPV machinery is an upgrade path for client-side verification) |
| Kill switch | ❌ operator lever *by design* | Decision 1's compliance feature — geo-block/offline just this venue — also means operators/validators can halt it. Stated trade, not an accident |

**Verdict:** v1 = Polymarket-grade custody + committee-grade (not
single-entity) resolution trust. The remaining decentralization gap is
almost entirely the oracle ladder (§3.3), closed by phase 4's staked
optimistic oracle.

## 5. Client SDK (TS, phase 2)

`packages/bigtangle-ts`: a `PredictionMarket` helper module on top of the
existing `payContract` / `contractEventCancel` / `searchContractTokens` /
`outputsOfTokenid` calls:

- `createEvent`, `split`, `merge`, `resolve`, `dispute`, `redeem`
- `getEvent` (tokenKeyValues + recomputed event-chain state)
- `listEvents`, `getPositions`
- unit tests for serialization/state parsing

Per the Java-first rule in AGENTS.md: write `PredictionMarketIT` as a Java
remote test first (origin of truth), then port to
`packages/bigtangle-ts/test/testintegration/PredictionMarket.test.ts`
(gated by `INCLUDE_INTEGRATION_TESTS`).

## 6. App (expo-app, phase 3)

- New **"Predict" tab**: events list (question, end date, YES/NO last prices
  via `getOrdersTicker`, volume) → event detail **reusing `TradingChart` +
  order book + `orderOnLayer1`** with the YES/collateral and NO/collateral
  pairs (price displayed in ¢; "buy at 55¢" = client-side limit order — the
  engine is limit-only today).
- Positions screen (outcome-token balances + Redeem button).
- Issuer Create-event flow (question, collateral, supply, resolution time →
  createEvent + token creations + fund vault).
- Dispute button during the challenge window.
- Outcome tokens automatically appear in the existing tokens tab (they are
  regular tokens).
- **Bridge / peg-in UI (moved up from post-MVP)**: collateral must cross
  from L0 to the prediction chain (`regSubtangle` + `processPegIn` exist
  protocol-side — `remote.sh` already does this for ordermatch — but the
  app has **no bridge UI at all**; `pegInToL1`/`broadcastPegIn`/
  `getBridgeInfo` in `services/` are unused). Needed before any real
  trading can happen on the new chain.
- `services/http.ts` / `services/transaction.ts`: thin wrappers for the new
  SDK calls against the **prediction-chain URL** (new constant, same pattern
  as the order-chain `TEST_L1_URL` / `ordereu1.bigtangle.org`).
- Playwright: `predict.spec.ts` happy path (create → buy YES → resolve →
  redeem) on the `e2e/infra.sh` local stack.

## 7. Phases

1. **Chain + protocol** (Java, `../blockchain`):
   a. derive `l1-prediction-server` from `l1-order-server` (module copy,
      `PredictionL1Params` = order params + contract-event types, network
      config with chainId `prediction`);
   b. infra wiring: own DB, validator, Kafka chain topic
      (`helper/fulltest/remote.sh` `KAFKA_CHAINS="L0 ordermatch prediction"`),
      bridge registration (`regSubtangle` for `prediction`);
   c. `PredictionContractExecutor` + registrar, event state machine
      (incl. 2-of-3 resolvers, bonded disputes, liveness rules — §3.3),
      conservation unit tests.
2. **SDK** (TS, `packages/bigtangle-ts`): helpers + unit tests; Java remote
   IT first, then TS port; run `e2eremote.sh` (infra now starts three
   chains).
3. **App** (`expo-app`): bridge/peg-in UI, predict tab, event detail,
   positions/redeem, create-event, dispute, Playwright spec.
4. **Oracle v2 — staked optimistic** (the decentralization milestone):
   propose-with-bond → challenge period → token-holder vote on dispute,
   slash the liar; replaces the resolver committee (§3.3 ladder).
5. **Post-MVP**: multi-outcome (N winner-take-all tokens), market orders,
   USD collateral on mainnet, data-feed adapters, geo-fencing/KYC.

## 8. Out of scope

Regulatory/compliance work for real-money launch (the CFTC-vs-states
litigation context in the press): licensing, geo-blocking, KYC, and player
protections are legal/product work outside this technical plan.
