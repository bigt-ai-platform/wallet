# P2P settlement — 2-of-3 PQ escrow + PayPal rail (wallet-owned)

**Status: designed and built in-repo, not yet live.** The reference
implementation lives in `services/p2p-engine` (moved here from dai's
`services/settlement`): state machine, whole-body signed API, RSA-verified
PayPal webhook, invoice + payout legs, reversal/dispute freezes and chain
anchoring. It runs in mock mode; before it moves real money it still needs the
PayPal account/keys (prerequisites 1-2), the scriptSig broadcast wiring (4) and
a shared nonce store (5).

This document is the **wallet's** design doc for the whole feature. It was
previously `../dai/docs/p2p.md`; the feature has moved entirely into this repo.
**dai no longer has any P2P surface** — no `p2p_*` tools, no client, no
`social.p2p-swap` record type, no indexer projection, no projector (see
*Removed from dai*).

Escrow is on **Bigtangle L0**; swap audit events are anchored on the
**L1-SOCIAL** chain; fiat verification is against the **real PayPal API**; and
there is no manual confirmation anywhere.

**Paths.** Java citations are package-relative to a root under `../blockchain`:
`core/` = `bigtangle-core/src/main/java/net/bigtangle/`, `srv/` =
`bigtangle-servercore/src/main/java/net/bigtangle/`, `l0/` =
`layer0-server/src/main/java/net/bigtangle/`. Everything else is a full path
from the repo that owns it.

---

## Ownership after the move

| Concern | Home |
|---|---|
| On-chain escrow (redeem script, P2SH address, signed release/refund spends) | `packages/bigtangle-ts` → `Escrow.ts` |
| Settlement engine (orders, swaps, fiat, state) | `services/p2p-engine` |
| `social.p2p-swap` record contract (build + validate) | `packages/p2p-protocol` |
| Orders / swaps UI (Binance-P2P style) | `expo-app` |
| User guide + PDFs (12 languages) | this repo |
| Agent surface | **none** — removed from dai |

The split is by layer: the on-chain half and the client that holds keys live in
the wallet; the service half (PayPal secrets, webhooks, a database) lives in a
service that must not run in a client; dai is not involved.

---

## Why this shape

| Building block | Needed for | Exists? |
|---|---|---|
| Hold funds with a threshold script | escrow | ✅ `createP2SHOutputScript` / `createRedeemScript` (`core/script/ScriptBuilder.java:453-472`, ported in `packages/bigtangle-ts/.../ScriptBuilder.ts:208-349`) |
| Observe a hold from a service | lock detection | ✅ multisig UTXOs indexed with `minsignnumber` + one `OutputsMulti` row per participant (`srv/server/service/base/ServiceBaseConnect.java:105-123`) |
| Record who consented to a spend | release audit | ⚠️ `PayMultiSign` — consent registry only (see below) |
| Assemble + broadcast the spend | release / refund | ✅ `updateScriptWithSignature` (`core/script/ScriptBuilder.java:380-429`) → `POST /submitTransaction` (`srv/server/BaseDispatcherController.java:245-251`) |
| Prove a claimed tx | lock / release evidence | ✅ `POST /getTransactionStatus` (`srv/server/BaseDispatcherController.java:375-394`) — **status and address only, no amounts** |
| Enforced refund-after-timeout | trustless refund | ❌ CLTV builders exist (`core/script/ScriptBuilder.java:484-495`) but consensus never checks that a tx's `locktime` has elapsed — no `isFinal` rule in `MempoolService.verifyTransaction` or `ServiceBaseCheck`. Not usable. |
| Fiat receipt a service can observe | payment verification | ✅ PayPal Invoices v2 + webhooks |
| Fiat payout | seller payout | ✅ PayPal Payouts v1 |

Two alternatives were rejected:

- **L1 order-book escrow** — real on-chain deadline and automatic refund
  (`timeoutOrdersToCancelled` → `payoutCancelledOrders`,
  `srv/server/service/base/ServiceBaseOrder.java:567-577,524-533`, capped by
  `ORDER_TIMEOUT_MAX = 8h`, `core/params/NetworkParameters.java:198`), but
  matching is anonymous price/time priority inside a `TradePair`: no named
  counterparty, so it cannot bind a specific buyer to a specific fiat
  obligation.
- **Engine custodial hot wallet** — fully automatable, but the engine
  custodying user funds is the thing the design avoids.

---

## Chains — no protocol change

