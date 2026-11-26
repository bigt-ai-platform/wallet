# Signed redemption intents

A redemption moves value **out of custody**, so an API token is not enough: the
L1 account must sign the Ethereum destination, amount, asset and a nonce. The
server verifies that signature with the account's own L1 key (PQ or legacy EC),
stores the intent once, and only then queues a `redeem` operation.

The signature proves **who chose the destination**. It does not prove the
tokens were returned: after a spot trade the seller can keep an old deposit
credit while the buyer holds the tokens. A release therefore also requires a
**confirmed L1 transfer of the exact token and amount to the asset's
`redemptionAddress`**, named by the intent. That L1 transaction may back exactly
one release.

```
1. wallet pays   L1 USDT ──▶ issuer redemptionAddress        (tx H, memo M)
2. L1 key signs  { asset, account, amount, destination, H = l1TxHash, nonce, expiry }
        │
        ▼
POST /redeem-intents ──▶ verify key == account, signature, fields, expiry
        │                 verify H: confirmed output of the token/amount at
        │                 redemptionAddress carrying memo M for this account
        │                 (else 409 "not confirmed yet")
        │                 atomically: redeem_intents(nonce+hash) + operations(H/index) + debit
        ▼
executor ──▶ re-verify H/index/memo at finality ──▶ Treasury.release(asset, account, destination, external)
```

The payment must carry the **funding memo**

```
wallet-redeem:v1:<assetId>:<amountRaw>:<L1 account>
```

e.g. `wallet-redeem:v1:usdt:5000000:1FB3WS…`. The issuer recomputes it from the
intent; a return without the matching memo is ignored, so one account cannot
claim another account's transfer. The wallet sets it automatically
(`payOnLayer1` with `memo`) and shows it for manual senders.

A bare L1 transfer to the issuer without an intent has **no destination** and is
never released. `BigtAiRedemptionSource` still exists for diagnostics, but it
is no longer part of the live pass: it would consume the chain reference the
intent needs.

## Intent

Fixed order; do not reorder or add fields when signing:

```json
{
  "domain": "bigt-ai-wallet-redeem-v2",
  "network": "Mainnet",
  "assetId": "usdt",
  "account": "<L1 address>",
  "amountRaw": "2000000",
  "destination": "0x2222222222222222222222222222222222222222",
  "l1TxHash": "0x<64 hex>",
  "nonce": "8f3c…",
  "expiry": 1760000000000
}
```

- `network` must equal the server's `NETWORK` (`Mainnet` or `Test`).
- `account` is the L1 address (PQ hex or EC base58); the public key must derive it.
- `amountRaw` is smallest units at the L1 scale, and must be the **exact** value
  of the L1 output paid to the redemption address.
- `destination` is `0x` + 40 hex.
- `l1TxHash` is the L1 transaction that paid the tokens to the issuer. The hash
  may authorize one release only (unique `(chain, txHash, logIndex)`).
- `nonce` is 8–128 chars and unique per `(asset, account)`.
- `expiry` is Unix ms, in the future and at most 7 days ahead.

Message bytes = `JSON.stringify` of exactly that object (the server uses the
same order). Hash = `Sha256Hash.of(utf8(message))`.

The domain changed from `bigt-ai-wallet-redeem-v1` to `...-v2`: a v1 intent has
no funding reference, so a v2 server rejects it rather than releasing unbacked
value. Rebuild the wallet against the v2 signer.

## Wallet flow

`/deposit` → USDT → **Redeem to Ethereum**:

1. The card reads the issuer's `/assets` for `redemptionAddress` and the
   canonical `l1TokenId`, then matches that **exact** token id in the wallet's
   L1 balances (a same-named token is not accepted).
2. On submit it sends the amount with `payOnLayer1` (multi-key, like the Payment
   screen) to the redemption address **with the funding memo**, then signs and
   posts the intent with the returned transaction hash.
3. A fresh transfer may not be final on the node the issuer reads yet. The
   server answers `409 { retryable: true }` and the card retries the **same**
   signed intent; nothing is reserved until the output is confirmed.
