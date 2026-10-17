# P2P settlement — 2-of-3 PQ escrow, seller-confirmed release (CNY rails)

**Status: the wallet UI and guide are built and shipped; the engine is in-repo
but not yet live.** The happy path is **seller-confirmed, seller-released** and
is the *same shape on every fiat rail*: the buyer pays the seller directly, the
seller confirms receipt in their own bank / WeChat / Alipay app, and
the seller + engine co-sign the release spend. The client is complete in
`expo-app/sources/screens/p2p/P2pScreen.tsx` — a Binance-P2P-style book (open
sells / my swaps), order creation with token search and a rail picker, order
match, payment profile, payment instructions, receipt/proof submission,
confirm/dispute, and the lock / expire / refund / cancel transitions. The user
guide ships in 12 languages (`docs/guides/p2p*.md`) with published PDFs
(`docs/p2p-demo/assets/p2p*.pdf`), and step-by-step demos live under
`docs/p2p-demo/`.

The reference engine lives in `services/p2p-engine` (moved here from dai's
`services/settlement`): state machine, whole-body signed API, the CNY/manual
MVP routes (`instructions → proof → confirm → dispute`), payment profiles,
reversal/dispute freezes and chain anchoring. There is **no machine fiat
verification** — for a personal CNY transfer none is possible, so the seller's
own confirmation is the signal, and a seller presign lets the escrow close
without anyone online.

This document is the **wallet's** design doc for the whole feature — the CNY
rails (WeChat Pay / Alipay / bank). It was previously
`../dai/docs/p2p.md`; the feature has moved entirely into this repo. **dai no
longer has any P2P surface** — no `p2p_*` tools, no client, no
`social.p2p-swap` record type, no indexer projection, no projector (see
*Removed from dai*).

Escrow is on **Bigtangle L0**; swap audit events are anchored on the
**L1-SOCIAL** chain; fiat goes **buyer → seller directly, never through the
engine**; and a release happens only on the seller's own confirmation or an
arbitration outcome — never on silence, never on the buyer's claim alone.

**Paths.** Java citations are package-relative to a root under `../blockchain`:
`core/` = `bigtangle-core/src/main/java/net/bigtangle/`, `srv/` =
`bigtangle-servercore/src/main/java/net/bigtangle/`, `l0/` =
`layer0-server/src/main/java/net/bigtangle/`. Everything else is a full path
from the repo that owns it.

**Demos.** A step-by-step walkthrough of the CNY rails — WeChat
Pay, Alipay, bank — with captured screenshots:
[p2p-demo/p2p-all.md](p2p-demo/p2p-all.md) (PDF: `docs/p2p-demo/assets/p2p-all.pdf`).
The whole pipeline has one entry point,
`./p2pdemo.sh` (no chain infra): `./p2pdemo.sh` re-renders both PDFs from the
current screenshots, `./p2pdemo.sh capture` regenerates the screenshots first
(starts only a local p2p-engine + static server), and `./p2pdemo.sh all` also
rebuilds the workspace packages, engine bundle and web build.

For a **real** run — the escrow lock proved on L0 and the release spend
broadcast and CONFIRMED at the buyer's address — use `./p2pdemo.sh e2e`
(`e2e/e2etest.sh p2p-demo`) with the infra up (`e2e/infra.sh`). That spec
(`e2e/playwright/tests/p2p-demo.spec.ts`) funds a real 2-of-3 P2SH escrow,
drives the wallet UI, and the harness re-checks both legs with
`getTransactionStatus`. The e2e infra is testnet, so the engine runs with
`SETTLEMENT_NETWORK=testnet`; prod stays mainnet by default.

---

## 1. Ownership after the move

| Concern | Home |
|---|---|
| On-chain escrow (redeem script, P2SH address, signed release/refund spends) | `packages/bigtangle-ts` → `Escrow.ts` |
| Settlement engine (orders, swaps, state, arbitration execution) | `services/p2p-engine` |
| `social.p2p-swap` record contract (build + validate) | `packages/p2p-protocol` |
| Orders / swaps UI (Binance-P2P style) | `expo-app` |
| User guide + PDFs (12 languages) | this repo |
| Agent surface | **none** — removed from dai |

The split is by layer: the on-chain half and the client that holds keys live in
the wallet; the service half (a database, the dispute workflow) lives in a
service that must not run in a client; dai is not involved.

---

## 2. Why this shape

| Building block | Needed for | Exists? |
|---|---|---|
| Hold funds with a threshold script | escrow | ✅ `createP2SHOutputScript` / `createRedeemScript` (`core/script/ScriptBuilder.java:453-472`, ported in `packages/bigtangle-ts/.../ScriptBuilder.ts:208-349`) |
| Observe a hold from a service | lock detection | ✅ multisig UTXOs indexed with `minsignnumber` + one `OutputsMulti` row per participant (`srv/server/service/base/ServiceBaseConnect.java:105-123`) |
| Record who consented to a spend | release audit | ⚠️ `PayMultiSign` — consent registry only (see below) |
| Assemble + broadcast the spend | release / refund | ✅ `updateScriptWithSignature` (`core/script/ScriptBuilder.java:380-429`) → `POST /submitTransaction` (`srv/server/BaseDispatcherController.java:245-251`) |
| Prove a claimed tx | lock / release evidence | ✅ `POST /getTransactionStatus` (`srv/server/BaseDispatcherController.java:375-394`) — **status and address only, no amounts** |
| Enforced refund-after-timeout | trustless refund | ❌ CLTV builders exist (`core/script/ScriptBuilder.java:484-495`) but consensus never checks that a tx's `locktime` has elapsed — no `isFinal` rule in `MempoolService.verifyTransaction` or `ServiceBaseCheck`. Not usable. |
| Fiat receipt a human can see | payment confirmation | ✅ the seller's own bank / WeChat / Alipay app — the ledger the seller already trusts |
| Machine fiat verification | auto-release | ❌ **no counterpart exists for personal CNY transfers** (no collection API for personal accounts) |

The seller confirming their *own* balance is the strongest signal that exists
on every rail: the seller is looking at the money. No API can beat that, and
the rails that have no API (WeChat Pay, Alipay, personal bank transfer — §7)
are not a gap to engineer around — they are how most of the world's C2C
crypto-fiat volume already settles (Binance P2P, OKX C2C, Huobi C2C all run
buyer-pays-seller + seller-confirm + platform arbitration).

Three alternatives were rejected:

- **Engine-verified fiat as the only path** — impossible on personal CNY rails
  (there is no machine payment event), and it would make the engine the sole
  judge of a fact the seller can see directly.
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

## 3. Chains — no protocol change

The feature uses the two chains that already exist, each as-is:

- **L0 (base chain) — escrow.** A plain 2-of-3 `OP_CHECKMULTISIG` P2SH output,
  funded by an ordinary transfer and spent by assembling a scriptSig and
  broadcasting. No new command, no consensus change. **PQ works today:**
  `Script.executeMultiSig` detects the `0x05` pubkey prefix and calls
  `PQScriptUtils.verifyPQ` instead of `ECKey.verify`
  (`core/script/Script.java` `executeMultiSig` ~L1521, `executeCheckSig`
  ~L1422); the TS `PQKey.getPubKey()` emits the prefixed key.