The feature uses the two chains that already exist, each as-is:

- **L0 (base chain) — escrow.** A plain 2-of-3 `OP_CHECKMULTISIG` P2SH output,
  funded by an ordinary transfer and spent by assembling a scriptSig and
  broadcasting. No new command, no consensus change. **PQ works today:**
  `Script.executeMultiSig` detects the `0x05` pubkey prefix and calls
  `PQScriptUtils.verifyPQ` instead of `ECKey.verify`
  (`core/script/Script.java` `executeMultiSig` ~L1521, `executeCheckSig`
  ~L1422); the TS `PQKey.getPubKey()` emits the prefixed key.
- **L1-SOCIAL — audit records.** The social chain's ingestion gate
  (`l1-social-server/.../DispatcherController.promoteSocialRecord`) accepts any
  record whose `type` starts with `"social."` and that has `from`/`to`, and
  stores the raw record JSON. `social.p2p-swap` therefore passes with **no Java
  change**. Because dai no longer knows the type, the wallet's own rebuild
  watcher owns validation and projection of the record.

The only *chain-level* work is a later phase, not required here:

- **Trustless timelock refund (phase 4)** — dropping the engine key for 2-of-2 +
  timelock requires an `isFinal` rule in `MempoolService.verifyTransaction` and
  `ServiceBaseCheck`. That is consensus-breaking and needs a coordinated
  upgrade. Phase 1-3 keep the engine as co-signer precisely to avoid it.
- Hard-whitelisting `social.p2p-swap` (instead of "any `social.*`") would be a
  validation-list edit in the L1 social server — still not consensus.

---

## Architecture

```
  buyer                     p2p-engine (wallet)                       seller
    │                                │                                   │
    │ 1. match order (DID-signed)    │                                   │
    │───────────────────────────────▶│                                   │
    │                       2. fund 2-of-3 P2SH escrow on L0             │
    │                                │◀──────────────────────────────────│
    │            3. POST /getTransactionStatus → CONFIRMED + address + amount
    │                                │                                   │
    │ 4. POST /v2/invoicing/invoices │                                   │
    │◀───────────────────────────────│                                   │
    │    pays hosted invoice         │                                   │
    │───────────────▶ PayPal ───────▶│  5. INVOICING.INVOICE.PAID webhook
    │                                │     (RSA-verified, idempotent)    │
    │                                │ 6. engine + buyer co-sign release │
    │                                │     → POST /submitTransaction      │
    │                                │──────────────────────────────────▶│ (tokens)
    │                                │ 7. POST /v1/payments/payouts      │
    │                                │◀──────────────────────────────────│ (USD)
    │                                │                                   │
    │                                │ 8. anchor social.p2p-swap on L1-SOCIAL
```

Two outbound dependencies, no Ethereum:

| Dependency | Protocol | Endpoint |
|---|---|---|
| Bigtangle L0 node | JSON over HTTP | `submitTransaction`, `getTransactionStatus`, `getOutputs`, `getBalances`, `launchPayMultiSign`, `payMultiSign`, `getPayMultiSignAddressList` |
| Bigtangle L1-SOCIAL | JSON over HTTP | `submitTransaction` with `dataclassname="SocialRecord"` (audit anchor) |
| PayPal | REST + webhooks | `https://api-m.paypal.com` (live) / `https://api-m.sandbox.paypal.com` (sandbox) |

Node auth is off on a stock node (`server.permissioned=false`,
`server.ipcheck=false` — `srv/server/config/ServerConfiguration.java:155,271`).

---

## Escrow: 2-of-3 P2SH on L0

Three keys, threshold two: **seller**, **buyer**, **engine**. Keys are ML-DSA
(`PQKey`), the wallet's default key type.

```
redeemScript = OP_2 <sellerPubKey> <buyerPubKey> <enginePubKey> OP_3 OP_CHECKMULTISIG
outputScript = P2SH(sha256hash160(redeemScript))
escrowAddress = outputScript.toAddress()
```

Keys are placed in lexicographic order inside the redeem script
(`createRedeemScript`), so all three parties derive the same script from the
same key set and the escrow address is **deterministic per swap**. The wallet's
`Escrow` class (`packages/bigtangle-ts/.../wallet/Escrow.ts`, exported from the
package) builds the redeem script, the P2SH output and address, and the signed
release/refund spends (`createSpend`/`signInput`/`buildRelease`/`buildRefund`),
Java-parity tested under `packages/bigtangle-ts/test/wallet/EscrowTest.test.ts`.

