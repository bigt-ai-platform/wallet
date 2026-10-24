# Predict — Kalshi/Polymarket-style Prediction Market on Bigtangle

Status: implemented (design proposal of 2026-10-10 kept below for history)
Date: 2026-10-10, updated 2026-10-23

Example markets for China, Germany and the US, with the exact create-form
values and the full lifecycle: [prediction-demo/predict.md](prediction-demo/predict.md)
(US, English), [predict.de.md](prediction-demo/predict.de.md),
[predict.zh.md](prediction-demo/predict.zh.md).

## Implementation safety update (2026-10-21)

The design proposal below is historical; prediction markets are now implemented.
The wallet's redemption flow requires the prediction server's read-only
`POST /getPredictionState` endpoint with `{ "contractTokenid": "..." }`.
It returns the latest confirmed contract checkpoint, including `contractTokenid`,
`confirmed`, `blockHash`, `chainlength`, and `state` (with `initialized`, `status`,
and `outcome`). No confirmed checkpoint returns `confirmed: false, state: null`.
The read does not advance liveness or infer finality from wall-clock time.

Deploy the updated `../blockchain` prediction server before enabling redemption
in the updated wallet. Missing, malformed, or unavailable state disables
redemption without hiding balances. Every redemption re-reads confirmed state:
only `FINAL` markets can redeem, directional results burn only winning shares,
and invalid results burn equal complete sets, preserving unmatched shares.
Market orders use only outcome/collateral liquidity. Committee disputes burn
`disputeBond`; staked challenges burn at least `proposalBond`.

### Wallet workflow

- Market cards show confirmed status, proposed/challenged outcomes, and oracle
  deadlines. An elapsed deadline is not presented as confirmed finality.
- Split, merge, trading, proposals, disputes, votes, and redemption are gated by
  market state. Signing paths re-read state; split/merge also reject expired
  markets. Oracle checks include committee membership, conflicting outcomes,
  bond minimums, self-challenges, and attempts to switch an existing vote.
- Outcome books show the best paired bid/ask and available size. Buy/sell opens
  a preview with estimated fill, a price limit, and configurable slippage
  (0-10%). Quotes expire after 30 seconds and the book is re-read at submission.
  Prices and amounts are raw on-chain units, not percentages or guaranteed
  execution prices. These are crossing limit orders; unfilled orders may rest.
- Creation supports 2-16 unique outcome labels, collateral selection, staked or
  committee oracles, bonds, and timing controls. Labels are persisted as
  `outcomeNames`. Numeric settings and labels are validated before minting.
  The existing prediction-chain domain-signing authorization is still required.

These are client preflight checks, not atomic reservations: chain state can
change between a read and transaction execution. Contract execution remains
the protocol authority. The state API is read-only; deadline settlement may
require a subsequent contract event (including a heartbeat).

The prediction Playwright suite includes read-endpoint fixtures for UI guards
and desktop/mobile previews. Its separate live lifecycle uses a funded operator
to create, split, merge, match an order, resolve, and redeem, verifying confirmed
state and balances. Run `e2e/e2etest.sh predict` with isolated Java infrastructure
and `E2E_PREDICTION_KEY`; UI fixtures alone do not establish live-chain success.

*Original MVP scope (2026-10-10):* binary event markets ("Will X happen by date D?") with YES/NO outcome shares
priced 0–1 (displayed 0–100¢), full collateral backing (1 winning share
redeems for exactly 1 collateral unit), traded on the order books of a
**new dedicated L1 chain, `l1-prediction`** (derived from `l1-order-server`).
Resolved by a 2-of-3 committee with a permissionless dispute window (v1
oracle). Since then multi-outcome markets (2–16 outcomes) and the staked
oracle have shipped (§7 phases 4–5); the app shows prices in raw on-chain
units, not ¢.

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

## 1. Starting point (verified 2026-10-10, historical)