- **L1-SOCIAL — the order book + audit records.** The social chain's ingestion
  gate (`l1-social-server/.../DispatcherController.promoteSocialRecord`) accepts
  any record whose `type` starts with `"social."` and that has `from`/`to`, and
  stores the raw record JSON — through the typed data-class path
  (`dataclassname="SocialRecord"`) or a legacy `social.v1` memo path — so both
  record types pass with **no Java change**:
  - `social.p2p-swap` — the engine-anchored settlement log (as before).
  - `social.p2p-order` — **seller-anchored**: the seller builds, author-signs
    and submits the order/cancel record from their own wallet key (§11), so the
    public order book is chain-derived and the engine only indexes what the
    chain already has. The record is PII-free — exactly the fields the public
    book exposes.

  Two caveats on "any `social.*`": `social.group*` records additionally run the
  group membership state machine (`SocialGroupStore`) at ingestion, and the gate
  is an *ingestion* gate only — it runs on the `submitTransaction` HTTP path;
  the `submitTransactions` batch endpoint and blocks arriving via sync bypass it
  entirely, so it is **not** consensus validation. Because dai knows neither
  type — dai has no P2P surface at all (§24) — the engine's own rebuild watcher
  (`services/p2p-engine/src/replay.ts`) owns validation and projection of the
  records; an independent wallet-side watcher for `social.p2p-swap` (client
  verification that never trusts the engine's projection) is optional later
  work (§18).

The only *chain-level* work is a later phase, not required here:

- **Trustless timelock refund** — dropping the engine key for 2-of-2 +
  timelock requires an `isFinal` rule in `MempoolService.verifyTransaction` and
  `ServiceBaseCheck`. That is consensus-breaking and needs a coordinated
  upgrade. Until then the engine is the third key precisely to avoid it.
- Hard-whitelisting `social.p2p-swap` (instead of "any `social.*`") would be a
  validation-list edit in the L1 social server — still not consensus.

---

## 4. The rails — the only difference is conflict evidence

The WeChat / Alipay / bank rails share the entire happy path (§8). The *only*
thing that differs is what evidence exists when a conflict goes to arbitration
(§12):

| | WeChat / Alipay | Bank transfer |
|---|---|---|
| Where the seller sees the money | own WeChat / Alipay app statement | own bank statement memo |
| Machine-verifiable payment event | **none — and none is possible** (no collection API for personal accounts) | **none** |
| Arbitration evidence pack | transaction id + receipt sha256 + seller's own ledger + per-swap remark code | bank transaction id + receipt sha256 + seller's ledger + per-swap remark code |
| Clawback by the sender | none — personal transfers are final | none — personal transfers are final |
| Freeze (frozen account) risk | medium–high for crypto-pattern transfers — runbook in §16 | medium–high; prefer bank for large amounts |

Order, match, escrow lock, proof, confirm, release, refund, dispute and anchor
are one protocol with one state machine (§9), one API (§11), one UI, one engine.
A swap picks its rail at match time (`wantRail`).

### CNY rail properties

| | WeChat Pay | Alipay | Bank transfer |
|---|---|---|---|
| Speed / hours | instant, 24/7 | instant, 24/7 | instant for small amounts (IBPS/online banking) 24/7; large via HVPS on banking hours |
| Transfer note (memo) | ✅ supported | ✅ supported | ✅ memo (length and charset vary by bank) |
| Receiver identity shown to sender | nickname + real-name surname | real-name account name | **full account name** — best for name-match |
| Typical use in P2P | small/medium, fast | small/medium, fast | large amounts, preferred when limits or freeze risk bite |

Recommendations: offer **all three** on every order (the seller's profile
stores which they accept); default to **bank transfer above a configurable
threshold** — the full account name on the transfer screen is the strongest identity
check, and HVPS/online banking transfers are less likely to trip WeChat/Alipay risk
controls. Never treat a **screenshot** as proof of anything by itself (§12).
Exact per-rail personal limits change often; keep them as engine config, not
constants in the app.

---

## 5. Architecture

```
  buyer                     p2p-engine                         seller
    │                            │                                │
    │ 1. match order (DID-signed)│                                │
    │───────────────────────────▶│                                │
    │                    2. fund 2-of-3 P2SH escrow on L0 ◀──────│
    │        3. getTransactionStatus → CONFIRMED + address + amount
    │                            │                                │
    │ 4. signed payment-instructions (rail, account name,          │
    │    account/QR, exact amount, remark code) ◀─────────────────│ (profile)
    │                            │                                │
    │ 5. buyer pays seller DIRECTLY on the rail, remark=code       │
    │───────────────────────────────────────────────────────────▶│
    │ (6. optional receipt → POST /swaps/:id/proof)                │
    │                            │  status → PAYMENT_CLAIMED      │
    │                    7. seller checks OWN app, POST /confirm ◀│
    │                            │  status → PAYMENT_VERIFIED    │
    │ 8. seller signature + engine key → release spend             │
    │    → POST /submitTransaction                                 │
    │◀───────────────────────────│───────────────────────────────▶│ (tokens)
    │                            │  9. anchor social.p2p-swap      │
    │                            │     on L1-SOCIAL                │
    │                            │                                │
    │ conflict in the payment phase → dispute → freeze →          │
    │ auto-rule or AI-assisted arbitration (§12) → self-executing  │
    │ release or refund (presign / winning-party cosign)           │
```

Order-book intake (§11) is chain-first: the seller anchors a signed
`social.p2p-order` on L1-SOCIAL (own key, own BIG UTXO for the zero-fee tx),
then `POST /orders {orderId, txid}` — the engine confirms the txid is
`CONFIRMED` before the index advances, and the replay watcher (§14) projects
the same record into a wiped store. A deploy without L1-SOCIAL keeps the legacy
engine-intake path (no `orderId`/`txid`, order signed into the request).

Two outbound dependencies, no Ethereum, **no fiat API on the happy path**:

| Dependency | Protocol | Endpoint |
|---|---|---|
| Bigtangle L0 node | JSON over HTTP | `submitTransaction`, `getTransactionStatus`, `getOutputs`, `getBalances`, `launchPayMultiSign`, `payMultiSign`, `getPayMultiSignAddressList` |
| Bigtangle L1-SOCIAL | JSON over HTTP | `submitTransaction` with `dataclassname="SocialRecord"` (order/cancel/audit anchor); `getTips`, `getBlockByHash`, `getTransactionStatus` (replay watcher + txid confirmation) |

Node auth is off on a stock node (`server.permissioned=false`,
`server.ipcheck=false` — `srv/server/config/ServerConfiguration.java:155,271`).

---

## 6. Escrow: 2-of-3 P2SH on L0

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

Which pair signs what:

| Spend | Signers | When |
|---|---|---|
| **Release** → buyer | **seller + engine** | seller confirmed fiat (`PAYMENT_VERIFIED`) |
| **Release** → buyer (forced) | **engine + buyer** | arbitration awards the buyer and the seller won't sign |
| **Refund** → seller | **engine + seller** | timeout / failure, a post-lock cancel, or arbitration awards the seller |

The buyer can never be *required* for a normal release (they are the payee),
and the seller can never move escrowed funds alone — which is exactly why a
hostile seller cannot both take the fiat and keep the tokens: arbitration
reaches release with engine + buyer.

### Any two keys — the cooperative path needs no engine

`OP_2 … OP_3` is symmetric: the script cannot tell the engine from a party, and
**any** two of the three keys spend it. The table above lists the pairs the
*implementation* drives, but `seller + buyer` is an equally valid set — a
`correctlySpends` case in
`packages/bigtangle-ts/test/wallet/EscrowTest.test.ts` ("every release/refund
pair shares the engine, but any two keys sign"). Consequences:

- A cooperative release/refund can settle with **no engine signature and no
  engine server in the loop**: both parties rebuild the identical deterministic
  skeleton (§6 Release, Path B), each signs the sighash with their own key, and
  one of them orders the two signatures by redeem-script position and
  broadcasts (`expo-app/sources/lib/p2pEscrowCoop.ts` — draft). Only the
  signature blobs cross the wire, never the tx bytes.
- The engine key is then required only when the parties do **not** agree, or
  cannot both be online: `engine + buyer` forces a release after arbitration and
  `engine + seller` refunds on timeout/failure, and neither party reaches either
  outcome alone. That — not the happy path — is why the third key exists without
  the consensus `isFinal` rule (§3).
- Cooperation is not a theft path: the vault holds the **seller's** tokens, so
  seller + buyer spending together only moves the seller's own funds. The
  residual risk runs the other way — an engine colluding with one party against
  the other (§13).
- The engine's escrow key (`SETTLEMENT_ENGINE_KEY`, a vault participant that
  signs spends) and the arbitration token (`SETTLEMENT_ADMIN_TOKEN`, which only
  gates the operator endpoints) are distinct roles, even when one operator holds
  both.

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

### Release — step 8

Seller confirmed fiat → the seller signs the release spend from the escrow
output to the buyer's `receiveAddress`; the engine verifies the seller's
signature over the exact skeleton bytes, adds its own key, and broadcasts. Two
signatures satisfy the script.

```
scriptSig = <sig_seller> <sig_engine> OP_0 <redeemScript>
tx       = spend(escrowOutpoint, scriptSig, sequence=0xFFFFFFFF)
POST /submitTransaction  (raw serialized bytes)
```

Assembly uses `updateScriptWithSignature`; the precedent is the bridge vault
(`../blockchain/bigtangle-bridge/.../BridgeService.java:144,191`).

The wallet closes this loop itself. Both sides rebuild the identical spend
skeleton over the confirmed lock output (same vault `[seller, buyer, engine]`,
same `escrowSpendAmount` fee rule — `../expo-app/sources/lib/p2pEscrow.ts`
mirrors the engine's `escrowSpend.ts`), so either signature verifies over the
same bytes:

- **Path B (auto)** — right after `escrow_lock` the seller calls
  `POST /escrow/presign` with a release **and** a refund signature over the
  fresh outpoint; the settle hook then finishes release/refund without the
  wallet being online. This is the seed of the automation phase (§20): the
  seller's presign is what lets the engine later release on its own evidence.
- **Path A (live)** — the seller signs the release skeleton at
  `PAYMENT_VERIFIED` (the refund skeleton at `EXPIRED`) and calls
  `POST /escrow/cosign {kind}`; the engine adds its key and broadcasts. An
  arbitration-ordered release uses the same route with the **buyer** as signer.

The skeleton needs fields the public views redact, so both paths start with
the party-scoped signed `POST /swaps/:swapId/escrow/context`
(`escrowAddress`, `escrowTxHash`, `receiveAddress`, `presigned`).

### Refund — timeout or failure

Same script, different second signer: **engine + seller** → back to the seller.
The buyer cannot block it, and neither party ever holds the other's funds.

This is the reason for 2-of-3 with the engine as one key: release and refund
are both reachable without the counterparty's cooperation and without a
timelock, so the missing consensus `isFinal` rule never comes into play.

### Why the engine is an attestor, not a custodian

The engine holds **no funds** — fiat and tokens both bypass it — and its key
can only co-sign a spend that goes somewhere. It is trusted to co-sign release
only after the seller's confirmation or an arbitration outcome, co-sign refund
only after timeout/failure/arbitration, and not to collude. That is the trust
Binance P2P asks for, minus the custody.

---

## 7. Fiat leg: buyer → seller, directly

There is no invoice, no webhook and no payout on the happy path, and for a
personal CNY transfer there never will be: WeChat Pay and Alipay expose no
collection API for personal accounts, and a natural-person bank account cannot
receive callbacks. The buyer sends a direct transfer to the seller; the engine
never touches fiat, and only enforces the protocol.

The fiat signal is therefore: **the seller attests that money is in their
account.** That is strong evidence on the seller's side (they are looking at
their own balance) and the engine's job shrinks from *verifying* the rail to
*enforcing the protocol*: confirm-then-release, dispute-then-arbitrate, always
fail closed on the chain leg.

Seller's payment instructions and the per-swap remark code are delivered
**only after `ESCROW_LOCKED`** and only to the matched buyer, through the same
whole-body signed, party-scoped reads as `POST /swaps/mine` / `/swaps/get`
(§11). The remark code is per-swap and high-entropy (not the guessable
`swapId`), TTL-bound by `SETTLEMENT_CNY_REMARK_TTL`.

---

## 8. Flow

```
  buyer                     p2p-engine                         seller
    │                            │                                │
    │ 1. match (DID-signed, wantCurrency, wantRail∈{wechat,alipay,bank})
    │───────────────────────────▶│                                │
    │                    2. fund 2-of-3 P2SH escrow on L0 ◀──────│
    │            3. getTransactionStatus → CONFIRMED + address + amount
    │                            │                                │
    │ 4. signed GET payment-instructions (rail, account name,       │
    │    exact amount, remark code) ◀─────────────────────────────│ (profile)
    │                            │                                │
    │ 5. buyer transfers fiat directly to seller, remark=code,      │
    │    uploads receipt → POST /swaps/:id/proof                   │
    │───────────────────────────▶│  status → PAYMENT_CLAIMED       │
    │                            │                                │
    │                    6. seller checks OWN app (amount + remark │
    │                       + time), POST /swaps/:id/confirm ◀─────│
    │                            │  status → PAYMENT_VERIFIED      │
    │ 7. seller signs release, engine co-signs → submitTransaction  │
    │◀───────────────────────────│─────────────────────────────────▶│ (tokens)
    │                            │                                │
    │                    8. anchor social.p2p-swap on L1-SOCIAL    │
    │                            │                                │
    │ (no fiat payout step — the seller already has the money)     │
```

Step by step:

| # | Step | Who acts | Evidence |
|---|---|---|---|
| 1 | Seller posts a signed limit order (`giveChain: "L0"`, `wantCurrency`, `wantRail`, accepted methods) | seller | DID signature over sorted-key JSON |
| 2 | Buyer matches: `receiveAddress`, nothing PII-mandatory | buyer | DID signature over sorted-key JSON |
| 3 | Seller funds the 2-of-3 P2SH escrow | seller | `CONFIRMED` + `address === escrowAddress` + amount |
| 4 | Engine hands the buyer the seller's **payment instructions** (signed, party-scoped) | engine | — |
| 5 | Buyer pays the seller's account with remark = per-swap code, uploads receipt → `PAYMENT_CLAIMED` | buyer | receipt file ref + sha256, transaction id, remark, paidAt — the claim never releases anything on its own |
| 6 | Seller confirms from their own app → `PAYMENT_VERIFIED` | seller | DID-signed `confirm`: confirmedAt, matched amount/remark |
| 7 | Seller signs the release skeleton; engine verifies, adds its key, broadcasts | seller + engine | tx reaches `CONFIRMED` at `receiveAddress` |
| 8 | Audit anchor | engine | `social.p2p-swap` record on L1-SOCIAL, **fail closed** |

Step 6 is the irreversible trigger for release — the UI must say so. It is one
tap **after** the seller's own checks (§12), not a receipt-sighting.

### Rate lock

A real implementation needs an oracle and a deviation threshold before
`escrow_lock`; the instruction amount is fixed at match time either way, so the
on-chain and fiat legs are always denominated consistently.

---

## 9. State machine

```
ACTIVE ──match──▶ MATCHED ──lock+confirm──▶ ESCROW_LOCKED ──instructions shown──▶ PAYMENT_PENDING
PAYMENT_PENDING ──buyer proof──▶ PAYMENT_CLAIMED
PAYMENT_PENDING / PAYMENT_CLAIMED ──seller confirm──▶ PAYMENT_VERIFIED ──release──▶ ESCROW_RELEASED ──▶ COMPLETED

PAYMENT_PENDING / PAYMENT_CLAIMED ──dispute open──▶ frozen (status unchanged, `dispute` field set)
MATCHED / ESCROW_LOCKED / PAYMENT_PENDING (no claim) ──timeout / failure──▶ EXPIRED ──refund──▶ ESCROW_REFUNDED
MATCHED / ESCROW_LOCKED ──either party──▶ CANCELLED ──refund spend──▶ ESCROW_REFUNDED
PAYMENT_PENDING ──buyer cancel ("I never paid")──▶ CANCELLED ──refund spend──▶ ESCROW_REFUNDED
```

- **`PAYMENT_PENDING → PAYMENT_CLAIMED`** is the buyer's claim; it never
  releases anything on its own.
- **`PAYMENT_CLAIMED → PAYMENT_VERIFIED`** requires the **seller's** DID-signed
  `confirm`. `PAYMENT_PENDING → PAYMENT_VERIFIED` is also allowed (the seller
  confirmed without the buyer uploading proof — e.g. a transfer visible
  instantly in the seller's app); it is also the rescue hatch that keeps a
  paid-but-unclaimed payment out of the silent-expiry timer (§12).
- A dispute freezes the swap via the existing `dispute` field (no new status);
  it is openable only from `PAYMENT_PENDING`/`PAYMENT_CLAIMED` (a conflict
  before payment resolves by cancel/expire), and resolution is an explicit
  arbitration outcome (§12).
- **Cancel is barred once a payment may have moved.** The seller cancels only
  from `MATCHED`/`ESCROW_LOCKED`; after instructions exist only the buyer — the
  only party who knows whether they paid — may cancel, and a claim or a
  confirmed payment bars cancel entirely: those unwind only through the dispute
  path. `PAYMENT_VERIFIED` has exactly one way out: release. `expire` follows
  the same rule (no refund over a live claim without arbitration).
- **`CANCELLED` never strands escrow.** After the lock a cancel settles through
  the same refund spend as `EXPIRED` (`CANCELLED → ESCROW_REFUNDED`), driven by
  the seller's cosign or the presign hook (§6).
- `ESCROW_REFUNDED` must be reachable from `allowedActions` (via `EXPIRED` or a
  settled `CANCELLED`) — and it is always chain-proven: the generic `refund`
  transition verifies the refund spend exactly like `release` does.

The single status list lives in `packages/p2p-protocol/src/records.ts`
(`P2P_SWAP_STATUSES`); the transition table in
`services/p2p-engine/src/state.ts` (`VALID_TRANSITIONS`) is a superset of the
running bigtai engine's, with `ESCROW_REFUNDED` restored and `CANCELLED`
reachable through the state machine (never a raw DELETE).

New event types (`services/p2p-engine/src/types.ts` `SwapEventType`):

| Event | Actor | Payload (store-only, never anchored raw) |
|---|---|---|
| `instructions` | engine | which profile fields were revealed |
| `payment_proof` | buyer | receipt file ref + sha256, claimed transaction id, remark, paidAt |
| `payment_confirm` | seller | confirmedAt, matched amount/remark |
| `dispute_open` | buyer or seller | reason code |
| `dispute_resolve` | engine admin (AI-assisted) | outcome `release` \| `refund`, note |

Everything else (`match`, `escrow_lock`, `release`, `expire`, `refund`,
`cancel`) is untouched.

---

## 10. Wallet-facing reads

The order book is public: open sell orders carry no PII, so the app lists them
with an unauthenticated `GET /public/orders?status=ACTIVE` (the seller's
signature is stripped from the response). Everything else the app reads is
party-scoped and signed with the wallet's PQ key, like the mutations:
`POST /swaps/mine` returns only swaps where the caller is the seller or buyer,
and `POST /swaps/get` returns one swap the caller is a party to (403 otherwise).
Both go through the same whole-body signature check and PII-redacted view as the
admin routes, and carry `presigned` (whether the escrow spend skeletons are
already on file). The party-scoped reads are:

- `POST /swaps/:swapId/payment-instructions` — matched profile fields + exact
  amount + remark code; 403 for non-parties; only after `ESCROW_LOCKED`
  (idempotent while `PAYMENT_PENDING`).
- `POST /swaps/:swapId/escrow/context` — reveals exactly the settlement fields
  the spend skeleton needs and nothing else.

The engine's own admin routes (`GET /orders`, `GET /swaps`,
`GET /swaps/:swapId`, dispute resolve) stay behind
`SETTLEMENT_ADMIN_TOKEN` and are never called by the app.

---

## 11. Engine API (`services/p2p-engine`)

All routes are whole-body signed like the existing ones. A swap picks its rail
from `wantRail` at match time and never touches both.

| Endpoint | Who | Effect |
|---|---|---|
| `POST /orders`, `POST /orders/:id/match` | seller / buyer | signed limit order / signed match. `POST /orders` accepts optional `orderId` (`ord-<16hex>`) + `txid`: the seller already anchored the `social.p2p-order` record, the engine polls `verifyTx` (bounded, `SETTLEMENT_ORDER_TX_TRIES`) and 409s until it is `CONFIRMED`. Re-posting the same `{orderId, sellerDid}` is idempotent (200); a colliding id from another seller is 409. No `orderId`/`txid` = legacy engine intake (mock/tests) |
| `POST /orders/:orderId/cancel` | seller | withdraw an ACTIVE order. Optional `txid` of the anchored `CANCELLED` record (same confirmation rule); idempotent on an already-CANCELLED order, 409 on `MATCHED`/lost race, 403 for a non-seller |
| `POST /swaps/:swapId/escrow/context` | party | escrow signing context (`escrowAddress`, `escrowTxHash`, `receiveAddress`, `presigned`) |
| `POST /escrow/presign` | seller | pre-sign both spend skeletons (settlement closure; Path B) |
| `POST /escrow/cosign` | party | co-sign a spend → engine broadcasts + settles (Path A; arbitration forced-release uses the buyer here) |
| `POST /swaps/:id/payment-instructions` | buyer | matched profile fields + exact amount + remark code; only after `ESCROW_LOCKED` (idempotent while `PAYMENT_PENDING`) |
| `POST /swaps/:id/proof` | buyer | `payment_proof` → `PAYMENT_CLAIMED`. Body: required `txId` (1..64 alnum `._-`), matching `remark`, optional `receipt` image data URL (the engine decodes the payload and recomputes the sha256 of the **image bytes**, not the data-URL string; receipt bytes stay out of the chain) |
| `POST /swaps/:id/confirm` | seller | checks: status `PAYMENT_CLAIMED` or `PAYMENT_PENDING`, no open dispute → `PAYMENT_VERIFIED`. The engine-signed `release` follows as a separate step (seller cosign/presign) |
| `POST /swaps/:id/verify` | buyer or seller | a device-side payment verdict (§12): `side` is the signer's role (a party can never file the other side's story), checked against the four fields — amount exact, remark = the swap code, entry inside the swap window, transaction id sane. A claim/observation transaction id mismatch is reported as arbitration evidence, never fatal. Anchored minus PII (§14: the `payment_verify` record carries the small evidence; the name/bytes stay store-only); under `SETTLEMENT_CNY_AUTO_RELEASE_ON` the qualifying verdict acts as the `confirm` (same rules: payment phase, not frozen) with its provenance anchored |
| `POST /swaps/:id/dispute` | buyer or seller | sets `dispute`, freezes the swap (from `PAYMENT_PENDING`/`PAYMENT_CLAIMED` only) |
| `POST /swaps/:id/dispute/resolve` | `SETTLEMENT_ADMIN_TOKEN` | `release` (buyer wins) or `refund` (seller wins). **Self-executing** (§12): the resolve settles the spend itself from the seller's presign — release to the buyer, or an engine-act `expire` + refund to the seller — so neither party has to be online; without a presign the outcome stays armed and the winning party finishes via `/escrow/cosign` (buyer for a forced release, seller for a refund). Responds `settled`/`txHash`/`pending` |
| `POST /profiles`, `POST /profiles/mine` | seller | payment profile upsert / list (store-only PII, §14) |
| `GET /public/orders` | anyone | PII-free active order book |