### Lock — step 2

The seller sends `giveAmount` of `giveToken` to `escrowAddress` with an ordinary
transfer. Nothing about the swap is encoded in the funding tx. The engine learns
the hold exists from the index: `ServiceBaseConnect` sets
`minsignnumber = script.getNumberOfSignaturesRequiredToSpend()` and inserts one
`OutputsMulti(txHash, toAddress, index)` row per participant pubkey
(`srv/server/service/base/ServiceBaseConnect.java:105-123`).

Registration is optional bookkeeping via `launchPayMultiSign`, which is **only**
a consent registry: it validates nothing beyond "this output was indexed as
multisig" (`srv/layer0/service/PayMultiSignService.java:46-52`); its threshold
check is an advisory boolean (`PayMultiSignService.java:98-106`); and no code
anywhere assembles the collected fragments into a scriptSig — the engine does
that itself.

### Confirm — step 3

Lock is not "claimed", it is **proved**, and it fails closed:

```
POST /getTransactionStatus {"txHash": "..."}
→ { status, blockHash, chainlength, address, createdTime, updatedTime }
```

Accept only when all hold: `status === "CONFIRMED"` (derived from
`store.isBlockConfirmed`, so reorg-safe on read); `address === escrowAddress`;
and the **amount** matches `giveAmount` — the latter is *not* in that response,
so pull it from `getOutputs` / `getBalances` for the escrow outpoint. The
engine's chain-evidence check fails closed on any shortfall.

### Release — step 6

Payment verified → the engine and the buyer each sign the spend from the escrow
output to the buyer's `receiveAddress`; two signatures satisfy the script.

```
scriptSig = <sig_buyer> <sig_engine> OP_0 <redeemScript>
tx       = spend(escrowOutpoint, scriptSig, sequence=0xFFFFFFFF)
POST /submitTransaction  (raw serialized bytes)
```

Assembly uses `updateScriptWithSignature`; the precedent is the bridge vault
(`../blockchain/bigtangle-bridge/.../BridgeService.java:144,191`).

### Refund — timeout or failure

Same script, different second signer: **engine + seller** → back to the seller.
The buyer cannot block it, and neither party ever holds the other's funds.

This is the reason for 2-of-3 with the engine as one key: release and refund are
both reachable without the counterparty's cooperation and without a timelock, so
the missing consensus `isFinal` rule never comes into play.

### Why the engine is an attestor, not a custodian

The engine holds **no funds** — its key can only co-sign a spend that goes
somewhere. It is trusted to co-sign release only after verified fiat, to co-sign
refund only after timeout/failure, and not to collude. That is the trust Binance
P2P asks for, minus the custody.

---

## Fiat leg: PayPal

### Inbound — Invoices v2 (primary)

PayPal webhooks are **app-scoped**: a buyer manually sending USD to the
merchant's address fires **no webhook**. The engine therefore originates the
payment resource:

```
POST /v2/invoicing/invoices
  { invoice_number: swapId,                   // idempotent correlation
    primary_recipient: { billing_info: { email: buyerPaypalAccount } },
    amount: { currency_code: "USD", value: wantAmount },
    payment_terms: { term: "NO_DUE_DATE" } }
POST /v2/invoicing/invoices/{id}/send         → hosted URL handed to the buyer
GET  /v2/invoicing/invoices/{id}              → poll fallback
```

`INVOICING.INVOICE.PAID` then fires on the subscribed webhook. The invoice is
for an **exact amount**, removing the partial-payment case. Issued best-effort
inside `escrow_lock` when the match carried an optional `buyerEmail` (a
settlement-only field — PII stays in the event store and is never anchored),
correlated by `invoice_number = swapId`, with `POST /swaps/:swapId/invoice` as
an idempotent admin retry. An issuance failure never blocks the lock.

### Inbound fallback — Transaction Search v1

```
GET /v1/reporting/transactions?transaction_status=S
    &transaction_amount=101.00&transaction_currency=USD
    &start_date=...&end_date=...              // max window 31 days
```

Poll for swaps past `PAYMENT_PENDING` that received no webhook. Caveats:
`transaction_id` is **not unique**, and the default
`balance_affecting_records_only=Y`.

### Webhook verification

It is **not HMAC-SHA256**. PayPal signs with `SHA256withRSA` over a
pipe-delimited string containing a CRC32 of the raw body:

```
message = `${PAYPAL-TRANSMISSION-ID}|${PAYPAL-TRANSMISSION-TIME}|${webhookId}|${crc32Decimal(rawBody)}`
verify  = RSA-SHA256(pubkeyFrom(PAYPAL-CERT-URL), message) == base64(PAYPAL-TRANSMISSION-SIG)
```

`webhookId` comes from the subscription record, never the request. Never
re-serialize the body before the CRC32. Dedup key is `event.id`; duplicates are
guaranteed, so the handler must be idempotent.

Events that matter:

| Event | Meaning | Action |
|---|---|---|
| `INVOICING.INVOICE.PAID` | buyer's money landed | → verify → release |
| `PAYMENT.CAPTURE.REVERSED` | PayPal clawed the capture back | freeze; refund if still locked |
| `CUSTOMER.DISPUTE.CREATED` / `.UPDATED` / `.RESOLVED` | dispute opened | pause the swap |
| `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` / `.FAILED` / `.HELD` | our payout outcome | → `COMPLETED` / retry / surface |

Note: `PAYMENT.REVERSED` does not exist, and `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`
is the real name (an **outbound** event, never the signal the buyer paid).

### Outbound — Payouts v1

```
POST /v1/payments/payouts
  PayPal-Request-Id: swapId                    // dedupe this request
  { sender_batch_header: { sender_batch_id: swapId,
                           email_subject: "…" },
    items: [{ recipient_type: "EMAIL", receiver: sellerPaypalAccount,
              sender_item_id: swapId,
              amount: { value: wantAmount, currency: "USD" } }] }
→ 201 { batch_header: { payout_batch_id } }

GET /v1/payments/payouts/{payout_batch_id}          // SUCCESS|PENDING|PROCESSING|DENIED|CANCELED
GET /v1/payments/payouts-item/{payout_item_id}      // SUCCESS|FAILED|PENDING|UNCLAIMED|RETURNED|ONHOLD|BLOCKED
```

Auth is OAuth2 client-credentials (`POST /v1/oauth2/token`, `Basic
base64(CLIENT_ID:CLIENT_SECRET)`, cached until `expires_in`). Sandbox and live
are **separate apps** — separate credentials and webhook IDs.

---

## Protocol

### State machine

```
ACTIVE ──match──▶ MATCHED ──lock+confirm──▶ ESCROW_LOCKED ──invoice issued──▶ PAYMENT_PENDING
                                                                  │
                                                  invoice PAID ◀──┘
PAYMENT_PENDING ──verify──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──payout──▶ COMPLETED

any pre-release state ──timeout / failure──▶ EXPIRED ──refund──▶ ESCROW_REFUNDED
any pre-release state ──either party──▶ CANCELLED
```

`ESCROW_REFUNDED` must be reachable from `allowedActions`.

### Steps

| # | Step | Who acts | Evidence |
|---|---|---|---|
| 1 | Seller posts a signed limit order (`giveChain: "L0"`) | seller | DID signature over sorted-key JSON |
| 2 | Buyer matches: `receiveAddress`, `paypalAccount` | buyer | DID signature over sorted-key JSON |
| 3 | Seller funds the 2-of-3 P2SH escrow | seller | `CONFIRMED` + `address === escrowAddress` + amount |
| 4 | Engine issues a PayPal invoice for `wantAmount`, invoice number = `swapId` | engine | — |
| 5 | Buyer pays the hosted invoice | buyer | `INVOICING.INVOICE.PAID`, RSA-verified, deduped on `event.id` |
| 6 | Engine + buyer co-sign the release spend, broadcast | engine + buyer | tx reaches `CONFIRMED` at `receiveAddress` |
| 7 | Engine pays the seller via Payouts v1 | engine | `PayPal-Request-Id` = `swapId`, item `SUCCESS` |
| 8 | Audit anchor | engine | `social.p2p-swap` record on L1-SOCIAL |

No step waits on a human. Step 8 anchors every event as a `social.p2p-swap`
record signed with `P2P_ENGINE_KEY` and submitted to the L1-SOCIAL chain, **fail
closed** (an anchor failure fails the transition).

### Wallet-facing reads