- At design time **no prediction-market code existed** in `wallet` or `../blockchain`
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
   tests use CNY-quoted pairs). Collateral must be a native or
   `tokenstop` token — never a re-issuable one (§4.2 #5).
5. **HARD REQUIREMENT — fixed-supply outcome tokens.**
   YES/NO are created with `tokenstop=true`; the engine **asserts
   `supply == S`** and rejects any token block referencing the event tokens
   after `create`. Rationale: `ServiceBaseCheck.java:2430-2435` permits
   *further issuance* unless stopped, and reissue rights sit with the
   token's multi-sign addresses — without this, the issuer can mint extra
   winning shares and drain the vault (§4.2 #1).

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
| `graceSeconds` | after `resolutionTime`, before anyone may post optimistically (§3.3) |
| `autoInvalidSeconds` | after grace, before auto-`invalid` finalization (§3.3) |
| `resolvers` | M-of-N resolver pubkeys (v1: **2-of-3**) — see §3.3 |
| issuer | event creator pubkey (funds/creates the event; not a trust role once resolvers are set) |

Issuer flow: create YES/NO tokens (supply S each, **`tokenstop=true`**, existing
`BLOCKTYPE_TOKEN_CREATION`) → submit `create`, funding the event vault with
the S YES + S NO supply. **No collateral is escrowed at `create`** — the
vault's backing comes entirely from `split` deposits (CTF model, §3.2/§3.4).
The issuer seeds trading by splitting pairs (the same primitive anyone uses)
or selling shares it kept.

### 3.2 Operations

All six operations are `CONTRACT_EVENT` blocks carrying an `action` field in
the event data; the existing `BLOCKTYPE_CONTRACTEVENT_CANCEL` type is **not**
the dispute path — it stays reserved for aborting an unresolved market
before `resolutionTime` (void → `invalid`, refund). Event state is
**recomputed from the ordered chain of accepted events** (like the lottery
recomputes from records) — no mutable token metadata required.

| Action | Effect |
|---|---|
| `create` | fund the vault with pre-minted S YES + S NO (no collateral escrowed) |
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
- A dispute must have a **defined adjudicator**, or it is just a freeze
  primitive (§4.2 #2). v1 rule: **at most one dispute per market**, with an
  escalating bond; a disputed market escalates to a larger resolution set
  and, if not re-resolved within the extended window, **auto-finalizes
  `invalid`**. The committee that posted the original outcome cannot be its
  own appeal.
- The dispute window is the minimum viable oracle: even "issuer resolves"
  is a (single, trusted) oracle — the only choice is how much
  dispute machinery surrounds it. v1 narrows trust from 1-of-1 to 2-of-3
  and makes disputes a permissionless right, not a favor.
- *As implemented (committee mode, `PredictionContractExecutor.applyDispute`):*
  quorum is a majority (`size/2 + 1`); a dispute (bond ≥ `disputeBond`, a
  different outcome, inside the window) pays its bond to the resolvers,
  clears their votes and reopens resolution **to the same committee**.
  Disputes are not capped and the bond does not escalate, so the
  "one dispute, larger set, cannot be its own appeal" rule above is not yet
  enforced. Repeated paid disputes can push a market into the auto-`invalid`
  deadline.

### 3.4 Conservation invariant

The vault holds the un-split share stock on each side; collateral enters the
vault only via `split` and is what redemption pays from. At all times:

```
collateral_in_vault == YES_circulating == NO_circulating
collateral_in_vault + YES_in_vault == S   (likewise for NO)
YES_supply == NO_supply == S              (no re-issuance; §2.5)
```

No collateral is escrowed at `create` (§3.1), so these hold from the event's
genesis: the first `split` adds C collateral and moves C YES + C NO out of
the vault, preserving the equality. Trades only move shares between users;
the engine touches the vault only on split/merge/redeem, and at resolution
winning shares outstanding == collateral remaining in the vault. Test like
`OrderPayoutConservationTest`.

**No value creation:** the vault must never pay out more than it took in —
integer rounding in split/merge/redeem is always resolved *toward the vault*,
and any remainder is burned, never credited (§4.2 #7). Property-test with
adversarial odd amounts, not just round numbers.

### 3.5 Engine implementation

- New `PredictionContractExecutor implements ContractExecutor` +
  `PredictionContractRegistrar` (startup registration via the same
  `@PostConstruct`/`@Bean` pattern as `ContractEngineRegistrar`).
- Collect `CONTRACT_EVENT` (all actions) and `CONTRACTEVENT_CANCEL`
  (pre-resolution abort) blocks during confirmation
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
- Unverified assumptions to confirm before building: (a) outcome/contract
  tokens are acceptable as order-book tokens — no token-type restriction was
  found in `ServiceBaseOrder`/`ServiceBaseCheck`, but it is not positively
  confirmed; (b) `merge`/`redeem` can burn shares via the same
  spend-with-no-output path order escrow uses; (c) `BLOCKTYPE_TOKEN_CREATION`
  can mint a fixed supply into an engine-escrowed vault (the vault is not a
  normal address).
- Oracle trust in v1 (2-of-3 resolver committee can still collude or
  mis-resolve) — mitigated by permissionless bonded disputes and the
  liveness rules (§3.3); replaced by the staked optimistic oracle in
  phase 4.
- Order matching is limit-only with an 8h timeout — fine for MVP shares, but
  "buy at 55¢" UX and day-long events may want market-order sugar
  client-side and longer windows.
- Full adversarial review (mint re-issuance, dispute adjudication, engine
  DoS, bridge collusion, rounding leaks) is in §4.2.

## 4. Trust & threat model

### 4.1 Decentralization scorecard

Scorecard for the whole design (honest by component — the plan is
trust-minimized on custody and matching, deliberately weaker on resolution
in v1, and deliberately keeps a compliance kill switch):

| Component | Level | Notes |
|---|---|---|
| Consensus | inherited PoS | Same as ordermatch (`stakeDeposit`/slashing). Reality check: bigtangle L1 validator sets are young and small — consensus-grade decentralization is aspirational for all these chains equally |
| Matching | ✅ fully on-chain | Deterministic engine in servercore, runs on every node — no operator discretion over fills |
| Custody | ✅ non-custodial | Vault escrow + conservation asserted by every node; no operator can touch funds; `invalid` void guarantees exit |
| Issuance | ⚠️ permissioned creation | Market creation needs the prediction chain's domain-signing authorization (Implementation update above); split/merge and trading stay open to anyone |
| Resolution v1 | ⚠️ committee (2-of-3) | Narrowed from single-issuer; bonded permissionless disputes; liveness rules prevent vault hostage (§3.3). Still the trust bottleneck until phase 4 |
| Dispute window | ⚠️ optimistic | Security = "≥1 honest watcher exists"; disputes are a permissionless right with bonds, not a favor from the resolvers |
| App / RPC | ⚠️ trusted server | App trusts its L0/L1 RPC for chain data (standard light-client limitation; bigtangle's bridge SPV machinery is an upgrade path for client-side verification) |
| Kill switch | ❌ operator lever *by design* | Decision 1's compliance feature — geo-block/offline just this venue — also means operators/validators can halt it. Stated trade, not an accident |

**Verdict:** v1 = Polymarket-grade custody + committee-grade (not
single-entity) resolution trust. The remaining decentralization gap is
almost entirely the oracle ladder (§3.3), closed by phase 4's staked
optimistic oracle.

### 4.2 Threat model

Adversarial review of the design. Severity is impact × reachability for an
attacker who is not a chain majority.

| # | Vector | Sev | Attack | Mitigation |
|---|---|---|---|---|
| 1 | **Token re-issuance** | **Crit** | The chain allows *further issuance* of an existing token unless stopped (`ServiceBaseCheck.java:2430-2435`); reissue rights belong to the token's multi-sign addresses (`:2438`). Mint extra winning shares after `create` → redeem against a vault backed only for S → **drain all collateral** | Create YES/NO with `tokenstop=true` (fixed supply); engine **asserts `supply == S`** and rejects any token block referencing the event tokens post-`create` (hard invariant, §2.5) |
| 2 | **Undefined dispute adjudicator** | **Crit** | v1 says a bonded dispute freezes/re-opens a market but never says who finally decides; the committee that just resolved can't be its own appeal. Any bonded party can freeze settlement indefinitely (DoS), or the committee rubber-stamps | Define v1 adjudication explicitly: dispute escalates to a larger resolution set, or auto-`invalid` if unresolved within the window; **one dispute max** per market with an **escalating bond** |
| 3 | **Unbounded engine work** | High | State "recomputed from the accepted-event chain" is O(events); auto-`invalid` scans all open markets each BEACON (O(markets)). Cheap event/market spam makes confirmation arbitrarily expensive | Rolling per-market accumulator checkpointed in `contractresult` (as the lottery chains `prevContractresult`); queued resolution pass instead of full scans; per-block event caps; fees |
| 4 | **Validator + resolver / bridge collusion** | High | New L1 bootstraps operator-controlled; resolvers overlapping validators can censor disputes and force outcomes. Cross-chain, the L0→prediction **bridge** (M-of-N vault, SPV anchors) is the dominant trust boundary — compromised keys mint fake collateral | Independent validator and resolver sets; resolver set not chosen solely by the issuer (§4.2 #6); bridge key hygiene + the existing outpoint-keyed replay protection; treat bridge as the systemic risk in ops |
| 5 | **Collateral issuer risk** | High | A "USD-pegged currency token" for mainnet is itself re-issuable (`tokenstop` gap) → collateral inflation makes redemptions worthless | Whitelist collateral to native BIG and/or `tokenstop` tokens only |
| 6 | **Vault stock not irreversibly escrowed** | High | Pre-minted S YES + S NO must not be withdrawable by the issuer, or splitters can't get shares (DoS) / stock is double-spent | `create` escrows the stock under engine control (not a spendable address); release only via `split` |
| 7 | **Rounding / dust value leak** | Med | `Coin` is integer-valued and order escrow already permits truncation dust; split=floor vs merge/redeem=ceil lets a loop extract value | Exact conservation: the vault never pays out more than it took in; remainder is burned, never credited. Adversarial-amount property tests |
| 8 | **MEV / insider trading** | Med | Resolve/dispute txs are visible pre-inclusion; a resolver can trade the book before resolving; disputors front-run; wash trading fakes volume/price | Commit-reveal for resolution; bar resolvers from trading their own event; ordering rules; volume-integrity monitoring |
| 9 | **Liquidity / exit trap** | Med | A one-sided buyer cannot exit without a counterparty (or acquiring the other side to merge); a dominant MM can squeeze | MM incentives / fallback liquidity, or disclose for MVP |
| 10 | **Price band not enforced** | Med | Nothing constrains order prices to (0,1); trades at >1/<0 (self-harm) enable wash/odd payouts | Enforce the band in the contract or order validation |
| 11 | **Position transparency** | Low | Public book + addresses exposes every position (copy-trading, coercion) — opposite of Kalshi's opacity | Product/compliance consideration; optional privacy layer later |
| 12 | **Resolution timing gap** | Low | Between game-end and resolution, informed trading/dumping is possible | Resolve promptly or freeze the book at `resolutionTime` |

**Sharpest takeaways:** #1 is design-breaking with a verified, concrete fix
(`tokenstop` + engine supply assertion) and is promoted to a hard
requirement in §2.5. #2 must be specified before any real money; #3 and #4
are the availability/systemic risks.

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
      (incl. 2-of-3 resolvers, single-dispute adjudication, bonded disputes,
      liveness rules — §3.3), fixed-supply assertion (§2.5), no-value-creation
      conservation unit tests.
2. **SDK** (TS, `packages/bigtangle-ts`): helpers + unit tests; Java remote
   IT first, then TS port; run `e2eremote.sh` (infra now starts three
   chains).
3. **App** (`expo-app`): bridge/peg-in UI, predict tab, event detail,
   positions/redeem, create-event, dispute, Playwright spec.
4. **Oracle v2 — staked optimistic** (the decentralization milestone):
   propose-with-bond → challenge period → token-holder vote on dispute,
   slash the liar; replaces the resolver committee (§3.3 ladder).
   *Implemented:* the engine selects it with the contract key `oracle=staked`
   (no `committee`); anyone may propose after `resolutionTime` by bonding
   `proposalBond` collateral, a conflicting bonded `dispute` (>= `proposalBond`)
   freezes the proposal and opens a `voteWindowSec` stake-weighted vote
   (`vote` action bonds collateral for one side); the greater-weighted outcome
   wins, winners are refunded their stake plus a proportional share of the
   loser's bond, and a tie or an unbonded proposal voids (`invalid`)
   (`PredictionContractExecutor` + `PredictionState`; tested by
   `PredictionEngineTest`).
5. **Post-MVP**: multi-outcome (N winner-take-all tokens), market orders,
   USD collateral on mainnet, data-feed adapters, geo-fencing/KYC.
   *Implemented:* multi-outcome complete sets — the contract carries an ordered
   `outcomeTokenids` list (N >= 2, superseding `yesTokenid`/`noTokenid`); a
   `split` of C collateral mints C of every outcome from the vault, `merge`
   burns C of every outcome back to C collateral, a directional resolution pays
   the named winning token 1:1, and `invalid` redeems complete sets
   (`PredictionConfig`/`PredictionState`/`PredictionContractExecutor`; the
   conservation invariant is checked per outcome). SDK `PredictionMarketConfig`
   accepts `outcomeTokenids`; the app service/UI iterate the outcome list.
   Market orders, USD collateral and data-feed/geo/KYC remain open (§8).
   Also implemented: the engine's §2.5 hard invariant — `validateVaultTokens`
   rejects any market whose outcome tokens are not `tokenstop` or whose minted
   amount != S, and whitelists collateral to native BIG or `tokenstop` tokens
   (§4.2 #5); and client-side market-order sugar
   (`PredictionMarketOrders.planBuy/planSell` in the SDK, `marketOrderOutcome`
   in the app) that turns an order-book snapshot into the crossing limit price
   and submits it through the normal L1 flow.

## 8. Out of scope

Regulatory/compliance work for real-money launch (the CFTC-vs-states
litigation context in the press): licensing, geo-blocking, KYC, and player
protections are legal/product work outside this technical plan.

### 8.1 Enforcement boundary (why KYC/geo is not a protocol feature)

Being chain-based changes *who* can enforce compliance, not whether the offering
entity has obligations. The three layers differ sharply:

- **Protocol (l1-prediction-server, validators, vault, oracle): cannot enforce
  KYC/geo.** Any key can submit a `ContractEventInfo`; filtering transactions
  means validator censorship, which contradicts the permissionless staked-oracle
  design (§3.3 phase 4). Do not build KYC/geo into the engine.
- **Service edges (where it is actually enforceable):** the app distribution /
  account gate / device-IP-locale checks (bypassable — direct RPC or self-host
  defeats them), the **bridge / collateral on-ramp** (the strongest chokepoint:
  fiat or a regulated USD-pegged stablecoin is where AML/KYC and licensing
  attach), and the operator/issuer/resolver entity that takes fees.
- **Consequence for design:** a native-BIG-only, no-fiat, no-USD-stablecoin
  deployment (the current dev posture, `collateralTokenid = BC`) has a very
  small regulatory surface, so geo/KYC is optional product policy rather than a
  hard requirement. Exposing a USD stablecoin and a fiat on-ramp inherits
  derivatives/event-contract and AML rules (US: CFTC) — still enforced at the
  front-end/bridge, never on-chain. The lever under our control is how much
  fiat/collateral surface we expose.

