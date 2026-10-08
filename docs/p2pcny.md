# P2P CNY — 微信支付 / 支付宝 / 银行转账

**Status: plan — not built.** Companion to [p2p.md](./p2p.md), which designs and
documents the PayPal rail. This document covers the **China fiat leg**: how a
buyer pays CNY to the seller over the three rails ordinary people actually use —
WeChat Pay (微信支付), Alipay (支付宝) and bank transfer (银行转账) — while the
token leg stays the 2-of-3 escrow on L0 from `p2p.md`.

Everything in `p2p.md` that is about the chain stays as-is: escrow lock,
`getTransactionStatus` proof, engine+buyer co-sign release, engine+seller
co-sign refund, the append-only event log, and the L1-SOCIAL anchor. Only the
fiat steps (4, 5, 7 of the `p2p.md` sequence) change.

---

## 1. The one difference that shapes everything

| | PayPal (built) | CNY rails (this plan) |
|---|---|---|
| Machine-verifiable payment event | ✅ `INVOICING.INVOICE.PAID` webhook (RSA-verified) | ❌ none exists |
| Engine receives the fiat | ✅ merchant invoice → merchant account | ❌ buyer pays **seller directly**, peer-to-peer |
| Engine pays the seller out | ✅ Payouts v1 | ❌ unnecessary — the seller already received the CNY |
| Who confirms the buyer paid | the engine (the rail) | the **seller**, in their own bank/WeChat/Alipay app |
| Manual confirmation | never (`p2p.md` invariant) | **yes — it is the design** |

There is no invoice, no webhook and no payout for a personal CNY transfer, and
there never will be: WeChat Pay and Alipay expose no collection API for
personal accounts, and a natural-person bank account cannot receive callbacks.
This is not a gap to engineer around — it is the rail. Every C2C crypto-fiat
platform in China (Binance P2P, OKX C2C, Huobi C2C) settles this way: buyer
transfers, seller confirms, platform arbitrates appeals.

So the CNY fiat signal becomes: **the seller attests that money is in their
account**. That is strong evidence on the seller's side (they are looking at
their own balance) and the engine's job shrinks from *verifying* the rail to
*enforcing the protocol*: confirm-then-release, dispute-then-arbitrate, always
fail closed on the chain leg.

---

## 2. Rails

| | 微信支付 WeChat Pay | 支付宝 Alipay | 银行转账 Bank transfer |
|---|---|---|---|
| Speed / hours | instant, 24/7 | instant, 24/7 | instant for small amounts (IBPS/网银) 24/7; large via HVPS on banking hours |
| Transfer note (备注) | ✅ supported | ✅ supported | ✅ 附言/备注 (length and charset vary by bank) |
| Receiver identity shown to sender | nickname + 实名 surname | 实名 account name | **full account name** (户名) — best for name-match |
| Typical use in P2P | small/medium, fast | small/medium, fast | large amounts, preferred when limits or freeze risk bite |
| Freeze (冻卡) risk | medium–high for crypto-pattern transfers | medium–high | lower per-transfer, but 冻卡 on both sides still happens (涉案资金) |
| Clawback by sender | none (personal transfers are final) | none | none |
| Collection API for personal accounts | none | none | none (corporate 银企直联 only — Phase C4) |

Recommendations:

- Offer **all three** on every order; buyer picks at match time (the seller's
  profile stores which they accept).
- Default to **bank transfer above a configurable threshold** — the full
  户名 (account name) on the transfer screen is the strongest identity check,
  and HVPS/网银 transfers are less likely to trip WeChat/Alipay risk controls.
- Never treat a **screenshot** as proof of anything by itself (§6).

Exact per-rail personal limits change often; keep them as engine config, not
constants in the app.

---

## 3. Flow

