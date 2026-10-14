# P2P Settlement — CNY Swap with Seller-Confirmed Release

**Status: demo build + in-repo engine.** Everything below is the settlement flow
as built: 2-of-3 P2SH escrow on Bigtangle L0 and a seller-confirmed CNY leg
(WeChat Pay / Alipay / bank). A personal transfer has no machine-verifiable
payment event, so the seller's own statement is the fiat signal. Screenshots are
from the demo build (memory store, no chain check — the lock/release hashes are
synthetic). The design lives in `docs/p2p.md`.

This guide walks through listing USDT for sale, matching with a buyer, escrow
lock, the buyer paying CNY **directly** to the seller, the seller confirming on
their own statement, escrow release, and refund on timeout.

For the combined three-rail walkthrough (WeChat / Alipay / bank) see
[p2p-all.md](p2p-all.md) → `assets/p2p-all.pdf`.

---

## 1. Seller saves a collection profile

The seller opens **P2P → My swaps**, picks the rail (`wechat`) and enters the 收款
name and account. The profile is stored server-side under the seller's DID and
is **not** part of the public order book — it is revealed only to the matched
buyer.

![Seller saves the WeChat payment profile](assets/screenshots/p2p-cny-wechat-01-profile-en.png)

---

## 2. Seller lists USDT

Submit a DID-signed limit order to the settlement engine:

```json
{ "sellerDid": "did:key:z446G…", "giveToken": "USDT", "giveAmount": "10",
  "giveChain": "L0", "wantCurrency": "CNY", "wantAmount": "715",
  "wantRail": "wechat", "validUntil": 1791510000,
  "nonce": "…", "timestamp": 1791509100000, "signature": "…" }
```

The order is validated against the seller's DID signature. Status: `ACTIVE`; it
expires after `validUntil`.

![List a sell order with wechat / CNY](assets/screenshots/p2p-cny-wechat-02-order-en.png)

---

## 3. Buyer matches order

The buyer submits a DID-signed match, supplying the address that must receive
the escrow release. There is no account/email to collect — nothing about the
fiat rail is needed at match time:

```json
{ "orderId": "ord-…", "buyerDid": "did:key:z6Mk…",
  "receiveAddress": "mBuyer…", "nonce": "…", "timestamp": …, "signature": "…" }
```

Status: `MATCHED`. A unique `swapId` is created for the lifecycle and the
2-of-3 escrow address is derived from the seller + buyer + engine keys.

![The buyer fills the receive address](assets/screenshots/p2p-cny-wechat-03-match-en.png)

![Swap created at MATCHED](assets/screenshots/p2p-cny-wechat-04-matched-en.png)

---

## 4. Seller locks USDT in 2-of-3 escrow

The escrow address is a P2SH script with three keys — seller, buyer, engine —
and a threshold of two:

```typescript
// redeemScript = OP_2 <seller> <buyer> <engine> OP_3 OP_CHECKMULTISIG
const escrowAddress = p2shAddress(sellerPub, buyerPub, enginePub);
await L0.transfer(escrowAddress, "10");
```

The engine proves the lock with `getTransactionStatus` — `CONFIRMED`,
destination `escrowAddress`, amount 10 — and fails closed if any check does not
hold. Status: `ESCROW_LOCKED`. The buyer sees funds secured before paying.

![The seller pastes the escrow tx hash](assets/screenshots/p2p-cny-wechat-05-escrow-lock-en.png)

![ESCROW_LOCKED](assets/screenshots/p2p-cny-wechat-06-escrow-locked-en.png)

---

## 5. Buyer pulls the payment instructions

The buyer presses **Payment details**. The engine reveals the seller's profile
plus a **per-swap remark** the transfer *must* carry, the exact amount and a
deadline:

```json
{ "method": "wechat", "rail": "wechat", "accountName": "Zhang San",
  "account": "wxid_pay8888", "amount": "715", "currency": "CNY",
  "remark": "f71ade2d23e9", "payBy": 1791510060 }
```

Status: `PAYMENT_PENDING`. A timeout starts — an unpaid swap can be expired and
refunded without the buyer's consent.

![Payment instructions: 户名, account, 715 CNY, remark](assets/screenshots/p2p-cny-wechat-08-instructions-en.png)

---

## 6. Buyer pays CNY and claims with the 流水号

The buyer transfers `715 CNY` in their own WeChat app, pastes the transaction
number (流水号) into **Transaction ID**, and presses **I have paid**. The optional
receipt image is stored server-side; only its `sha256` is anchored on the swap
event.

![Transaction ID (流水号) entered](assets/screenshots/p2p-cny-wechat-09-payment-pending-en.png)

Status: `PAYMENT_CLAIMED` — the tokens are still locked. This state is the
buyer's claim and nothing more.