Env config:

```
SETTLEMENT_NETWORK=mainnet|testnet
SETTLEMENT_STORE=pg|blob|mem            # pg default (POSTGRES_URL); blob = no Postgres; mem = dev
SETTLEMENT_BLOB_URL / _BUCKET / _ACCESS_KEY / _SECRET_KEY   # blob mode: S3/MinIO
SETTLEMENT_BLOB_DIR                     # blob mode: a directory (mounted volume) instead of S3
SETTLEMENT_BLOB_KEY                     # blob mode: AES-256-GCM key for the objects at rest
SETTLEMENT_ADMIN_TOKEN=…            # arbitration / admin routes
SETTLEMENT_ENGINE_KEY / _PUBKEY     # engine key (scripts/p2p-engine-key.mjs)
SETTLEMENT_CNY_RAILS=wechat,alipay,bank   # enabled methods (empty = rail off)
SETTLEMENT_CNY_REMARK_TTL=900             # seconds the remark code is valid
SETTLEMENT_CNY_CONFIRM_TIMEOUT=900        # claim → confirm deadline: past it the sweep opens a dispute (§12); 0 = never
SETTLEMENT_CNY_EXPIRE_AFTER=3600          # silent pre-payment idle: past it the sweep expires + refunds (§12); 0 = never
SETTLEMENT_CNY_AUTO_RELEASE_ON=off        # device-verified payment (§12): off | seller_receipt | two_sided | verified_receipt
SETTLEMENT_CNY_MAX_CENTS=...              # NOT IMPLEMENTED yet — per-trade cap (§16)
SETTLEMENT_SWEEP_MS=0                     # conflict-sweep tick (the two timers above); 0 = off (the tick is exported for tests)
SETTLEMENT_ESCROW_HOOK_MS=0               # presign settlement hook tick (release at PAYMENT_VERIFIED, refund at EXPIRED/CANCELLED); 0 = off
SETTLEMENT_ESCROW_POLL_MS=25000           # per-spend CONFIRMED wait before reporting pending
SETTLEMENT_L1_SOCIAL_URL / _URLS          # social node(s): order txid confirmation + anchor + watcher
SETTLEMENT_ANCHOR_MODE=best-effort        # L1-SOCIAL swap-anchor policy: best-effort (default) | required | off
SETTLEMENT_RATE_LIMIT=10                  # signed WRITES per DID per 60s window (process-local, §18.1)
SETTLEMENT_RATE_LIMIT_READ=120            # signed party-scoped READS per DID per 60s (mine/get/context)
SETTLEMENT_IP_RATE_LIMIT=600              # requests per client IP per 60s (0 = off); bounds sybil floods the per-DID caps cannot
SETTLEMENT_TRUST_PROXY=1                  # trust X-Forwarded-For for the client IP (behind Caddy; 0 = engine exposed directly)
SETTLEMENT_ORDER_TX_VERIFY=0              # disable the txid check (default: on when a social URL exists)
SETTLEMENT_ORDER_TX_TRIES=4               # bounded verifyTx polls per order/cancel (500ms apart)
SETTLEMENT_WATCH=1                        # run the chain-scan projector loop in-process
SETTLEMENT_WATCH_INTERVAL_MS=15000        # watcher tick
SETTLEMENT_WATCH_MAX_WALK=2000            # max blocks walked back per tick (rebuild uses 50000)
```

