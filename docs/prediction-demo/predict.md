# Predict demo — US markets (English)

**Other demos:** [Germany (Deutsch)](predict.de.md) · [China (中文)](predict.zh.md) · Design and threat model: [../prediction-market.md](../prediction-market.md)

Three example markets for a US audience, showing the three market shapes the
**Predict** tab supports:

1. a **binary** market with a 2-of-3 resolver committee,
2. a **multi-outcome** market (2–16 outcomes) with a committee,
3. a **staked-oracle** market where anyone can propose the result.

Each has the exact create-form values, a written resolution rule, and the
lifecycle from creation to redemption.

> **Testnet demo, not a real-money product.** The collateral is native BIG
> (`bc`) on the prediction test chain. In the US, real-money event contracts
> are regulated by the CFTC (a designated contract market is required), and
> sports or election contracts also run into state gaming law. Nothing here is
> an offer to US persons; see [§8 of the design](../prediction-market.md#8-out-of-scope).

---

## Before you start

- **A PQ (ML-DSA) wallet.** Prediction actions reject EC wallets.
- **BIG on the prediction chain.** BIG pays the fees and is the collateral.
  There is no bridge/peg-in screen in the app yet, so an operator funds
  demo wallets on the prediction chain.
- **Market creation is permissioned.** The creator's key must be authorized
  to sign the prediction chain's token domain. Trading, resolving, disputing,
  voting and redeeming are open to any funded PQ wallet.
- **Committee addresses.** For committee markets, collect the hex addresses
  of the resolvers (each resolver's wallet address). With 3 resolvers a
  result needs **2 matching resolutions** (a majority, `size/2 + 1`).
- **Units.** Supply, bonds and order-book prices are **raw on-chain units**.
  One winning share redeems exactly one unit of collateral, so a price
  relative to one collateral unit reads as the market's implied probability.
  The app does not convert to ¢ or %.
- **Day counts below assume creation on 2026-10-23.** "Resolution days"
  accepts fractions; recompute for your own date.

---

## Market 1 — Fed decision (binary, committee)

**Question:** *Will the FOMC lower the federal funds target range at its
first scheduled meeting of 2027?*

| Create-form field | Value |
|---|---|
| Question | `Will the FOMC lower the federal funds target range at its first scheduled meeting of 2027?` |
| Outcomes | `YES` / `NO` (one per line) |
| Collateral | `bc` |
| Supply | `1000000` |
| Resolution days | `105` (→ 2027-02-05, after the meeting statement) |
| Dispute window (s) | `86400` (24 h) |
| Auto-invalid (s) | `2592000` (30 days) |
| Oracle | `committee` |
| Committee | 3 resolver addresses, one per line |
| Bond (dispute bond) | `1000` |

**Resolution rule.** The market resolves to **YES** if the FOMC statement
issued after the first scheduled 2027 meeting (federalreserve.gov) lowers
the upper bound of the target range; it resolves to **NO** if the range is
unchanged or raised. An unscheduled (emergency) cut before that meeting does
not count. If no scheduled meeting is held before the resolution time,
resolvers post **INVALID**.

## Market 2 — December 2026 CPI (multi-outcome, committee)

**Question:** *What will the BLS report as US CPI-U year-over-year inflation
for December 2026 (not seasonally adjusted, first release)?*

| Create-form field | Value |
|---|---|
| Outcomes | `Below 2.5%` / `2.5% to 3.0%` / `Above 3.0%` |
| Collateral / Supply | `bc` / `1000000` |
| Resolution days | `94` (→ 2027-01-25, after the January CPI release) |
| Dispute window / Auto-invalid (s) | `86400` / `2592000` |
| Oracle / Committee / Bond | `committee` / 3 addresses / `1000` |

**Resolution rule.** Use the first BLS release, rounded to one decimal as
published. `2.5% to 3.0%` includes both bounds (2.5 and 3.0). Later
revisions are ignored. If BLS does not publish by the resolution time
(for example during a federal shutdown), resolvers wait; if nothing is
resolved before the auto-invalid deadline, the market voids.

Outcome labels may not contain commas, must be unique, and are limited to 40
characters. A split of C collateral yields C shares of **every** outcome.

## Market 3 — S&P 500 year-end close (binary, staked oracle)

**Question:** *Will the S&P 500 index close above 7000 on December 31, 2026?*

| Create-form field | Value |
|---|---|
| Outcomes | `YES` / `NO` |
| Collateral / Supply | `bc` / `1000000` |
| Resolution days | `71` (→ 2027-01-02) |
| Dispute window (s) | `86400` |
| Auto-invalid (s) | `1209600` (14 days) |
| Oracle | `staked` (leave Committee empty) |
| Bond (proposal bond) | `5000` |
| Vote window (s) | `172800` (48 h) |

**Resolution rule.** The official S&P Dow Jones Indices closing value for
the last trading session of 2026. **YES** if strictly above 7000.

---

## Walkthrough (same for all three markets)

1. **Create.** Predict tab → **Create market** → fill the table → submit. The
   app mints one fixed-supply token per outcome, creates the contract token,
   and moves the full supply into the market's vault. The market appears as
   **OPEN**.
2. **Provide liquidity (split).** Enter an amount and press **Split**: C BIG
   becomes C shares of every outcome. **Merge** does the reverse while the
   market is open.
3. **Trade.** Each outcome has an order book against BIG (best bid/ask and
   size). **Buy**/**Sell** opens a preview with the estimated fill, a limit
   price and slippage (0–10%, default 0.5%). A quote expires after 30 s and
   the book is re-read when you submit. These are crossing limit orders, so
   any unfilled remainder rests on the book.
4. **Resolve.** After the resolution time the market shows *resolution due*.
   - *Committee (markets 1–2):* each resolver presses the outcome. When a
     majority agrees, the market becomes **PENDING** and the dispute window
     starts.
   - *Staked (market 3):* anyone proposes an outcome and bonds at least the
     proposal bond. The market becomes **PENDING**.
5. **Dispute.** While **PENDING**, anyone can post a different outcome with a
   bond.
   - *Committee:* the bond (≥ dispute bond) is paid to the resolvers, the
     resolutions are cleared, and the committee resolves again.
   - *Staked:* a challenger (not the proposer) bonds at least the proposal
     bond. The market becomes **VOTING**, and holders bond BIG on either
     side for the vote window. The side with more bonded weight wins;
     winners get their stake back plus a share of the losing bond. A tie
     voids the market.
6. **Final.** When the window passes with no dispute, the market is
   **FINAL**. If nobody resolves before *resolution time + auto-invalid*,
   it finalizes as **INVALID**.
7. **Redeem.** In a **FINAL** market, **Redeem** burns winning shares 1:1 for
   BIG. In an **INVALID** market it burns complete sets (one share of every
   outcome) for 1 BIG each; unmatched leftover shares stay in the wallet.

The list filters **open / resolving / final / mine** and the search box find a
market again later. *Mine* shows the markets where you hold shares.

## Checklist for writing your own US market

- Name **one primary source** and the exact figure: release, series,
  seasonal adjustment, first print or revised.
- Define the boundaries. Which side owns an exact tie (for example
  "2.5% to 3.0% includes both bounds")?
- Say what happens if the source is late or missing: wait until
  auto-invalid, or resolve INVALID.
- Set the resolution time **after** the source publishes, and give the
  dispute window enough time for a human to check.

---

## Screenshots (local test chain)

Captured by `./e2e/e2etest.sh predict-demo` against the local L1-prediction
chain.

### Market 1 — Fed decision

![Create form: Fed decision](assets/screenshots/predict-us-1-create.png)

![Market card: Fed decision](assets/screenshots/predict-us-1-market.png)

![After a 100000 split](assets/screenshots/predict-us-1-split.png)

### Market 2 — December 2026 CPI

![Create form: CPI ranges](assets/screenshots/predict-us-2-create.png)

![Market card: CPI ranges](assets/screenshots/predict-us-2-market.png)

### Market 3 — S&P 500 year-end close

![Create form: S&P 500, staked oracle](assets/screenshots/predict-us-3-create.png)

![Market card: S&P 500](assets/screenshots/predict-us-3-market.png)

### Your markets

![The mine filter](assets/screenshots/predict-us-mine.png)
