# P2P Settlement — Cross-Rail Swap with AI Verification

**Status: target design, not built.** Everything below is the settlement flow we are building: 2-of-3 P2SH escrow on Bigtangle L0 and real PayPal API verification. The demo build running today is a state machine over Postgres with a mocked fiat leg. Screenshots are from that demo build; the design lives in the dai repo, `docs/p2p.md`.

This guide demonstrates the AI-native P2P settlement flow: listing USDT for sale, matching with a buyer, escrow lock, fiat payment with automated verification, escrow release, and refund on timeout. No manual "Confirm" button — the Settlement Engine verifies payment from a PayPal webhook.

For the **CNY rails** (WeChat Pay / Alipay / bank — where there is no webhook, so the seller's own confirmation *is* the fiat signal) see [p2p-cny.md](p2p-cny.md) → `assets/p2p-cny.pdf`.

---

## 1. Dashboard Overview

The P2P dashboard shows all active swaps with their current status, rate, and transaction references.

![Dashboard](demo-output/screenshots/p2p-dashboard-en.png)

The dashboard shows all active swaps with status, rate, and transaction references. Each card displays the swap ID, asset pair (e.g. 100 USDT ⇄ 101 USD), color-coded status badge, and expandable timeline.

---

## 2. Seller Lists USDT

Submit a DID-signed limit order to the Settlement Engine.

```typescript
const signature = signPayload(
  { sellerDid, giveToken: "USDT", giveAmount: "100",
    giveChain: "L0", wantCurrency: "USD",
    wantAmount: "101", wantRail: "paypal" },
  sellerPriv,
);
```

The seller submits a signed limit order: sell 100 USDT for $101 USD via PayPal. The Settlement Engine validates the DID signature. Status: ACTIVE. Order expires after validUntil.

---

## 3. Buyer Matches Order

Buyer submits a signed market order. Rate is locked at match time via an oracle, and the invoice amount is fixed from this moment.

```typescript
const signature = signPayload(
  { orderId, buyerDid, amount: "100",
    receiveAddress, paypalAccount },
  buyerPriv,
);
```

The buyer matches the order with a DID-signed market order, supplying the address that must receive the escrow release and the PayPal account to be paid. Status: MATCHED. A unique swapId is created for the lifecycle.

---

## 4. Seller Locks USDT in 2-of-3 Escrow

The escrow address is a P2SH script with three keys — seller, buyer, engine — and a threshold of two.

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "100");
```

The seller funds the escrow address on Bigtangle L0. The Engine proves the lock with `getTransactionStatus` — `CONFIRMED`, destination `escrowAddress`, amount 100 — and fails closed if any of the three checks does not hold. Status: ESCROW_LOCKED. The buyer sees funds secured before sending fiat.

---

## 5. Engine Issues Invoice, Buyer Pays via PayPal

The Engine creates an exact-amount PayPal invoice and hands the hosted URL to the buyer.

```typescript
const res = await fetch("/api/p2p/payments/invoice", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", currency: "USD" }),
});
// → hosted checkout URL; invoice number = swapId
```

The buyer pays the hosted invoice. The Engine does not touch the money — PayPal holds it. No seller confirmation needed. Status: PAYMENT_PENDING. Timeout timer starts.

---

## 6. Engine Auto-Verifies Payment

**Key innovation**: no human "Confirm" button. Payment is proved by PayPal, not asserted by a party.

```typescript
// POST /api/webhooks/paypal — SHA256withRSA over transmissionId|time|webhookId|crc32(body)
const ok = verifyPayPalWebhook(rawBody, headers);
if (ok) await transitions(swapId, "verify");
```

The Engine verifies the `INVOICING.INVOICE.PAID` webhook, deduplicated on `event.id`. This replaces Binance P2P's manual "Confirm" button. No seller can lie about non-receipt. Status: PAYMENT_VERIFIED.

---

## 7. Engine and Buyer Release Escrow

Two signatures satisfy the script: the buyer's and the engine's. No single party can move the funds.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await buyerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

The release spend is assembled and broadcast to `receiveAddress`. Status: ESCROW_RELEASED. The buyer now holds the tokens; the engine's remaining job is the fiat payout.

---

## 8. Engine Payouts Seller

The Engine sends USD to the seller's PayPal through Payouts v1, idempotent on the swap.

```typescript
const res = await fetch("/api/p2p/payments/payout", {
  method: "POST",
  body: JSON.stringify({ swapId, amount: "101", paypalAccount: sellerPaypal }),
});
// → PayPal-Request-Id: swapId, sender_batch_id: swapId
```

The Engine sends USD to the seller's PayPal. Swap COMPLETED. Total time: ~3-5 minutes. All DID-signed, every step auditable on chain or at PayPal.

---

## 9. Timeout or Failure → Refund

If the invoice is never paid, the engine and the seller co-sign the same script back to the seller.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Refund needs no buyer consent and no timelock — the threshold is reached with the other two keys. Status: EXPIRED → ESCROW_REFUNDED. Neither party ever holds the other's funds.

---

## 10. History View

Completed, expired, and cancelled swaps are visible in the history page.

![History](demo-output/screenshots/p2p-history-en.png)

The history page lists completed, expired, and cancelled swaps. Each entry shows the asset pair, final status, timeline steps, and party DIDs.

---

## Comparison: Binance P2P vs AI Settlement

| Feature | Binance P2P | AI Settlement |
|---------|-------------|---------------|
| Fiat verification | Seller clicks "Confirm" (honor system) | PayPal webhook, RSA-verified (deterministic) |
| Fiat custody | P2P (buyer → seller) | PayPal holds until payout (buyer → PayPal → seller) |
| Escrow | Internal ledger | 2-of-3 P2SH on Bigtangle L0 (verifiable) |
| Refund | Support ticket | Engine + seller co-sign, no buyer consent |
| Dispute resolution | Human support (days) | On-chain tx proof + PayPal event (minutes) |

---

## Complete Timeline

```
MATCHED          14:20:00  Rate locked, invoice amount fixed
ESCROW_LOCKED    14:23:15  L0 tx CONFIRMED at the 2-of-3 address
PAYMENT_PENDING  14:24:00  Invoice INV-7f3c91 issued
PAYMENT_VERIFIED 14:24:10  INVOICING.INVOICE.PAID webhook, RSA-verified
ESCROW_RELEASED  14:24:30  Co-signed spend to receiveAddress
COMPLETED        14:25:00  Payout batch PAYOUT-abc SUCCESS
```

---

## Full Demo Flow

```typescript
// 1. Seller submits signed limit order (POST /api/p2p/orders)
// 2. Buyer matches with signed market order (POST /api/p2p/orders/:id/match)
// 3. Seller funds 2-of-3 P2SH escrow on L0; engine proves it (getTransactionStatus)
// 4. Engine issues a PayPal invoice; buyer pays (POST /api/p2p/payments/invoice)
// 5. Engine verifies INVOICING.INVOICE.PAID webhook (POST /api/webhooks/paypal)
// 6. Engine + buyer co-sign the release spend (POST .../transitions, action: release)
// 7. Engine payouts seller (POST /api/p2p/payments/payout)
// 8. Both parties see COMPLETED status on dashboard
```

Key difference from Binance P2P: **no seller "Confirm" button.** Payment is proved by a PayPal webhook and funds sit in a 2-of-3 script neither party controls alone — deterministic, auditable, instant.