4. Pending payments are persisted per outpoint on the device
   (`redeem.pendingFunding`, up to 50 records), reused only for the same
   account/asset/amount/network, and listed so the user can pick one to resume.
   A success clears only the accepted return, and resuming is checked before
   requiring a spendable balance. A hash can also be pasted into
   `redeem-funding-tx` — that transfer must carry the memo shown by the card.
5. A new L1 payment requires the issuer's canonical `l1TokenId` (no name
   matching) and the card asks for confirmation of the exact L1 amount, token,
   address and Ethereum destination before signing.

## Signing

**PQ (default keys):**

```ts
import { PQKey, Sha256Hash, Utils } from 'bigt-ai-ts';

const key = PQKey.fromPrivateKeyHex(seedHex);
const hash = Sha256Hash.of(new TextEncoder().encode(JSON.stringify(intent)));
const signature = Utils.HEX.encode(key.sign(hash).serialize());

await fetch('/redeem-intents', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    account: intent.account,
    assetId: intent.assetId,
    amount: intent.amountRaw,
    destination: intent.destination,
    l1TxHash: intent.l1TxHash,
    nonce: intent.nonce,
    expiry: intent.expiry,
    keyType: 'PQ',
    publicKey: key.getPublicKeyAsHex(),
    signature,
  }),
});
```

**Legacy EC:**

```ts
import { ECKey, Sha256Hash, Utils } from 'bigt-ai-ts';

const key = ECKey.fromPrivate(secretBytes);
const hash = Sha256Hash.of(new TextEncoder().encode(JSON.stringify(intent)));
const signature = Utils.HEX.encode(key.sign(hash).encodeToBitcoin());
// keyType: 'EC', publicKey: Utils.HEX.encode(key.getPubKey())
```

The signature covers the intent, **not** the HTTP body; adding `keyType`,
`publicKey` or `signature` to the body does not change the signed bytes.

## Response and failures

`200 { id, status: "pending" }` after the intent, the L1 reference and the
operation are committed (and the holder balance debited when it covers the
amount). The executor then releases via `Treasury`.

| Case | HTTP |
|---|---|
| signature invalid / key ≠ account | 401 |
| amount, destination, `l1TxHash`, nonce or expiry invalid | 400 |
| the L1 transfer is not indexed/confirmed yet | 409 `{ retryable: true }` |
| no confirmed output of the exact token/amount at `redemptionAddress` | 409 |
| the output does not carry this account's funding memo | 409 |
| nonce, intent hash or L1 funding already used | 409 |
| L1 verification not configured (`L1_URL` + `L1_ISSUER_KEY`) | 503 |
| `/redeem-requests` (unsigned) | 400 — use `/redeem-intents` |

The holder balance is bookkeeping, not authorization: a user who bought the
token on-market has no issuer balance and can still redeem, because the L1
return is what is being exchanged.

## Database

`redeem_intents` has `PRIMARY KEY (asset_id, account, nonce)` and a unique
`intent_hash`; `operations` has a unique `(chain, lower(tx_hash), log_index)`.
Both inserts and the balance debit happen in **one transaction**, so the DB
enforces the replay guards even with several API replicas and a worker cannot
claim the operation before its debit is committed.

The operation ref is the **canonical matched outpoint** returned by the
verifier (lower-case, no `0x`, real output index), never the client's spelling
or a hardcoded index. `schema.sql` normalizes pre-existing redeem refs and
**fails the migration** if two rows already share one return; reconcile those
before deploying.

`operations.destination` is the verified EVM address the treasury may pay;
`operations.payout_ref` is the payout/mint transaction hash, written before the
ledger settles so a requeue never pays twice. Apply the idempotent `schema.sql`
to an existing database (it adds `destination`, `payout_ref`, `scan_cursors`
and `mint_reservations`).

## What remains

- The treasury command must still enforce the approval policy and M-of-N; the
  intent proves *where*, the L1 return proves *that the tokens came back*.
- The issuer holds the returned L1 tokens at `redemptionAddress`. They are
  retired on the issuer's ledger and cannot be redeemed twice (unique ref); a
  future burn/treasury sweep can move them physically.
