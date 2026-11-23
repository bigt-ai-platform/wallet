# Signed redemption intents

A redemption moves value **out of custody**, so an API token is not enough: the
L1 account must sign the Ethereum destination, amount, asset and a nonce. The
server verifies that signature with the account's own L1 key (PQ or legacy EC),
stores the intent once, and only then debits the holder balance and creates a
`redeem` operation.

```
L1 key signs { asset, account, amount, destination, nonce, expiry }
        │
        ▼
POST /redeem-intents  ──▶ verify key == account, signature, nonce, expiry
        │                 store redeem_intents (nonce + hash unique)
        │                 debit holder balance → operation.destination
        ▼
executor ──▶ Treasury.release(asset, account, destination, externalRaw)
```

A `withdrawal` observed as an L1 transfer has **no destination** and therefore
fails closed (`release requires a verified destination`). The signed intent is
the only route that can release.

## Intent

Fixed order; do not reorder or add fields when signing:

```json
{
  "domain": "bigtangle-wallet-redeem-v1",
  "network": "Mainnet",
  "assetId": "usdt",
  "account": "<L1 address>",
  "amountRaw": "2000000",
  "destination": "0x2222222222222222222222222222222222222222",
  "nonce": "8f3c…",
  "expiry": 1760000000000
}
```

- `network` must equal the server's `NETWORK` (`Mainnet` or `Test`).
- `account` is the L1 address (PQ hex or EC base58); the public key must derive it.
- `amountRaw` is smallest units at the L1 scale.
- `destination` is `0x` + 40 hex.
- `nonce` is 8–128 chars and unique per `(asset, account)`.
- `expiry` is Unix ms, in the future and at most 7 days ahead.

Message bytes = `JSON.stringify` of exactly that object (the server uses the
same order). Hash = `Sha256Hash.of(utf8(message))`.

## Signing

**PQ (default keys):**

```ts
import { PQKey, Sha256Hash, Utils } from 'bigtangle-ts';

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
import { ECKey, Sha256Hash, Utils } from 'bigtangle-ts';

const key = ECKey.fromPrivate(secretBytes);
const hash = Sha256Hash.of(new TextEncoder().encode(JSON.stringify(intent)));
const signature = Utils.HEX.encode(key.sign(hash).encodeToBitcoin());
// keyType: 'EC', publicKey: Utils.HEX.encode(key.getPubKey())
```

The signature covers the intent, **not** the HTTP body; adding `keyType`,
`publicKey` or `signature` to the body does not change the signed bytes.

## Response and failures

`200 { id, status: "pending" }` after the balance is debited and the operation
is created. The executor then releases via `Treasury`.

| Case | HTTP |
|---|---|
| signature invalid / key ≠ account | 401 |
| amount, destination, nonce or expiry invalid | 400 |
| insufficient balance | 409 |
| nonce or intent hash already used | 409 (operation marked `failed`) |
| `/redeem-requests` (unsigned) | 400 — use `/redeem-intents` |

## Database

`redeem_intents` has `PRIMARY KEY (asset_id, account, nonce)` and a unique
`intent_hash`; the DB enforces the replay guard even with several API replicas.
`operations.destination` is the verified EVM address the treasury may pay; it is
required by `executeRelease`.

Apply the schema to an existing DB (the file adds the table and
`ALTER TABLE operations ADD COLUMN IF NOT EXISTS destination TEXT`).

## Wallet card

`/deposit` (USDT → Ethereum address step) has a **Redeem to Ethereum** card:
amount + Ethereum destination, signed with the wallet's Bigtangle key (PQ or
legacy EC) through `services/redeemIntent.ts` and posted to `/redeem-intents`.
The card is disabled until the issuer status API is configured
(`EXPO_PUBLIC_ISSUER_API_URL` or Settings → Ethereum → Bridge).

Covered by `sources/services/__tests__/redeemIntent.test.ts` (message order,
PQ/EC signing, account mismatch, submit/error) and the `ethereum.spec.ts`
USDT-deposit spec (the mock asserts the posted proof and destination).

## What remains

- The treasury command must still enforce the approval policy and M-of-N; the
  intent proves *where*, not *that a human approved*.