`SETTLEMENT_NETWORK` governs the escrow derivation *and* every L1-SOCIAL anchor
transaction. Operational prerequisite: the key that anchors a record must hold
**BIG on L1-SOCIAL** to fund it — each anchor is a small self-paying
transaction that spends the key's own outputs for fee + change (the engine's
`submitSocialRecord`, the wallet's `anchorSocialRecord`) and the submit path
fails closed with `insufficient spendable outputs for social tx` when the key is
unfunded. That is the engine key for `social.p2p-swap`, and the **seller's own
wallet key** for seller-anchored `social.p2p-order` records.

That BIG is not the same as BIG on L0: L1-SOCIAL is a separate chain, so it has
to **peg in** through the L0 bridge (`getBridgeInfo` vault + `processPegIn`;
the app-side `pegInToL1`), exactly like any other L1 collateral.

**But the L1-SOCIAL log is evidence, not the money leg** — the value moves on
L0 (escrow) and on the rail (fiat). So `SETTLEMENT_ANCHOR_MODE` decides what a
failed anchor does:

| Mode | Behavior |
|---|---|
| `best-effort` (**default**) | Log the failure and store the event **without** a chain record; the L0 settlement still advances. A down or unfunded anchor node degrades the audit log, never the trade. |
| `required` | Fail closed (the event is not stored unless its chain record landed); the store can never hold state the chain seed lacks, so a wiped store always rebuilds exactly. |
| `off` | Never anchor (L0-only deploy; `deps.anchor` is unset). |

With `best-effort`/`off`, the chain-scan projector can only rebuild the
**anchored** subset, so `replay verify` may report the un-anchored events as
drift — the accepted trade for not letting L1 gate L0.


Replay CLI (docs §14): `yarn workspace p2p-engine replay <sync|verify|rebuild>`
— `sync` runs one incremental pass from `p2p_watch_cursor`, `verify` replays the
chain into a scratch store and diffs (exit 1 on drift), `rebuild` wipes the
chain-derived tables and replays (needs `POSTGRES_URL`).

---

## 12. Conflict resolution — automatic where the evidence is, AI-assisted where it isn't

The honest restatement of the trust model: **the seller's confirmation is the
fiat truth; arbitration is the safety net; the engine operator (with AI help)
is the named third key of the 2-of-3.** That is exactly the trust Binance P2P
asks for, minus the custody.

### Process

1. Either party opens a dispute (`POST /swaps/:id/dispute`, from
   `PAYMENT_PENDING`/`PAYMENT_CLAIMED` — a conflict before payment resolves by
   cancel/expire) → the swap freezes: nothing advances (`release`/`complete`)
   and nothing unwinds (`cancel`/`expire`) until the outcome lands. A stuck
   escrow is not a risk: the outcome settles by itself (step 3).
2. The engine assembles the **evidence pack**: both parties' signed statements,
   the payment instructions as delivered (engine-signed, so a mid-swap account
   change provably fails), the proof upload (transaction id + receipt sha256 + remark +
   paidAt), the escrow lock proof, and — per rail — whatever the table in §4
   offers (CNY transaction id + the seller's in-app ledger view).
3. **AI arbitration** reviews the pack against the rules below and proposes
   `release` or `refund` with a written rationale. The human operator confirms
   (or overrides, on the record) and the admin route **executes**:
   `dispute/resolve` is self-driving — it settles the spend itself from the
   seller's presign (release to the buyer, or an engine-act `expire` + refund
   to the seller), so neither party has to be online; without a presign the
   outcome stays armed and the winning party finishes via `/escrow/cosign`
   (buyer for a forced release, seller for a refund).
4. The outcome is anchored like every other transition (`dispute_resolve` event,
   fail closed), together with the unwind it executed (`expire`, `refund`).

### Automatic resolution — the deterministic ladder

Conflicts are not all human work. The rule: **only signature- or chain-derived
evidence may resolve automatically; anything whose sole source is a person's
private app (their bank / WeChat / Alipay statement) stays with a human.** Every
automatic action is an ordinary anchored event with the engine as actor and an
`auto:` reason — auditable, replayable, and the human operator can still open
the case afterwards.

| Tier | Rule (engine) | Resolves | Why it is safe |
|---|---|---|---|
| 0 | chain inclusion order decides (§14) | match/cancel races | deterministic on-chain ordering |
| 0 | fail-closed lock proof (status ∧ address ∧ amount) | fake or short locks | the chain is the oracle |
| 1 | seller's signed `confirm` + presign → release closes itself (escrow hook, §6) | "seller confirmed then refuses to release" | the signed confirm **is** the fiat truth — no judgment needed; without a presign an `release` outcome self-executes with the buyer |
| 1 | silent pre-payment idle > `SETTLEMENT_CNY_EXPIRE_AFTER` → auto-`expire` → refund (sweep) | buyer no-show (§15) | no claim ∧ no confirm ∧ no dispute — nobody ever asserted payment |
| 1 | claim unconfirmed > `SETTLEMENT_CNY_CONFIRM_TIMEOUT` → auto-`dispute_open` | fake-receipt stalling | the buyer may really have paid, so silence after a claim **enters** the dispute path and never auto-refunds |
| 1 | `dispute/resolve` settles the spend itself | every arbitration outcome | the arbiter's decision needs no party online |
| 1 | device-side two-sided verification (next section) → acts as the confirm under policy | "buyer paid, seller claims non-receipt" when both ledgers agree | both parties' **own** ledgers describe one transaction id; colluding fakes would need both devices to lie consistently |
| 2 | AI triage proposes, human confirms | seller-claims-non-receipt over a claimed payment **with only one device read**; payer-name mismatch; key-compromise claims | a one-sided device read is spoofable by its owner — evidence, not truth |
| 3 | human only | colluding pairs, wash, frozen account cases | abuse, not per-swap facts (§16) |

Timers are engine config (`SETTLEMENT_SWEEP_MS` arms the sweep; `0` on either
timeout disables that rule), and the confirm deadline is a **seller promise** —
the UI counts it down. The residual race the ladder cannot see is a buyer who
pays but never claims before the silent-expiry window: the claim deadline is
the buyer's hard obligation (the UI must push the claim immediately after
paying), and the seller's confirm from `PAYMENT_PENDING` is the rescue hatch.

### Device-side payment verification — the on-phone app, user-paired