```
  buyer                     p2p-engine                         seller
    │                            │                                │
    │ 1. match order (DID-signed, wantCurrency=CNY, wantRail∈{wechat,alipay,bank})
    │───────────────────────────▶│                                │
    │                    2. fund 2-of-3 P2SH escrow on L0 ◀──────│
    │            3. getTransactionStatus → CONFIRMED + address + amount
    │                            │                                │
    │ 4. signed GET payment-instructions (rail, 户名, account/QR,   │
    │    exact CNY amount, remark code) ◀──────────────────────────│ (profile)
    │                            │                                │
    │ 5. buyer transfers CNY directly to seller, remark=code,      │
    │    uploads receipt → POST /swaps/:id/proof                   │
    │───────────────────────────▶│  status → PAYMENT_CLAIMED       │
    │                            │                                │
    │                    6. seller checks OWN app (amount + remark │
    │                       + time), POST /swaps/:id/confirm ◀─────│
    │                            │  status → PAYMENT_VERIFIED      │
    │ 7. engine + buyer co-sign release → submitTransaction        │
    │◀──────────────────────────│─────────────────────────────────▶│ (tokens)
    │                            │                                │
    │                    8. anchor social.p2p-swap on L1-SOCIAL    │
    │                            │                                │
    │ (no step 7 payout from p2p.md — seller already has the CNY)  │
```

Step by step against the `p2p.md` table:

| # | Step | Change vs `p2p.md` |
|---|---|---|
| 1 | Seller posts a signed limit order (`wantCurrency: "CNY"`, `wantRail: "cny"`, accepted methods in the order) | extended |
| 2 | Buyer matches: `receiveAddress`, nothing PII-mandatory | `paypalAccount`/`buyerEmail` drop out |
| 3 | Seller funds escrow; engine proves it via `getTransactionStatus` + amount | unchanged, fail closed |
| 4 | Engine hands the buyer the seller's **payment instructions** (signed, party-scoped) | replaces the PayPal invoice |
| 5 | Buyer pays the seller's account with remark = per-swap code, uploads receipt → `PAYMENT_CLAIMED` | replaces the PAID webhook |
| 6 | Seller confirms from their own app → `PAYMENT_VERIFIED` → engine + buyer co-sign release | replaces the engine's webhook-triggered release |
| 7 | ~~Payouts v1 to seller~~ | **deleted** — the fiat went buyer → seller directly |
| 8 | Anchor every event as `social.p2p-swap` on L1-SOCIAL, fail closed | unchanged |

The seller's payment instructions and the per-swap remark code are delivered
**only after `ESCROW_LOCKED`** and only to the matched buyer, through the same
whole-body signed, party-scoped reads as `POST /swaps/mine` / `/swaps/get` in
`p2p.md`.

---

## 4. State machine delta

Existing states (`packages/p2p-protocol/src/records.ts` `P2P_SWAP_STATUSES`)
gain exactly one:

```
ESCROW_LOCKED ──instructions shown──▶ PAYMENT_PENDING
PAYMENT_PENDING ──buyer proof──▶ PAYMENT_CLAIMED   ← new
PAYMENT_CLAIMED ──seller confirm──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──▶ COMPLETED

any pre-release state ──dispute open──▶ frozen (status unchanged, `dispute` field set — same
                                        mechanism as the PayPal dispute flag in p2p.md)
any pre-release state ──timeout / failure──▶ EXPIRED ──refund──▶ ESCROW_REFUNDED
```

- **`PAYMENT_PENDING → PAYMENT_CLAIMED`** is the buyer's claim; it never
  releases anything on its own.
- **`PAYMENT_CLAIMED → PAYMENT_VERIFIED`** requires the **seller's** DID-signed
  `confirm`. The engine's own signer still executes `verify → release` exactly
  as for PayPal, but its precondition is now the seller's attestation instead of
  a webhook.
- A dispute freezes the swap via the existing `dispute` field (no new status);
  resolution is an explicit engine-admin outcome (§5).

New event types (`services/p2p-engine/src/types.ts` `SwapEventType`):

| Event | Actor | Payload (store-only, never anchored raw) |
|---|---|---|
| `payment_instructions` | engine | which profile fields were revealed |
| `payment_proof` | buyer | receipt file ref + sha256, claimed tx id (流水号), remark, paidAt |
| `payment_confirm` | seller | confirmedAt, matched amount/remark |
| `dispute_open` | buyer or seller | reason code |
| `dispute_resolve` | engine admin | outcome `release` \| `refund`, note |

Everything else (`match`, `escrow_lock`, `release`, `expire`, `refund`,
`cancel`) is untouched.

---

## 5. Engine API delta (`services/p2p-engine`)