The order book is public: open sell orders carry no PII, so the app lists them
with an unauthenticated `GET /public/orders?status=ACTIVE` (the seller's
signature is stripped from the response). Everything else the app reads is
party-scoped and signed with the wallet's PQ key, like the mutations:
`POST /swaps/mine` returns only swaps where the caller is the seller or buyer,
and `POST /swaps/get` returns one swap the caller is a party to (403 otherwise).
Both go through the same whole-body signature check and PII-redacted view as the
admin routes. The engine's own admin routes (`GET /orders`, `GET /swaps`,
`GET /swaps/:swapId`, invoice/payout-sync) stay behind `SETTLEMENT_ADMIN_TOKEN`
and are never called by the app.

### Rate lock

A real implementation needs an oracle and a deviation threshold before
`escrow_lock`; the invoice amount is fixed at match time either way, so the
on-chain and fiat legs are always denominated consistently.

---

## Trust model

| Party | Holds | Can do | Cannot do |
|---|---|---|---|
| Seller | own key | fund escrow, co-sign refund | move escrowed funds alone |
| Buyer | own key | pay invoice, co-sign release | move escrowed funds alone; fake payment |
| Engine | attestor key + PayPal merchant | co-sign release/refund, create invoice, pay out | spend without a second signature; forge a PayPal event (RSA + webhookId) |
| PayPal | fiat ledger | report/hold/reverse | move tokens |

Residual risks, stated rather than hidden:

- **Engine collusion** — engine + one party can move funds against the other.
  Mitigation is the observable on-chain audit trail plus the fact that any spend
  is visible at `escrowAddress`.
- **Chargeback after release** — the window between `PAYMENT_VERIFIED` and
  `ESCROW_RELEASED` must be sub-minute; after release,
  `PAYMENT.CAPTURE.REVERSED` is a dispute, not an automatic refund.
- **Payout failure is normal, not exceptional** — `HELD`, `BLOCKED`,
  `UNCLAIMED`, `CIP_NOT_VERIFIED`, `INSUFFICIENT_FUNDS` are first-class states.

---

## Failure recovery

| Failure | Handling |
|---|---|
| PayPal invoice never paid | timer → engine + seller co-sign refund → `EXPIRED` → `ESCROW_REFUNDED`. No buyer consent needed. |
| L0 node unreachable at confirm time | retry with backoff; while unreachable, **fail closed** |
| Webhook lost | PayPal retries 25×/3 days, then manual `.../resend`; Transaction Search polling is the independent second path |
| Payout returns `FAILED` / `HELD` | retry with the **same** `PayPal-Request-Id` and `sender_batch_id`; surface the PayPal error name to the operator |
| Wrong amount paid | invoice is exact-amount, so this resolves to "invoice unpaid" → timeout → refund |
| Node down after release | tokens are already at `receiveAddress`; the swap is `ESCROW_RELEASED`, payout retries independently |

---

## Data model & durability

- Swap state is an **append-only event log** (`p2p_swap_events`) that can be
  replayed, not rows mutated in place. Postgres is a rebuildable projection.
- Each event is signed with `P2P_ENGINE_KEY` and anchored on L1-SOCIAL as a
  `social.p2p-swap` record; the wallet's own rebuild watcher validates and
  projects it.
- The record contract lives in `packages/p2p-protocol`:
  `P2P_SWAP_STATUSES`, `P2pSwapRecord`, `p2pSwapRecord()`,
  `validateP2pSwapRecord()`. Amounts are decimal strings; `swapSeq` orders
  events per swap; `to` is the opaque `swapId`.
- **The model never supplies trusted evidence** — signatures are produced by the
  service, and claimed transactions are re-checked against the node (status,
  destination address **and amount**).
- PII (buyer/seller PayPal emails) stays in the wallet's encrypted store and is
  **never anchored**.

---

## Prerequisites — not built

1. **PayPal business account with Payouts activated.** Human process (identity
   verification, linked funding source, then contact PayPal support). Budget
   calendar time.
2. **`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID`.**
3. **Webhook route** — RSA-signed, raw-body, `timingSafeEqual`, idempotent on
   `event.id` (implemented in `services/p2p-engine`, `POST /webhooks/paypal`).
4. **Escrow signer** — engine key management, plus the scriptSig assembly and
   `submitTransaction` broadcast wiring. ScriptSig assembly ships in
   `bigtangle-ts` `Escrow`; still open: engine key management + broadcast.
5. **Shared nonce + rate-limit store** — process-local today, so it resets on
   restart and is wrong with more than one instance.
6. **PayPal account/keys and a shared nonce store** for real money.

---

## Repos