![PAYMENT_CLAIMED](assets/screenshots/p2p-cny-wechat-10-payment-claimed-en.png)

---

## 7. Seller confirms on their own statement

The seller's card shows the buyer's 流水号 and the remark. The seller checks
**amount + remark + time + 流水号 in their own account** (screenshots never
count) and only then presses **Confirm received**:

![Seller sees 流水号 + the confirm warning](assets/screenshots/p2p-cny-wechat-11-seller-confirm-en.png)

Status: `PAYMENT_VERIFIED`.

![PAYMENT_VERIFIED](assets/screenshots/p2p-cny-wechat-12-payment-verified-en.png)

---

## 8. Engine and seller release escrow

Two signatures satisfy the script: the seller's (presigned at lock, or a
co-sign) and the engine's. No single party can move the funds.

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await sellerKey.signInput(tx, 0),
  await engineKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

The release spend is assembled and broadcast to `receiveAddress`. Status:
`ESCROW_RELEASED`. The buyer holds the tokens; because the seller was already
paid in CNY, there is no fiat payout step — `complete` closes the swap.

![ESCROW_RELEASED](assets/screenshots/p2p-cny-wechat-13-escrow-released-en.png)

![COMPLETED](assets/screenshots/p2p-cny-wechat-14-completed-en.png)

---

## 9. Timeout or failure → refund

If the buyer never pays, the engine and the seller co-sign the same script back
to the seller:

```typescript
const scriptSig = updateScriptWithSignature(unsigned, [
  await engineKey.signInput(tx, 0),
  await sellerKey.signInput(tx, 0),
  redeemScript,
]);
await L0.submitTransaction(serialize(tx));
```

Refund needs no buyer consent and no timelock — the threshold is reached with the
other two keys. Status: `EXPIRED` → `ESCROW_REFUNDED`. Neither party ever holds
the other's funds.

---

## 10. Device-side verification — the seller's own phone

The seller's own statement is the receipt; the engine can read it **automatically**
through the on-phone app
([`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp)).
WeChat hides its UI from accessibility, so for WeChat the app reads the
“收款到账” push (Alipay/bank expose the screen).

Pairing is a **short single-use code** the app shows on its Server screen: enter
the endpoint and the code in the wallet's **Device** screen (**Pair with code**)
or dai's **Mobile** page — the app returns a per-device token
(`POST /pair/claim`); revoke it in Settings › Access › Paired devices.

Under `SETTLEMENT_CNY_AUTO_RELEASE_ON=seller_receipt` the engine can then
machine-confirm without the manual tap.

## Comparison: Binance P2P vs this settlement

| Feature | Binance P2P | This settlement |
|---|---|---|
| Fiat verification | Seller clicks "Confirm" (honor system) | Seller confirms on their own statement; the engine enforces the protocol |
| Fiat custody | P2P (buyer → seller) | P2P (buyer → seller) — the engine never touches fiat |
| Escrow | Internal ledger | 2-of-3 P2SH on Bigtangle L0 (verifiable) |
| Refund | Support ticket | Engine + seller co-sign, no buyer consent |
| Dispute resolution | Human support (days) | Chain tx proof + proof store + per-swap remark (minutes) |

---

## Complete timeline

```
MATCHED          14:20:00  Amount fixed at match
ESCROW_LOCKED    14:23:15  L0 tx CONFIRMED at the 2-of-3 address
PAYMENT_PENDING  14:24:00  instructions issued (account + remark f71ade2d23e9)
PAYMENT_CLAIMED  14:25:10  buyer pasted 流水号 4200001234567890
PAYMENT_VERIFIED 14:26:40  seller confirmed on their own WeChat statement
ESCROW_RELEASED  14:27:20  seller + engine co-signed spend to receiveAddress
COMPLETED        14:27:21  no fiat payout — the seller already holds the CNY
```

---

## Full demo flow

```typescript
// 1. Seller saves a CNY collection profile            (POST /profiles)
// 2. Seller submits a signed limit order              (POST /orders)
// 3. Buyer matches with a signed match                (POST /orders/:id/match)
// 4. Seller funds 2-of-3 P2SH escrow on L0; engine proves it (escrow_lock)
// 5. Buyer pulls the payment instructions             (POST /swaps/:id/payment-instructions)
// 6. Buyer pays in WeChat and claims the 流水号        (POST /swaps/:id/proof)
// 7. Seller confirms on their own statement           (POST /swaps/:id/confirm)
// 8. Seller + engine co-sign the release              (POST /swaps/:id/transitions, action: release)
// 9. Engine completes the swap                        (…/transitions, action: complete)
```

Key difference from Binance P2P: funds sit in a 2-of-3 script neither party
controls alone, every transition is anchored on L1-SOCIAL, and the seller's own
statement — not a support ticket — is the fiat truth.