All new endpoints are whole-body signed like the existing ones.

| Endpoint | Who | Effect |
|---|---|---|
| `GET  /swaps/:id/payment-instructions` | buyer or seller | matched profile fields + exact CNY amount + remark code; 403 for non-parties; only after `ESCROW_LOCKED` |
| `POST /swaps/:id/proof` | buyer | `payment_proof` → `PAYMENT_CLAIMED`. Body: receipt file (or object ref) + sha256, `txId`, `remark`. One claim per swap; overwrites before confirm are allowed and both kept (append-only) |
| `POST /swaps/:id/confirm` | seller | checks: status `PAYMENT_CLAIMED`, no open dispute, lock still `CONFIRMED` (fail closed) → engine+buyer release broadcast → `PAYMENT_VERIFIED` → `ESCROW_RELEASED` |
| `POST /swaps/:id/dispute` | buyer or seller | sets `dispute`, freezes the swap |
| `POST /swaps/:id/dispute/resolve` | `SETTLEMENT_ADMIN_TOKEN` | `release` (buyer wins) or `refund` (seller wins); engine co-signs the matching spend |
| `GET  /profiles/me`, `POST /profiles` | seller | payment profile CRUD (encrypted store, §8) |

New env config:

```
SETTLEMENT_CNY_RAILS=wechat,alipay,bank   # enabled methods (empty = rail off)
SETTLEMENT_CNY_REMARK_TTL=900             # seconds the remark code is valid
SETTLEMENT_CNY_CONFIRM_TIMEOUT=900        # claim → confirm deadline before dispute prompt
SETTLEMENT_CNY_MAX_CENTS=...              # per-trade cap, engine config (§7)
```

The PayPal endpoints and `POST /swaps/:id/invoice` stay; a swap picks its rail
from `wantRail` at match time and never touches both.

---

## 6. Trust & fraud model

`p2p.md` says *the fiat rail is the only source of truth*. For CNY the honest
restatement is: **the seller's confirmation is the fiat truth, and the arbiter
is the engine operator.** Both sides of that need explicit rules.

### What the seller must check (never the screenshot)

| Check | Why |
|---|---|
| Money visible in **their own** app's balance/流水 | a screenshot proves nothing; the seller's own ledger is the only receipt |
| **Amount** exact to the cent | rules out unrelated transfers |
| **Remark code** matches the swap | identifies the payer when several buyers pay the same seller |
| **Time** within the swap window | old transfers must not be replayed |
| Payer name matches the buyer's verified name (if KYC tier requires it) | kills "paid from a friend's account" ambiguity |

Confirm is one tap **after** those checks, and it is the irreversible trigger
for release — the UI must say so.

### What the buyer must do

- Pay **only** to the instructions the engine signed and delivered (§5).
  Any account change communicated outside the app is a scam attempt.
- Include the remark code and the **exact** amount.
- Keep the receipt with the **流水号** (transaction id): it is what an arbiter
  asks for, and it is visible in the seller's app too.

### Fraud cases → handling

| Case | Handling |
|---|---|
| Fake receipt, buyer never paid | seller doesn't see it in their app → never confirms → buyer's claim times out → seller (or timer) opens dispute → refund |
| Buyer paid, seller claims non-receipt → buyer appeals | arbiter asks the seller for their in-app 流水 (transaction list) for the window; the transfer either exists or it doesn't → release or seller-flag |
| Seller changes payment details mid-swap | instructions are engine-signed per swap; a mismatch is the seller's fault → buyer's signed copy + proof wins |
| Receipt from an older swap replayed | remark code is per-swap and TTL-bound; amount+time+remark must all match |
| Both parties collude to fake a trade (wash) | out of scope for a swap; limit as abuse control (§7) |