| Repo | Scope |
|---|---|
| **`../blockchain`** | Java protocol oracle — P2SH multisig, PQ verify, `PayMultiSign`, `getTransactionStatus`, `submitTransaction`, L1-SOCIAL ingestion. Anything the TS port does must be proven against it. |
| **`../wallet` → `packages/bigtangle-ts`** | the TS protocol port and the client that holds keys — it owns the on-chain half of escrow. Ships `Escrow`, `ScriptBuilder.createRedeemScript` / `createP2SHOutputScript*` / `updateScriptWithSignature`, `RedeemData`, `Wallet.payToScript`, `core/PayMultiSign*`. |
| **`../wallet` → `services/p2p-engine`** | the settlement engine: orders, swaps, whole-body signed API, PayPal Invoices/Payouts + RSA webhook, append-only events, chain anchor. |
| **`../wallet` → `packages/p2p-protocol`** | the `social.p2p-swap` record contract (build + validate). |
| **`../wallet` → `expo-app`** | the P2P UI (Binance-P2P style) + co-sign release/refund screens. |
| **`../wallet` → docs** | this document + the user guide/PDFs. |
| **dai** | **nothing** — the agent surface was removed. |
| **PayPal** | Invoices v2, Payouts v1, Webhooks v1, Transaction Search v1. |

Why not one repo: the engine needs PayPal merchant secrets, webhooks and a
database — a client app must not hold any of those, so the on-chain code and the
engine cannot share a home just because they share a feature. The escrow script
is a wallet capability, so it lives in `bigtangle-ts`.

---

## Phases

1. **On-chain escrow in `bigtangle-ts`** — *delivered:* `Escrow` (2-of-3 redeem
   script, P2SH output + address, signed release/refund spends), Java-parity
   tested. Optional: the wallet app co-sign screen.
2. **Settlement engine in `services/p2p-engine`** — *moved from dai:* Fastify +
   schema (`p2p_orders` / `p2p_swap_events`), append-only events, whole-body
   signed requests, engine-only signer for `verify`/`release`/`payout`, PayPal
   Invoices v2 in / Payouts v1 out + RSA webhook, and the step-8 L1-SOCIAL
   anchor. Still to run for real: prerequisites 1-2, 4, 5.
3. **UI + guide** — Binance-P2P-style order book / order detail / match /
   co-sign screens in the wallet app; the guide moves here in all 12 languages.
4. **Drop the engine key** → 2-of-2 + timelock. **Blocked on protocol work:**
   consensus needs an `isFinal` rule (reject txs whose `locktime` is in the
   future) in both `MempoolService.verifyTransaction` and `ServiceBaseCheck`.
   Consensus-breaking; needs a coordinated upgrade.
5. **Distributed matching** — the L1 order book for the crypto/crypto leg, with
   the cross-rail fiat obligation still settling through the service.

---

## Invariants

- **Durability** — only chain, user Drive and MinIO are durable. Swap state is
  an append-only event log that can be replayed; Postgres is a projection.
- **Never write the projection directly** — durable output is anchored on chain
  (`social.p2p-swap`), not inserted into serving tables.
- **The fiat rail is the only fiat source of truth** — no manual confirmation;
  a state advances only on a verified PayPal event or a proven chain tx.
- **Fail closed** — an unreachable node or an unverified webhook never advances
  a state.
- **No consensus change for phases 1-3.**

---

## Removed from dai

The following were deleted from `../dai` as part of this move:

- `services/dai/src/tools.ts` — the seven `p2p_*` tools + approval entries.
- `services/dai/src/p2p.ts` + `test/p2p.test.ts` — the engine client.
- `services/settlement/**` → moved to `services/p2p-engine`.
- `packages/core/src/records.ts` — the `social.p2p-swap` type, statuses, fields
  and `p2pSwapRecord` builder; `recordSig.ts` policy; `core/test`.
- `services/graph-indexer` — `validate`/`targetKind`/projection (PG +
  MemGraph) + `test/p2p-swap.test.ts`.
- `deploy/schema.sql` + p2p migrations — `p2p_swaps` table and the `edges`
  CHECK entry.
- web docs `apps/web/src/app/docs/guides/p2p*.md`, PDFs, i18n guide entries,
  `e2e/playwright/tests/p2p*.spec.ts`, `test/p2p/**`.

Because the type never shipped live, this is a safe narrowing; any database that
applied the p2p migration gets a small forward migration dropping `p2p_swaps`
and re-adding the `edges` CHECK without p2p.
