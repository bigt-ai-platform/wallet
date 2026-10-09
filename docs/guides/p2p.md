# P2P Settlement — Wallet-Native Cross-Rail Swap

**What this is.** A peer-to-peer swap between crypto on **Bigtangle L0** and fiat
on **PayPal** (or the CNY rails — WeChat Pay / Alipay / bank). The seller
escrows tokens in a **2-of-3 P2SH address** (seller, buyer, engine); the buyer
pays an exact-amount fiat obligation; the engine proves the payment and the
escrow releases. Every irreversible step is signed with the wallet's own PQ key,
and the engine can only ever **co-sign** a spend — it never holds your funds.

**Where.** The **P2P** screen in the wallet (sidebar → Trade → P2P). Everything
below is captured from that screen on the local demo build.

**Demo vs. live.** The screenshots come from the demo build: the engine runs in
mock-PayPal mode (stubbed invoice URLs and synthetic transaction hashes) and the
lock/verify/release legs are signed with a local engine key. The state machine,
the signatures, the append-only event log and the on-chain audit anchor are the
real thing; only the external PayPal calls and the L0 broadcast are stubbed.

**No manual "Confirm".** There is no seller "confirm" button on the PayPal rail —
the engine verifies the payment from its own evidence. (The CNY rails, which
have no webhook, use an explicit seller confirmation instead; see `docs/p2pcny.md`.)

---

## The flow at a glance

```
ACTIVE ──match──▶ MATCHED ──lock──▶ ESCROW_LOCKED ──payment──▶ PAYMENT_PENDING
                                                                     │
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED
```

| # | Step | Who acts | On-chain / engine |
|---|---|---|---|
| 1 | Seller lists a signed sell order | seller | order stored, not funded |
| 2 | Buyer matches (receive address + PayPal account) | buyer | `swapId` created, escrow address derived |
| 3 | Seller funds the 2-of-3 escrow, engine proves the lock | seller + engine | `ESCROW_LOCKED` on L0 |
| 4 | Buyer pays the exact-amount invoice and reports it | buyer | `PAYMENT_PENDING` |
| 5 | Engine verifies the payment itself | engine | `PAYMENT_VERIFIED` |
| 6 | Engine + buyer co-sign the release, tokens move | engine + buyer | `ESCROW_RELEASED` |
| 7 | Engine pays the seller via PayPal Payouts | engine | `COMPLETED` |

Every transition is anchored as a `social.p2p-swap` record on the L1-SOCIAL
chain, so the whole lifecycle is publicly auditable without exposing either
party's PayPal details.

---

## 1. The seller lists a sell order

On the **Open sells** tab, fill in the order: the token and amount you give, the
fiat price you want, the currency, the chain the tokens sit on, and the **payment
method** (PayPal or a CNY rail). Terms are locked into the order when you list
it, so this is signed with your wallet key.

![The sell-order form, PayPal rail selected](/demo/p2p/p2p-01-order-en.png)

Once listed, the order is `ACTIVE` in the engine and appears in the public order
book (it carries no personal details):

![The order is live in the book](/demo/p2p/p2p-02-active-en.png)

---

## 2. The buyer matches

The buyer opens the order and supplies the **receive address** for the released
tokens plus the **PayPal account** the invoice should bill (and an email for the
invoice). Matching commits the buyer to pay, so it is signed too:

![The buyer fills the receive address and PayPal account](/demo/p2p/p2p-03-match-en.png)

The engine creates a unique `swapId` for the lifecycle and the swap moves to
`MATCHED`, shown on the buyer's **My swaps** tab:

![The swap is MATCHED](/demo/p2p/p2p-04-matched-en.png)

---

## 3. Escrow lock — the seller funds L0

The seller sends the tokens to the deterministic 2-of-3 escrow address and
reports the transfer's `txHash`. The engine proves the lock from the chain
(`CONFIRMED`, destination `escrowAddress`, amount) and fails closed if any check
does not hold. The swap is now `ESCROW_LOCKED`:

![The seller locks the escrow](/demo/p2p/p2p-05-escrow-locked-en.png)

The buyer sees the funds secured **before** sending any fiat, and gets an
**I have paid** action once the lock is proven:

![The buyer sees the locked escrow](/demo/p2p/p2p-06-buyer-locked-en.png)

---

## 4. The buyer pays

The buyer pays the hosted PayPal invoice (PayPal holds the money — the engine
never does) and reports the payment. This is only a *hint*; the real
verification is the engine's own evidence. The swap is `PAYMENT_PENDING`, and a
timeout timer starts — if the invoice is never paid, the seller can expire and
refund the escrow without the buyer's consent:

![PAYMENT_PENDING](/demo/p2p/p2p-07-payment-pending-en.png)

---

## 5. The engine verifies the payment

No seller confirmation is involved. The engine checks the payment from its own
source and advances the swap to `PAYMENT_VERIFIED` — the escrow is now ready to
release to the buyer's receive address:

![PAYMENT_VERIFIED](/demo/p2p/p2p-08-payment-verified-en.png)

---

## 6. Release — the funds move

Release moves the escrowed tokens: the engine and the buyer each sign the spend
from the escrow output, and two signatures satisfy the 2-of-3 script. The tokens
land at the buyer's receive address and the swap is `ESCROW_RELEASED`:

![ESCROW_RELEASED](/demo/p2p/p2p-09-escrow-released-en.png)

---

## 7. Payout — the seller gets the fiat

The final step pays the seller through PayPal Payouts, and the swap reaches
`COMPLETED`:

![COMPLETED](/demo/p2p/p2p-10-completed-en.png)

The payout outcome (`SUCCESS` / `FAILED` / `HELD` / `ONHOLD`) arrives from
PayPal's webhook or is polled as a fallback; a failure can be retried from
`COMPLETED` without redoing the trade.

---

## What protects you

| Risk | Mitigation |
|---|---|
| Counterparty walks away | Funds sit in a 2-of-3 P2SH address; nobody can move them alone |
| Under- or over-payment | The invoice is exact-amount, so it either pays in full or stays unpaid |
| Fake payment claim | The engine verifies the payment itself — the payer cannot self-assert it |
| Engine goes rogue | Engine-only steps require the engine DID signature; every transition is anchored and publicly auditable |
| Chargeback after release | `PAYMENT.CAPTURE.REVERSED` sets a freeze: forward steps stop, refund/expire stay reachable |
| Dispute | `CUSTOMER.DISPUTE.*` pauses the swap until it resolves |
| Payout failure | `HELD`/`FAILED`/`BLOCKED` are first-class states; retry with the same payout reference |

---

## Going live

The demo runs against the in-repo settlement service with mock PayPal. To run
the real flow you need a PayPal business account with Payouts activated, its API
credentials and webhook id, and the escrow signer wired to the L0 broadcast
step. Until then the engine runs the same state machine without touching real
money.