No step auto-releases on silence. Silence always resolves through the dispute
path, where the engine operator is the named third key of the 2-of-3 — which is
exactly the trust Binance P2P asks for, minus the custody (`p2p.md` §"Why the
engine is an attestor").

---

## 7. Risk controls & operations

| Control | Detail |
|---|---|
| Per-trade and per-seller daily caps | engine config, KYC-tiered (§7 tiers) |
| Bank transfer default above a threshold | best identity signal, lowest rail freeze risk |
| Velocity limits | max open swaps per DID, min seconds between claims — kills structuring and wash patterns |
| Remark-code uniqueness | one code per swap, high-entropy (not the swapId — it is guessable) |
| 冻卡 (frozen account) playbook | operator runbook: pause the seller's profile, migrate liquidity to other sellers/banks, never route through the platform's own account (the engine must hold **no CNY**, ever) |
| Seller onboarding | real-name (实名) matched to the profile's account 户名; small-value test transfer before raising limits |
| Dispute SLA | arbitration within a fixed window; the escrow keeps both parties honest while it runs |

KYC tiers (illustrative): unverified — view only; tier 1 (phone/实名) — up to a
small per-trade cap; tier 2 (id + name-matched accounts) — full limits.

**The engine must never touch CNY.** No merchant account, no collection code of
ours, no aggregate balance: buyer → seller, directly. That keeps the platform
out of the money-transmission business and is the whole reason the payout step
from `p2p.md` is deleted rather than re-implemented for CNY.

---

## 8. Data, evidence & PII

- **Payment profile** (method, 户名, account/QR, bank + card): encrypted
  engine store, party-scoped reads, **never anchored** — same rule as
  `paypalAccount`/`buyerEmail` in `p2p.md`.
- **Receipts**: durable object storage (MinIO / user Drive — the durability
  rule from `p2p.md`), the event carries only the file ref + sha256 + 流水号.
  The image itself never goes on chain and never leaves the party scope except
  to the arbiter.
- **Anchor**: `social.p2p-swap` records carry status transitions and refs only;
  the public view stays PII-redacted (`P2pSwapView` pattern, plus proof refs).
- **Replay**: `payment_proof` / `payment_confirm` are re-derivable from the
  store like the PayPal fields were; the chain record stays a signature-covered
  audit trail, not evidence.

---

## 9. Compliance note

Mainland China restricts domestic crypto trading (PBOC et al., 2021-09-24
notice). This document is a technical settlement design, not legal advice;
whether and where to offer CNY P2P — jurisdiction, user eligibility, and
geofencing — is an operator decision to make before Phase C1 ships to users.

---

## 10. Phases

| Phase | Scope | New dependencies |
|---|---|---|
| **C1 — manual-confirm MVP** | `PaymentRail` gains `wechat`/`alipay`/`bank`; `PAYMENT_CLAIMED` status; payment profiles; instructions/proof/confirm/dispute API + events; timers; UI (rail picker on orders, instruction screen, proof upload, confirm screen, appeal); e2e | none — engine, chain and UI all exist |
| **C2 — arbitration tooling** | admin dispute console (evidence viewer, seller 流水 request, one-click release/refund), seller ratings + fast-release, Expo push on claim/confirm/dispute | `SETTLEMENT_ADMIN_TOKEN` routes (exist) |
| **C3 — risk controls** | KYC tiers, caps, velocity checks, name-match on tiers, 冻卡 runbook, unusual-pattern alerts | identity provider |
| **C4 — optional automation** | corporate-seller collection (银企直联 / licensed 聚合支付 商户码) with real callbacks — **only** for seller entities that are merchants, never for personal accounts, and only with a licensed provider | external provider + license review |

C1 alone is a complete, honest product: it is how every working C2C on/off-ramp
in the region operates. C2–C4 harden it; none of them change the chain or the
escrow.

---

## 11. Test plan

- **Engine unit tests** (`services/p2p-engine/test`): the existing PayPal
  suites are the template — signed proof/confirm/dispute happy paths, confirm
  before claim (409), confirm with open dispute (409), lock re-check fails
  closed, idempotent proof overwrite, PII never in the anchored record.
- **e2e** (`e2e/playwright/tests/p2p-settlement.spec.ts` pattern): extend the
  two-wallet flow with the CNY leg — seller profile, match, lock, buyer proof
  upload, seller confirm, both legs verified on-chain (the CNY leg's assertion
  is the state machine + anchor, since there is no rail API to poll).
- **Dispute e2e**: claim → dispute → admin resolve `refund` → escrow refund
  verified on-chain.
- Java-first rule from `AGENTS.md` applies to anything touching the chain —
  but this plan changes no chain code, so no Java surface is expected.