The one thing the ladder could not automate — "the only evidence is a person's
private app ledger" — shrinks when the read itself is automated **on the owner's
own device**: a party installs the deployed **Mobile Agent** app
([`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp))
on their own phone — it runs the MCP server *on the phone* (AccessibilityService
+ screenshots, no adb, no host machine) — and pairs that endpoint with the
engine. The engine then connects to the paired endpoint and reads the matching
entry in the party's own rail app. `services/p2p-verify` extracts the entry
(accessibility tree — no screenshots of secrets), checks it against the swap,
and the **wallet signs the verdict** with the party's DID key.

**Pairing is the consent step.** The user installs the app (download from the
dai **Data → Mobile** page, `#mobile`), grants it the Accessibility service, and
starts its server. The app then shows an endpoint URL and a bearer token:

```
  Mobile Agent app  →  Settings › Accessibility: grant Mobile Agent
                    →  Server tab: Start
                    →  http://<phone-ip>:8080/mcp  +  the bearer token
```

They hand the engine exactly two things — the endpoint URL and the bearer
token — scoped to the one device they paired. Neither is a credential the
engine could use elsewhere, and the pairing dies the moment the user stops the
server or rotates the token. Reachability is the user's choice and the user's
exposure: bind `127.0.0.1` and put a tunnel in front (the app can open a
Cloudflare/ngrok tunnel itself), or bind the LAN for a home setup. Nothing
auto-discovers; the engine connects to endpoints a person deliberately gave it,
one swap at a time.

The wallet app surfaces this per swap: **"Verify with my phone"** (buyer or
seller, CNY swaps in `PAYMENT_PENDING`/`PAYMENT_CLAIMED`) pairs the phone once
(endpoint + token → a DID-signed grant → `POST /pairings`), asks the engine to
read (`POST /swaps/:id/device-read` — the caller's own pairing and own side
only), then **signs the returned verdict** and submits it
(`POST /swaps/:id/verify`). Only a swap party can trigger either call, each for
their own side and their own device; the engine never initiates a read.

```
  buyer's phone                            p2p-engine                     seller's phone
  Mobile Agent app: endpoint + token       (connects only to paired       Mobile Agent app: endpoint + token
  reads the SENDING rail app ────────────▶ endpoints, one swap)          reads the RECEIVING rail app
                                          │◀─────────────────────────────│
                                          │  engine reads the SENDING app │  engine reads the RECEIVING app
                                          │  → {status success, amount,    │  → {amount, remark, time,
                                          │     real name, remark, time,   │     transaction id, payer name}
                                          │     transaction id}            │
                                          │  re-checks the four fields    │
                                          │  against the swap terms       │
  wallet signs verdict_B ◀────────────────┤◀───────────── verdict_S ────── wallet signs verdict_S
```

- **The transaction id is the shared correlation id** — both apps display the
  same id for the same transfer, so two independent reads describing one id is
  verification, not two stories.
- **Consent is the pairing, and it is revocable.** The engine reaches a device
  only through an endpoint a person chose to expose and can pull back at any
  time; it never owns, provisions, or auto-discovers one ("no engine-*operated*
  devices" now means no engine-*owned* ones — §14). The verdict is the only
  thing that leaves the phone's control: the entry fields plus sha256 capture
  refs. The verdict **anchors** on L1-SOCIAL like every other event
  (`payment_verify`): the chain rule is *only large blobs stay off chain, as
  hashes* — so the small evidence (amount, transaction id, remark, time, capture
  hashes) is on chain and survives a rebuild, while the capture bytes and the
  entry's PII (counterparty name) stay in the engine store
  (`p2p_payment_verifications`). The wallet key never leaves the device; the
  engine reads, the wallet signs.
- **What a verdict may change is policy** (`SETTLEMENT_CNY_AUTO_RELEASE_ON`):
  `off` (default) — evidence only; `seller_receipt` — the seller's own ledger
  saying received stands in for the confirm tap; `two_sided` — stricter, both
  ledgers must agree on one transaction id first; `verified_receipt` — a bank e-receipt
  whose receipt verification passes on the bank's **public** verification page
  settles it alone (the one near-oracle signal, bank rail). The qualifying
  verdict's signature is the attestation (`verifySource` records how it was
  obtained); a frozen swap never advances.
- **What it does not change:** a payer still controls their own phone, so a
  one-sided read is evidence (tier 2) and never releases — they could pair an
  endpoint in front of a fake rail app. A *seller's* `received` verdict under
  `seller_receipt` is exactly the confirm tap the seller was trusted for
  anyway, now machine-read under their own pairing. The bank receipt path is the
  only tier that approaches machine truth.
- **Transports.** The device transports live in the shared
  **`packages/mobile-control`** client — the general device-control surface
  (Streamable HTTP + stdio, plus the Ed25519 DID request signer) used by the
  worker, the p2p engine and the wallet's Device screen alike.
  `services/p2p-verify` adapts that client to its narrow `DeviceGateway`.
  The default is `AndroidMcpClient`, speaking
  [`android-remote-control-mcp`](https://github.com/danielealbano/android-remote-control-mcp):
  the **deployed on-phone agent** that runs the MCP server on the phone itself
  (AccessibilityService + screenshots, no adb, no host), so `connectFromGrant`
  connects straight to the party's phone over its `/mcp` endpoint (bearer or DID
  auth, one stateless JSON-RPC POST per tool call). The mobile-mcp host+adb
  transports remain for the CLI: `McpHttpGateway` calls a paired `--listen`
  endpoint, `McpGateway` spawns the server over stdio beside the phone. All
  expose the same `DeviceGateway`, so a swap verifies identically either way.
- **Platform reality:** Android drives third-party apps via adb/UIAutomator
  accessibility (the text tree survives `FLAG_SECURE`); iOS needs WebDriverAgent
  pairing to a host the user controls (desktop companion) — no on-app API reads
  other apps there. Pilot order: emulator + mock rail app → test Android phone
  → iOS companion pairing. Automating WeChat/Alipay UI can trip their risk
  controls (§16): human-paced, user-initiated, never a scraper.

The worker is the extraction half (`services/p2p-verify`: `parseRailEntry` /
`verifyPayment` plus the `AndroidMcpClient` transport for the on-phone app and
the `McpHttpGateway`/`McpGateway` transports for a mobile-mcp host, tested
against WeChat / Alipay / bank entry fixtures) and the same code path is the
e2e harness for the mock-rail screens. Against the app the engine connects from
the stored grant (`connectFromGrant` in `../services/p2p-verify/src/gateway.ts`
→ `AndroidMcpClient`), and one verification from the shell is:

```bash
node services/p2p-verify/dist/cli.js --devices
node services/p2p-verify/dist/cli.js --side buyer --rail wechat --amount 715 \
    --remark <code> --tx-id <transaction id> [--app com.tencent.mm] [--device <id>] \
    --http http://<phone-ip>:8080 --token <bearer-token>
```

`--side buyer` reads the buyer's **sending** ledger, `--side seller` the
seller's **receiving** ledger. The CLI reads, extracts and checks, then prints
the verdict for the wallet to sign and POST to `/swaps/:id/verify` — it holds no
keys and never talks to the engine (`--evidence bank_ereceipt --receipt-verified`
covers the receipt path).

### What the seller must check before confirming (never the screenshot)

| Check | Why |
|---|---|
| Money visible in **their own** app's balance/statement | a screenshot proves nothing; the seller's own ledger is the only receipt |
| **Amount** exact to the cent | rules out unrelated transfers |
| **Remark code** matches the swap | identifies the payer when several buyers pay the same seller |
| **Time** within the swap window | old transfers must not be replayed |
| Payer name matches the buyer's verified name (if KYC tier requires it) | kills "paid from a friend's account" ambiguity |

### What the buyer must do

- Pay **only** to the instructions the engine signed and delivered (§7). Any
  account change communicated outside the app is a scam attempt.
- Include the remark code and the **exact** amount.
- Keep the receipt with the **transaction id**: it is what an arbiter
  asks for, and it is visible in the seller's app too.

### Fraud cases → handling

| Case | Handling |
|---|---|
| Fake receipt, buyer never paid | seller doesn't see it in their app → never confirms → the confirm-timeout sweep auto-opens the dispute → arbitration refund, which **settles itself** (§12 ladder) |
| Buyer paid, seller claims non-receipt → buyer appeals | **device-side verification first** (§12): both ledgers describing one transaction id resolves it under policy before any human; one-sided or `none` reads go to arbitration as interactive evidence (the seller's in-app statement for the window) — the transfer either exists or it doesn't → release (self-executing; engine + buyer if no presign, seller cannot block) or seller-flag |
| Seller confirmed but then refuses to release | **no arbitration needed** — the confirm is already signed and the presigned release closes itself; without a presign a `release` outcome self-executes with the buyer |
| Seller changes payment details mid-swap | instructions are engine-signed per swap; a mismatch is the seller's fault → the buyer's signed copy + proof wins |
| Receipt from an older swap replayed | remark code is per-swap and TTL-bound; amount+time+remark must all match |
| Both parties collude to fake a trade (wash) | out of scope for a swap; limit as abuse control (§16) |

Nothing ever releases on a claim or on silence in the disputed window. Silence
**before** any payment assertion auto-refunds (nobody asserted payment — the
ladder's silent-expiry rule); silence **after** a claim auto-enters the dispute
path, never the refund path.

---

## 13. Trust model

| Party | Holds | Can do | Cannot do |
|---|---|---|---|
| Seller | own key + own fiat account | fund escrow, confirm receipt, sign release, co-sign refund | move escrowed funds alone; confirm without checking their own ledger |
| Buyer | own key | pay the seller, upload proof, co-sign a forced release after arbitration | move escrowed funds alone; force a release on their claim alone |
| Engine | attestor key + dispute workflow | co-sign release/refund on confirmed state or arbitration outcome, deliver signed instructions, anchor | spend without a second signature; touch fiat; advance a frozen swap |
| Arbitration (operator + AI) | admin token | review evidence packs, order release/refund | move tokens directly — still needs the engine key + a party key |
| The fiat rail | its own ledger | hold/transfer/reverse its own money per its rules | move tokens |

Because the vault is *any* two of three (§6), the seller and buyer together can
spend it **without the engine** — cooperation needs no attestor, and since the
vault holds the seller's tokens, their agreeing moves nothing but the seller's
own funds. The engine's key matters only when they disagree or one is offline:
it is what turns a dispute into a reachable outcome (forced release to the
buyer, or refund to the seller). So the operator's real trust burden is the
mirror case below — not being needed, but being *neutral* when it is.

Residual risks, stated rather than hidden:

- **Engine collusion** — engine + one party can move funds against the other.
  Mitigation is the observable on-chain audit trail plus the fact that any spend
  is visible at `escrowAddress`.
- **Arbitration error** — an AI-assisted human can still get a case wrong; the
  mitigation is the evidence pack being both parties' signed material plus the
  rail's own final ledger, and the operator's override being on the record.
- **Chargeback after release** — keep the verified→released window
  sub-minute; after release treat reversals as disputes.
- **frozen account (CNY)** — see runbook in §16.

---

## 14. Data, evidence & PII

**Store backends** (`SETTLEMENT_STORE`). Postgres is the default *engine* mode
when `POSTGRES_URL` is set and holds the whole store; the deployed stack defaults
to **no database** (`blob`). `blob` runs the engine with **no Postgres**: the rebuildable half
(`p2p_orders` + `p2p_swap_events`) becomes an in-memory projection rebuilt from
L1-SOCIAL at boot (the projector is forced on — see `services/p2p-engine/src/storeBlob.ts`),
while the store-only half (payment profiles, payment proofs, escrow signings)
persists to the encrypted `BlobStore` (`src/blob.ts`): an S3/MinIO bucket or a
directory, AES-256-GCM under `SETTLEMENT_BLOB_KEY`. `mem` keeps everything in
memory (dev/e2e). Only `pg` and `blob` are durable; neither puts the store-only
fields on chain.

- Swap state is an **append-only event log** (`p2p_swap_events`) that can be
  replayed, not rows mutated in place. Postgres is a rebuildable projection.
- The order book is chain-derived too: `p2p_orders` is a projection of
  seller-anchored `social.p2p-order` records. The engine never authors them —
  it verifies the author signature and indexes; a wiped projection replays from
  the chain (`replay.ts`), and `MATCHED` is never seller-asserted (it is
  derived from the engine-anchored `social.p2p-swap` event that references the
  order).
- Each event is signed with `P2P_ENGINE_KEY` and anchored on L1-SOCIAL as a
  `social.p2p-swap` record; the engine's rebuild watcher (`replay.ts`, below)
  verifies the record signature and projects it, and the wallet can validate
  the same records independently from the chain.
- The record contract lives in `packages/p2p-protocol`:
  `P2P_SWAP_STATUSES`, `P2pSwapRecord`, `p2pSwapRecord()`,
  `validateP2pSwapRecord()`; plus `P2P_ORDER_TYPE`, `P2pOrderRecord`,
  `p2pOrderRecord()`, `validateP2pOrderRecord()`, `P2P_ORDER_ID_RE` for the
  order book. Amounts are decimal strings; `swapSeq`/`orderSeq` order events;
  `to` is the opaque `swapId`/`orderId`. `OPEN` carries the six terms +
  `validUntil` (unix seconds); `CANCELLED` references the order only and must
  not carry terms.
- **Engine watcher** (`services/p2p-engine/src/replay.ts`, `SETTLEMENT_WATCH=1`
  or `yarn workspace p2p-engine replay …`): walks L1-SOCIAL back from the head
  (`getTips` → `getBlockByHash` by prev-hash) to the `p2p_watch_cursor` row,
  applies blocks oldest-first, and advances the cursor. Fails closed: an
  unservable head or a truncated walk applies nothing. `verify` diffs the whole
  chain against the projection (`missing` = chain rows the store lost; `extra`
  = store-only rows, which is expected for legacy engine-intake orders and all
  PII).
- **Conflict rule**: chain inclusion order decides. The watcher claims
  `ACTIVE→MATCHED` / `ACTIVE→CANCELLED` with the same conditional updates the
  API routes use, so a cancel and a match that both landed resolve to whichever
  the chain ordered first; the loser is reported as a conflict, never applied
  over the winner.
- **The model never supplies trusted evidence** — signatures are produced by the
  service, and claimed transactions are re-checked against the node (status,
  destination address **and amount**).
- **Payment profile** (method, account name, account/QR, bank + card):
  encrypted engine store, party-scoped reads, **never anchored**.
- **Device verdicts** (§12): what a party's own device read in their own rail
  app. The read happens through the on-phone **Mobile Agent** endpoint the
  **user paired** — the engine connects to it, it never owns or auto-discovers
  a device ("no engine-*operated* devices": no engine-owned hardware, pairing is
  user-held and revocable). The verdict **anchors** as a `payment_verify` event — the
  small evidence (entry fields, capture sha256 list) is on chain and
  independently checkable; only large blobs stay off chain as hashes. The
  counterparty name (PII) and the capture bytes stay in the engine store
  (`p2p_payment_verifications`), so a rebuild restores the evidence but not
  the name. A machine confirm anchors its provenance (`verifyEvidence` on the
  `payment_confirm` record).
- **Receipts**: durable object storage (MinIO / user Drive — the durability
  rule below), the event carries only the file ref + sha256 + transaction id. The image
  itself never goes on chain and never leaves the party scope except to the
  arbiter. When `SETTLEMENT_BLOB_*` is configured the proof row keeps only
  `receipt_sha256` + a `receipt_ref` and the bytes live in the blob store
  (any store backend — `PgSettlementStore` offloads them); without a blob target
  the image stays in the row.
- **Anchor**: `social.p2p-swap` records carry status transitions and refs only;
  the public view stays PII-redacted (`P2pSwapView` pattern, plus proof refs).
- **PII is store-only by design**: `receiveAddress`,
  payment profiles and receipt bytes exist only in the engine store — they are
  not in any record, so a full rebuild restores the book and the event log but
  never the private fields (they are keyed to the parties, not to the chain).
- **Replay**: `payment_proof` / `payment_confirm` are re-derivable from the
  store; the chain record stays a signature-covered audit trail, not evidence.

---

## 15. Failure recovery

| Failure | Handling |
|---|---|
| Buyer never pays (never claims) | the silent-expiry sweep (`SETTLEMENT_CNY_EXPIRE_AFTER`) auto-expires → the presigned refund lands → `EXPIRED` → `ESCROW_REFUNDED` (no presign: the seller cosigns the refund when back). No buyer consent needed — nobody asserted payment. |
| Buyer paid but never uploaded proof | the claim deadline is the buyer's **hard obligation** (the UI pushes the claim right after paying); the seller's confirm from `PAYMENT_PENDING` rescues it. Otherwise the row above applies — the stated residual risk of the ladder (§12). |
| Seller never confirms though buyer claims paid | the confirm-timeout sweep (`SETTLEMENT_CNY_CONFIRM_TIMEOUT`) auto-opens the dispute → arbitration on the evidence pack (§12) → the outcome settles itself |
| Seller confirmed but wallet offline | Path B presign lets the engine finish the release; otherwise the seller cosigns when back |
| Arbitration ordered, nobody online | the resolve settles the spend itself from the presign (`dispute/resolve` is self-executing, §12) |
| L0 node unreachable at confirm time | retry with backoff; while unreachable, **fail closed** |
| Release broadcast lost | retry the same skeleton; the stored `releaseTxHash` deduplicates |
| Node down after release | tokens are already at `receiveAddress`; nothing else is pending — there is no fiat payout to fail |
| Receipt hash mismatch / malformed base64 | 400 at `POST /proof` — the engine hashes decoded image bytes |

---

## 16. Risk controls & operations

| Control | Detail |
|---|---|
| Per-trade and per-seller daily caps | engine config, KYC-tiered |
| Bank transfer default above a threshold | best identity signal, lowest rail freeze risk |
| Velocity limits | max open swaps per DID, min seconds between claims — kills structuring and wash patterns |
| Remark-code uniqueness | one code per swap, high-entropy (not the swapId — it is guessable) |
| frozen account playbook | operator runbook: pause the seller's profile, migrate liquidity to other sellers/banks, never route through the platform's own account (the engine must hold **no fiat**, ever) |
| Seller onboarding | real-name matched to the profile's account holder name; small-value test transfer before raising limits |
| Dispute SLA | arbitration within a fixed window; the escrow keeps both parties honest while it runs |

KYC tiers (illustrative): unverified — view only; tier 1 (phone/real-name) — up to a
small per-trade cap; tier 2 (id + name-matched accounts) — full limits.

**The engine must never touch fiat.** No merchant account on the happy path, no
collection code of ours, no aggregate balance: buyer → seller, directly. That
keeps the platform out of the money-transmission business and is why there is
no payout step.

---

## 17. Full automation — the timer half is built

The manual flow (§8) needs no automation to close: the seller's Path B presign
(§6) already lets the engine finish the release once the state reaches
`PAYMENT_VERIFIED`. With the deterministic timers and the self-executing
arbitration (§12 ladder) the only human tap left is the **confirm** — and
there is no machine fiat signal to drop even that for a personal CNY transfer.

- **Presign-based auto-release + timers** — *delivered:* the confirm-timeout
  auto-dispute and silent-expiry auto-refund (`SETTLEMENT_CNY_CONFIRM_TIMEOUT`,
  `SETTLEMENT_CNY_EXPIRE_AFTER` via `SETTLEMENT_SWEEP_MS`), the escrow hook
  (§6), and `dispute/resolve` settling its own outcome.
- **Device-side verification** (§12) — *the worker is delivered:* under
  `SETTLEMENT_CNY_AUTO_RELEASE_ON` the seller's own ledger read (or a
  two-sided transaction id match, or a publicly-verified bank receipt) replaces the confirm
  **tap**. The read runs over a user-paired on-phone endpoint — the user
  installs the **Mobile Agent** app, grants accessibility, starts its server and
  hands the engine the URL + bearer token (revocable at will); the engine
  connects to verify. It
  is still attestation, not an oracle — the rails expose no machine payment
  event to a personal account.
- **Corporate-seller collection (C4-style)** — bank-enterprise direct connection / licensed aggregated payment
  merchant code with real callbacks, **only** for seller entities that are merchants,
  never for personal accounts, and only with a licensed provider. This remains
  the only path to a true machine payment event.

---

## 18. Prerequisites — not built

1. **Shared nonce + rate-limit store** — the **nonce** set now persists in
   Postgres (`p2p_nonces`) and is re-hydrated at boot, so a restart no longer
   forgets an accepted nonce (a replayed signed write is still rejected). The
   `mem`/`blob` store modes have no database and keep the in-memory set only.
   The **rate limit** (per DID) and the **per-IP** bucket are still
   process-local, so they reset on restart and are per-instance — a single
   engine is the deploy.
2. **Arbitration console** — the admin dispute route exists; the evidence-pack
   viewer and AI-assisted review loop (§12) are the remaining work.
3. **Escrow signer** — *delivered:* engine key management
   (`scripts/p2p-engine-key.mjs`) plus the scriptSig assembly /
   `submitTransaction` broadcast wiring (`services/p2p-engine/src/escrowSpend.ts`:
   rebuild skeleton → verify party sig → add engine key → broadcast → await
   `CONFIRMED`). The wallet's own half (`Escrow`, `p2pEscrow.ts`) co-signs the
   identical bytes.
5. **Rebuild watcher** — *delivered:* the chain-scan projector that reads
   `social.p2p-order` / `social.p2p-swap` records back from L1-SOCIAL,
   verifies the author signatures, validates the shapes and replays the
   projection (`services/p2p-engine/src/replay.ts` + `replay-cli`, §14).
   Optional later work: the wallet-side independent watcher — a client-side
   verify of the swap log that never has to trust the engine's projection.

---

## 19. Repos

| Repo | Scope |
|---|---|
| **`../blockchain`** | Java protocol oracle — P2SH multisig, PQ verify, `PayMultiSign`, `getTransactionStatus`, `submitTransaction`, L1-SOCIAL ingestion. Anything the TS port does must be proven against it. |
| **`../wallet` → `packages/bigtangle-ts`** | the TS protocol port and the client that holds keys — it owns the on-chain half of escrow. Ships `Escrow`, `ScriptBuilder.createRedeemScript` / `createP2SHOutputScript*` / `updateScriptWithSignature`, `RedeemData`, `Wallet.payToScript`, `core/PayMultiSign*`. |
| **`../wallet` → `services/p2p-engine`** | the settlement engine: orders, swaps, whole-body signed API, seller-confirm MVP, arbitration execution, append-only events, chain anchor. |
| **`../wallet` → `services/p2p-verify`** | the device-side verification worker (on-phone app, user-paired): connects to the endpoint the user paired with a DID-signed grant (`connectFromGrant` → `AndroidMcpClient` for the app; `McpHttpGateway`/`McpGateway` for a mobile-mcp host), reads the party's own rail app (the buyer's **sending** ledger or the seller's **receiving** ledger), extracts the entry, checks it against the swap terms and produces the verdict the wallet signs. Ships the `p2p-verify` CLI; the same code path is the mock-rail e2e harness. |
| **`../android-remote-control-mcp`** | the deployed on-phone agent the worker drives: an Android app that runs an MCP server on the phone itself (AccessibilityService + screenshots, no adb/host), built as **Mobile Agent** (`deploy.apk.sh` → the S3 bucket the dai `#mobile` page links). `AndroidMcpClient` (`packages/mobile-control`) speaks its `android_*` tools. Only ever pointed at a device the **user** paired — never engine-owned (§12). |
| **`../wallet` → `packages/p2p-protocol`** | the `social.p2p-swap` record contract (build + validate) and the payment-verdict contract (validate, agreement, machine-confirm policy). |
| **`../wallet` → `expo-app`** | the P2P UI (Binance-P2P style) + co-sign release/refund screens. |
| **`../wallet` → docs** | this document + the user guide/PDFs. |
| **dai** | **nothing** — the agent surface was removed. |

Why not one repo: the engine needs a database, the dispute workflow and an
operator key — a client app must not hold any of those, so the on-chain code and
the engine cannot share a home just because they share a feature. The escrow
script is a wallet capability, so it lives in `bigtangle-ts`.

---

## 20. Phases

1. **On-chain escrow in `bigtangle-ts`** — *delivered:* `Escrow` (2-of-3 redeem
   script, P2SH output + address, signed release/refund spends), Java-parity
   tested. Optional: the wallet app co-sign screen.
2. **Settlement engine in `services/p2p-engine`** — *moved from dai, CNY/manual
   MVP delivered:* Fastify + schema (`p2p_orders` / `p2p_swap_events`),
   append-only events, whole-body signed requests, the
   `instructions → proof → confirm → dispute` routes, payment profiles, the
   `PAYMENT_CLAIMED` state, seller presign/cosign release, and the L1-SOCIAL
   anchor. `services/p2p-engine/test/cny.test.ts` covers the CNY legs.
   **On-chain order book (delivered):** seller-anchored `social.p2p-order`
   intake (`orderId` + `txid` with bounded confirmation, `POST /orders/:id/
   cancel`), race-safe `ACTIVE→MATCHED` claims with reopen-on-anchor-failure,
   and the chain-scan projector (`replay.ts` + `replay` CLI) that makes
   `p2p_orders` / `p2p_swap_events` replayable from L1-SOCIAL.
3. **UI + guide** — *delivered:* Binance-P2P-style order book / order detail /
   match / pay / confirm / dispute screens in the wallet app, for all rails,
   plus the guide and PDFs in all 12 languages.
4. **AI-assisted arbitration** — *the deterministic half is delivered:* the
   conflict ladder's tier-0/1 rules (§12) — silent-expiry auto-refund,
   confirm-timeout auto-dispute, cancel/expire barred over a payment assertion
   or an open dispute, and self-executing `dispute/resolve` outcomes (the
   timers `SETTLEMENT_CNY_CONFIRM_TIMEOUT` / `SETTLEMENT_CNY_EXPIRE_AFTER` via
   `SETTLEMENT_SWEEP_MS`). Remaining: evidence-pack viewer, AI review + human
   confirm loop, push on claim/confirm/dispute.
   Counterparty reputation is *delivered* as derived stats (§25); user-submitted
   star ratings stay out of scope.
5. **Risk controls** — KYC tiers, caps, velocity checks, name-match on tiers,
   frozen account runbook, unusual-pattern alerts.
6. **Drop the engine key** → 2-of-2 + timelock. **Blocked on protocol work:**
   consensus needs an `isFinal` rule (reject txs whose `locktime` is in the
   future) in both `MempoolService.verifyTransaction` and `ServiceBaseCheck`.
   Consensus-breaking; needs a coordinated upgrade.
7. **Distributed matching** — the L1 order book for the crypto/crypto leg, with
   the cross-rail fiat obligation still settling through the service. The
   fiat-cross book already lives on L1-SOCIAL (`social.p2p-order`, §11), so
   this phase adds only the token↔token venue (prediction/ordermatch chain,
   §3) — not a second book for fiat.

---

## 21. Invariants

- **Durability** — only chain, user Drive and MinIO are durable. Swap state is
  an append-only event log that can be replayed; Postgres is a projection.
- **Never write the projection directly** — durable output is anchored on chain
  (`social.p2p-swap`), not inserted into serving tables. The order book is
  authored the same way by the seller (`social.p2p-order`): the engine only
  verifies and indexes, and `replay rebuild` regenerates PG from the chain.
- **PII never reaches the chain** — order records mirror the public book fields
  only; names, profiles, receive addresses and accounts stay store-only.
- **Only large blobs stay off chain, as hashes** — everything small and non-PII
  anchors (event records, verdict fields, capture and receipt sha256), so a
  rebuild restores the evidence itself; the bytes (receipts, captures) and the
  PII stay store-only and a rebuild is expected to lose *them* (that is the
  design, not a gap).
- **The seller's own confirmation (or an arbitration outcome) is the only
  trigger for release** — no rail API, no buyer claim alone, no silence.
- **The engine never touches fiat** — buyer → seller, directly, on every rail.
- **Fail closed** — an unreachable node or an unresolved dispute never advances
  a state.
- **No consensus change for phases 1-6.**

---

## 22. Compliance note

Mainland China restricts domestic crypto trading (PBOC et al., 2021-09-24
notice). This document is a technical settlement design, not legal advice;
whether and where to offer CNY P2P — jurisdiction, user eligibility, and
geofencing — is an operator decision to make before shipping to users.

---

## 23. Test plan

- **Engine unit tests** (`services/p2p-engine/test`): signed
  proof/confirm/dispute happy paths, confirm before claim (allowed from
  `PAYMENT_PENDING` and `PAYMENT_CLAIMED`), confirm with open dispute (409),
  lock re-check fails closed, idempotent proof overwrite, PII never in the
  anchored record, CNY claim transitions (`state.test.ts`).
- **Conflict policy + automatic resolution** (`cny.test.ts`, `state.test.ts`,
  `escrowSettle.test.ts`): cancel/expire barred over a payment claim or an open
  dispute (seller cancel only pre-instructions, buyer cancel only pre-claim),
  the confirm rescue from `PAYMENT_PENDING`, `CANCELLED → ESCROW_REFUNDED`
  settling through the refund spend, the sweep's silent-expiry refund and
  confirm-timeout auto-dispute (**never** an auto-refund over a claim), and
  self-executing `dispute/resolve` outcomes landing the presigned
  release/refund spends on-chain with the `dispute_resolve → expire → refund`
  unwind on the event log.
- **Device-side verification** (`verify.test.ts`,
  `packages/p2p-protocol/test/verify.test.ts`,
  `services/p2p-verify/test/extract.test.ts`): the four field checks fail
  closed, side = the signer's role, claim/observation transaction id mismatch reported
  not fatal, policy-gated machine confirm (`off` | `seller_receipt` |
  `two_sided` | `verified_receipt`, default `off`), a frozen swap never
  advances, and the WeChat / Alipay / bank entry extraction (amount, transaction id,
  memo, counterparty, time) with the card-number-not-the-amount and
  date-not-the-amount guards. The verdict anchors minus PII — fields + capture
  hashes on the `payment_verify` record (validated by `validateP2pSwapRecord`),
  the counterparty name never on chain.
- **Order book + watcher** (`orderRoutes.test.ts`, `replay.test.ts`,
  `packages/p2p-protocol/test/orderRecord.test.ts`): txid-gated intake (409
  until `CONFIRMED`, idempotent re-post, orderId collision), cancel (404/403/
  409/idempotent), match-after-cancel 409, reopen-on-anchor-failure; the
  projector's open/cancel/match application, bad-signature and unknown-type
  skips, conflict reporting, fail-closed unservable head / truncated walk,
  cursor restart, and `replayVerify` missing/extra diffs. App side:
  `signP2pRecord` cross-checked against `record-sig`'s `verifyRecordSig`
  (`expo-app/sources/lib/__tests__/p2pIdentity.test.ts`) and the i18n key
  parity guard for the new cancel strings.
- **e2e** (`e2e/playwright/tests/p2p-demo.spec.ts`, `p2p-settlement.spec.ts`
  pattern): two-wallet flow with the fiat leg — seller profile, match, lock,
  buyer proof upload, seller confirm, release verified on-chain (the fiat leg's
  assertion is the state machine + anchor, since there is no rail API to poll).
- **Chain order-book e2e** (`e2e/e2etest.sh p2p-orders` →
  `e2e/playwright/tests/p2p-orders.spec.ts`): starts `e2e/l1social.sh up` plus
  two chain engines — intake (`E2E_P2P_ORDERS_URL`) and a cold replay instance
  (`E2E_P2P_REPLAY_URL`) — then, via the `e2e/p2p-order-chain.mjs` fixture
  (keygen / fund / anchor-order / sign), asserts: seller-anchored
  `social.p2p-order` OPEN + txid-gated 201, idempotent re-post, unknown-txid
  409 never indexed, cold replay indexing the OPEN record from the chain alone,
  buyer match (201 + engine-anchored swap → both books flip MATCHED), anchored
  cancel (200 + idempotent → both books CANCELLED), cancel-of-matched /
  match-of-cancelled 409, unknown 404, non-seller 403, both watchers settling
  with no errors, and intake-vs-replay order-set equality per status. The spec
  skips unless the part's env is present, so `all`/`remaining` greps stay green
  without L1-SOCIAL.
- **Dispute e2e**: claim → dispute → arbitration resolve `refund` → escrow
  refund verified on-chain; and the mirror `release` case where the seller won't
  sign (engine + buyer force-release).
- **Replay projector unit tests** (`services/p2p-engine/test/replay.test.ts`):
  chain-walk sync + cursor advance, idempotent re-application, seller cancel
  and match-after-cancel conflict reporting, `MATCHED` claimed from the engine
  swap event, bad-signature/unknown-type records skipped (fail closed),
  unservable-head and truncated-walk safety, replay after an unserved cursor,
  and `replayVerify` drift detection (`missing` / `extra`).
- **Reputation** (`services/p2p-engine/test/reputation.test.ts`): outcome
  attribution (completed / expired / cancelled / refund, dispute losers),
  latency averages, pair-cap wash resistance with raw totals, tier
  thresholds, PII never in the summary, and the routes (public summary,
  seller badge embed in `/public/orders`, zero-fill for unknown DIDs,
  admin-only per-swap attribution).
- Java-first rule from `AGENTS.md` applies to anything touching the chain —
  but this plan changes no chain code, so no Java surface is expected.

---

## 24. Removed from dai

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

---

## 25. Reputation — derived, public, wash-resistant

Reputation for sellers and buyers is **derived from the anchored swap log**,
never stored or anchored as its own fact: every input (status transitions,
dispute outcomes, timings) is something both parties already signed, and the
`social.p2p-swap` anchor makes it verifiable. It is computed on read
(`services/p2p-engine/src/reputation.ts`, pure — no writes, no new durable
state), so it cannot drift from the event log.

**Role-aware.** A DID has separate seller and buyer profiles — a reliable
seller can still be a slow payer.

**What counts.** Terminal swaps only (`COMPLETED` / `EXPIRED` /
`ESCROW_REFUNDED` / `CANCELLED`):

| Signal | Effect |
|---|---|
| `COMPLETED` | `completed` + volume (want + give units) for both roles |
| `EXPIRED` | `expired` — the buyer no-show counter |
| `ESCROW_REFUNDED` | `refunded`; with `disputeOutcome: "refund"` also the buyer's `lostDisputes` |
| `disputeOutcome: "release"` | the seller's `lostDisputes` |
| event timings | buyer `avgPayMs` (match → claim); seller `avgConfirmMs`, `avgReleaseMs` |

`completionRate = completed / (completed + expired + refunded)` — cancellations
are neutral (either party may cancel before payment) and reported separately.

**Wash-resistant.** At most **3 swaps per counterparty pair** count toward the
aggregates (`pairCap`), oldest first — two colluding DIDs cannot inflate each
other with unlimited trades (§12), while raw totals stay visible (`rawTrades`).
Velocity limits (§16) still apply on top.

**Tiers** — transparent thresholds, not a magic score:
`trusted` ≥ 10 counted trades, ≥ 95% completion, zero lost disputes;
`established` ≥ 3 counted trades, ≥ 80% completion; otherwise `new`.

**Visibility.** Public summary for anyone — `GET /public/reputation/:did`
(PII-free counts, rates, latencies, tier — including `trades30d`, counted
outcomes in the last 30 days; zero-filled for unknown DIDs) and per-seller
`sellerReputation` embedded in `GET /public/orders`. The per-swap attribution
behind the summary is admin-only (`GET /admin/reputation/:did`).
The wallet badges order cards with tier stars plus
`{{trades30d}}/30d · {{trades}} trades · {{pct}}% completed` (i18n key
`p2p.rep`, 12 languages).

Reputation is **advisory**: it informs a counterparty's choice and never gates
a transition — no state-machine rule and no escrow path depends on it.

---

## 26. Target: the engine as a dispute-only attestor

Today the engine is in *every* swap: it authors the `social.p2p-swap` log,
relays payment instructions, and co-signs every release. Because the vault is
*any two of three* (§6), that is not required for the happy path — the seller
and buyer can settle cooperatively, and the engine is only needed when they
disagree or one goes offline. This section is the target shape: **the engine
becomes an attestor that is only active in a dispute.**

### 26.1 Cooperative happy path (no engine)

Both parties rebuild the identical deterministic spend skeleton (§6 Release,
Path B) and each signs the same sighash. To settle they must exchange the two
signature blobs. The channel is a party-authored record:

`social.p2p-release` (`packages/p2p-protocol/src/releaseRecord.ts`) — carries
`from` (the author), `to` (the swapId), `kind` (`release` | `refund`),
`escrowTxHash`, `toAddress` and `escrowSig` (a `SignatureBundle` hex over the
skeleton sighash). It is author-signed (`record-sig`) and anchored on
L1-SOCIAL, so the signature is public, self-contained and verifiable and no
server is in the path. Because the skeleton is deterministic, only the
signature crosses the wire — never the transaction bytes.

Wallet side (`expo-app/sources/lib/p2pEscrowCoop.ts`):
`buildCoopReleaseRecord` → `publishCoopRelease` (anchors it) on one side;
`acceptCoopRelease` verifies the counterparty's record against the locally
rebuilt skeleton (kind, destination, lock, valid signature) and
`combineCoopRelease` assembles and returns the raw tx. Fails closed on any
mismatch.

### 26.2 The engine must be able to *find* the swap to arbitrate it

If the happy path never touches the engine, the engine can only adjudicate a
swap it can reconstruct from the chain. So the parties must anchor the swap
terms and the lock tx hash (the seller already anchors `social.p2p-order`;
extend the same party-authored path to the swap terms + lock), and the engine's
projector (`replay.ts`) rebuilds the swap from L1-SOCIAL. The L0 release/refund
spend is itself the durable proof of settlement. **Status: not built** — the
swap log is still engine-authored.

### 26.3 Liveness: the engine still watches, and presign is the backstop

The engine must keep a read-only projection of its vaults running even when it
is not "asked", so it can run the deterministic sweeps (§12) — silent-expiry →
refund, confirm-timeout → auto-dispute — otherwise two silent parties strand
funds. For the "buyer paid, then both offline" case, the seller's Path B presign
(both release *and* refund, over the fresh outpoint) lets the closure finish with
nobody online; that is a small, optional re-introduction of the engine at lock
time purely for liveness.

### 26.4 Dispute

The aggrieved party asks the engine. The engine device-verifies the payer
(§12 — the paired `p2p-verify` / Mobile Agent read of the party's own rail
ledger) and, per the auto-release policy, completes the settlement:

- buyer paid, seller silent → `engine + buyer` forced release to the buyer's
  `receiveAddress`;
- buyer never paid, seller wants out → `engine + seller` refund.

The engine can never act alone and only ever pays the destination fixed at
match — it cannot redirect funds.

### 26.5 What stays invariant

- The engine is never a unilateral spender (always `engine + one party`).
- It holds no fiat and never touches it.
- Durable output is anchored first (release/refund spend on L0, records on
  L1-SOCIAL); the projection is rebuildable.
- The engine's escrow key is a vault participant regardless of whether it is
  asked to sign, so the dispute fallback always exists.

### 26.6 Open items

**Delivered (foundations of engine independence):**

- **`enginePubkey` pinned in the order record** (`P2pOrderRecord.enginePubkey`,
  `packages/p2p-protocol`) — the seller stamps the escrow participant it created
  the order against, so the buyer derives the *same* 2-of-3 vault from the chain
  without `GET /capabilities` and without being tied to one global engine.
- **Wallet-side L1-SOCIAL reader** (`expo-app/sources/lib/socialReader.ts`) — the
  app-side port of the engine's projector walk (`getTips` →
  `getBlockByHash` by prev-hash), extracting, verifying and classifying every
  `social.p2p-order` / `social.p2p-swap` / `social.p2p-release` record.
- **Chain-backed order book** (`expo-app/sources/lib/orderBook.ts`,
  `services/p2pChain.ts`) — `listOpenOrders()` folds the chain's order records
  (`foldOrderBook`: OPEN→ACTIVE, latest `orderSeq` wins, drops withdrawn /
  matched / expired / unverified) when `EXPO_PUBLIC_P2P_CHAIN_BOOK=1` and a
  social node is set, falling back to the engine. Vault derivation prefers the
  pinned key (`vaultEnginePubkey`) over `/capabilities`.

**Remaining:**

1. **Finish the swap path** — match and the swap view still call the engine;
   the swap record must carry `orderId` + `enginePubkey` (or the wallet reads
   the swap from the chain) so settlement uses the pinned key end to end.
2. **Party-authored swap/lock records** so the engine can arbitrate a swap it
   did not author (§26.2).
3. **Engine read-only watcher + sweeps** running even when no request arrives
   (§26.3).

---

## 27. Engine key: protection, rotation, attack surface

The engine identity is one ML-DSA-87 keypair. Its **public** half is now pinned
in the order and swap records (`enginePubkey`, §26); its **private** half
(`SETTLEMENT_ENGINE_KEY`) is the single most sensitive secret in the system.

### 27.1 What is secret, and what is not

| Value | On chain | Must stay secret |
|---|---|---|
| `enginePubkey` (prefixed pubkey) | yes (pinned in records; in the redeem script) | no |
| `SETTLEMENT_ENGINE_KEY` (seed) | no | **yes — compromise = the arbiter** |
| `SETTLEMENT_ADMIN_TOKEN` | no | yes (orders arbitration outcomes) |

`enginePubkey` is *not* a secret: it appears in every escrow redeem script the
moment a spend is broadcast. Publishing it in a record leaks nothing. Guard the
seed.

### 27.2 Protecting the key

- **Never on chain, never in the image, never in logs.** It lives only in
  `deploy/env/.env.p2p.<region>` (chmod 600, gitignored) and is passed to
  compose as `--env-file` (interpolation only). The engine binds `127.0.0.1`;
  no endpoint echoes the seed.
- **Prefer a dedicated private host** (§26, option B): the key should not sit on
  a shared, public, multi-tenant web VM.
- **Ideally an HSM/KMS** rather than a process env: a sign-only API the engine
  calls, so a disk/`ps`/log leak is not a key leak. Not built — env today.
- **Bounded power is the real defence of last resort.** The key cannot spend
  alone (2-of-3) and cannot touch fiat. A leaked seed means an attacker can
  *co-sign with one colluding party* and *forge anchor records/dids* — trust is
  gone, but funds are not instantly drainable without a party key.

### 27.3 Rotation

The vault is `f(seller, buyer, enginePub)`; a new engine key changes every
escrow address. Rotation is therefore **additive, never in-place**:

1. **Pin, don't re-read.** Because records now carry the `enginePubkey` they
   were created against (§26), a wallet derives the vault from the *pinned* key,
   not `/capabilities`. A rotation no longer silently re-points an in-flight
   swap. (Before this change it would have.)
2. **Retain old keys.** The engine must keep every key that still has an
   open swap or an unsettled dispute, and co-sign with the key matching that
   swap's pinned pubkey. **Delivered:** the engine now builds a keyring
   (`engineKeyring`) from `SETTLEMENT_ENGINE_KEY` (current) plus
   `SETTLEMENT_ENGINE_KEYS` (retained seeds) and co-signs with
   `engineSignerFor(swap.enginePubkey)` — failing closed when the pinned key is
   not held.
3. **Overlap and announce.** New orders pin the new key; old swaps finish on the
   old one; retire a key only when no swap references it.
4. **Anchors are per-record.** `social.p2p-swap` records verify against the
   author DID they carry, so old records stay valid after a rotation; only new
   records must be signed by a current key. The escrow key and the anchor/DID
   key being the same pair is a coupling to be aware of — rotating for one
   rotates the other.

### 27.4 Attack vectors

| # | Vector | Effect | Control |
|---|---|---|---|
| 1 | **Seller pins its own key** as `enginePubkey` | seller controls 2 of 3 → after the buyer pays fiat, the seller refunds/releases to itself → buyer loses fiat | **Delivered:** buyer validates `enginePubkey` against the trusted set (`P2P_ENGINE_PUBKEYS`) or its configured engine (`vaultEnginePubkey`, rejects a rogue pin) and the derived address against `escrowAddress` (`vaultMatchesAddress`) |
| 2 | **Substituted key via `/capabilities`/MITM** | wallet derives a vault that does not match the lock → signatures invalid, or a vault the attacker controls | `vaultMatchesAddress` (implemented): refuse to sign unless the vault hashes to `escrowAddress`; prefer the pinned record key over `/capabilities` |
| 3 | **Seed compromise** (env leak, VM breach, HSM absent) | attacker co-signs forced release/refund with a colluding party; forges anchors | HSM/KMS, private host, no logs; on-chain audit makes every co-sign visible |
| 4 | **Engine collusion with one party** | `engine + buyer` steals the seller's escrow (or `engine + seller` strands the buyer) | Residual, stated (§13). Mitigation: the escrow address is public, the spend is observable, reputation/anchor trails |
| 5 | **Pinned-key replay** of a `social.p2p-release` | none — the signature covers the specific skeleton (vault, outpoint, destination) | `acceptCoopRelease` checks kind/destination/lock; a different swap has a different sighash |
| 6 | **Destination swap in the skeleton** | counterparty signs a spend to an attacker address | `acceptCoopRelease` rejects a record whose `toAddress` ≠ the expected destination; the vault must match `escrowAddress` |
| 7 | **Downgrade to `/capabilities`** (pinned key absent) | reintroduces the MITM/live-key surface | Require the pinned key for new swaps; `/capabilities` only as a legacy fallback, still behind `vaultMatchesAddress` |
| 8 | **Record bloat / DoS** (~5.2 KB `enginePubkey` per record) | chain/store growth | Length-bounded (≤6000 hex chars) in both record validators |
| 9 | **Non-existent engine pin** | order the buyer can never settle (grief) | Same as #1 — a trusted-set check rejects unknown keys |
| 10 | **Key retention window** | old keys linger as attack surface | Retain only keys with open swaps; retire after settlement |
| 11 | **Sybil / flood** (a DID is a free key; public reads are unauthenticated) | burn the shared engine's CPU (PQ verify) and connections by rotating keys | Per-IP sliding-window cap (`SETTLEMENT_IP_RATE_LIMIT`, trusted `X-Forwarded-For`); per-DID read/write split; `reputationMap` is cached 30s. A shared nonce/rate store remains the multi-instance follow-up |
| 12 | **Nonce replay across a restart** | replay a captured signed write within the ±5 min skew after a restart drops the in-memory set | Nonce set persisted in pg (`p2p_nonces`) and re-hydrated at boot (docs §18.1); `mem`/`blob` keep the in-memory set only |

**The critical one is #1.** Pinning the key in a *seller-authored* record turns
the key from a server-provided fact into an attacker-influenceable one, so the
buyer **must** constrain it (allowlist / signed engine registry) — an arbitrary
`enginePubkey` is not trustworthy just because it is signed by the seller.
Everything else fails closed once `vaultMatchesAddress` is enforced.

### 27.5 Invariants to preserve

- A wallet signs **only** over a vault that reproduces the recorded
  `escrowAddress` (implemented as `vaultMatchesAddress`).
- The engine co-signs **only** with the key pinned in the swap it is settling,
  and only under protocol conditions.
- No secret (`*_KEY`, admin token) ever reaches a record, a log, or a client.

### 27.6 Status

- **Delivered:** `enginePubkey` pinned on `social.p2p-order` and
  `social.p2p-swap`; the wallet pins the order to its engine's key
  (`createOrder`) and derives the vault from the pin; wallet-side reader + chain
  order book; `vaultMatchesAddress` guard; `vaultEnginePubkey` trusted-set check
  (`P2P_ENGINE_PUBKEYS`); engine keyring + `engineSignerFor` (multi-key
  rotation) with `SETTLEMENT_ENGINE_KEYS`; the engine now **carries the pin on
  its stored order** (`p2p_orders.engine_pubkey`, schema + migration + replay),
  **derives the match address from the pinned key**, and **rejects a match for
  an order pinned to a key the deployment does not hold** (409).
