# External assets (HKDAP) in the wallet

**Status: implemented** — registry, distributor API adapter, screen, 12-locale
strings and unit tests. No chain-side work, no bridge.

> **Updated 2026-11-19.** The registry now carries the four tradable assets
> (`HKD`, `USD`, `GOLD`, `ETH`) alongside HKDAP, which stays rail-only. Market
> definitions live in `expo-app/sources/lib/markets.ts`, the issuer service in
> `services/asset-issuer`. See
> [`external-assets-order-trade.md`](./external-assets-order-trade.md) for the
> design and [`external-assets-backlog.md`](./external-assets-backlog.md) for
> what is still open.

This is the wallet half of **Track A** in `../blockchain/plan/hkd.md` §7: HKDAP
(HKD At Par) is an external, permissioned ERC-20 issued by Anchorpoint on
Ethereum mainnet and reachable only through an authorised distributor. We
integrate it; we do not issue, redeem or bridge it.

## 1. Why not treat Ethereum as an L1

The L0↔L1 bridge (`bigtangle-bridge`: `BridgeService` + `AnchorService`) assumes
the L1 is a **bigtangle node**: it signs `LayerAnchor`s from a local block
store, mints wrapped tokens as zero-input `CROSSTANGLE` blocks, and takes
peg-out burns from the anchor payload. An Ethereum chain has none of those
producers, so plugging it in would mean an off-chain relayer that signs state
roots L0 cannot verify — a federated multisig peg, not the vault peg.

`plan/hkd.md` §7.2 already rates that path **"Hard; separate project, not v1"**
and recommends the distributor/custodian API instead. This module is that
option.

## 2. What the wallet does and does not do

| | |
|---|---|
| Holds HKDAP | Through the distributor. The wallet keeps **no Ethereum key** for it and signs nothing. |
| Balances / statement | `GET` from the distributor, rendered as-is. |
| Transfer | A **request** to the distributor; the distributor executes and settles. |
| Mint / redeem | A **request** to the distributor (issuer-side operation, may need paperwork). |
| Keys | None are involved, so **PQ wallets can use this too** — unlike the EC-only Ethereum screens. |
| Contract address | Not shipped. Fake HKDAP tokens exist; the address comes from the distributor. |

## 3. Where it lives

| File | Responsibility |
|---|---|
| `expo-app/sources/lib/externalAssets.ts` | Registry (`HKDAP` first), decimals/finality/destination metadata, compliance flags, exact amount parse/format |
| `expo-app/sources/services/distributor.ts` | Distributor API client, settings (device KV), read/write calls, local validation |
| `expo-app/sources/app/external-asset.tsx` | Screen: connect → balances → transfer → mint/redeem → statement |
| `sources/lib/__tests__/externalAssets.test.ts`, `sources/services/__tests__/distributor.test.ts` | Unit tests |
| `sources/app/_layout.tsx`, `sources/components/Sidebar.tsx` | `/external-asset` route under NETWORK |

Adding an asset is a data change in `externalAssets.ts`; the screen iterates the
registry and renders whatever compliance flags the entry declares.

## 4. Distributor API contract

The vendor contract does not exist yet, so the wallet defines what it needs.
Amounts are decimal strings in the asset's **smallest units** (HKDAP: 6
decimals — never assume 2), and `assetId` is the registry id (`hkdap`).

```
GET  {api}/balances?account=<addr>
  -> { items: [{ assetId, available, pending? }] }

GET  {api}/statement?account=<addr>&limit=<n>
  -> { items: [{ id, assetId, direction: 'in'|'out', amount,
                 status, at?, counterparty?, memo?, hash? }] }

POST {api}/transfers        { account, assetId, to, amount, memo? }
POST {api}/mint-requests    { account, assetId, amount, reference? }
POST {api}/redeem-requests  { account, assetId, amount, reference? }
  -> { id, status }

GET  {api}/transfers/<id>   -> { id, status }
```

`status` is `pending | processing | completed | failed`. Because HKDAP declares
`settlementFinality: 'ethereum-finalized'`, the distributor should report
`completed` only once the Ethereum transfer is in a **finalized** block
(~12.8 min), not on a single confirmation. The wallet treats `completed` as
final and shows the rest as in-flight.

Unknown `assetId`s and malformed rows are dropped rather than rendered with a
guessed symbol or decimals.

## 5. Settings and secrets

Settings live in the device KV store (`['external','distributor']`): `apiUrl`,
`token` (bearer), `accountId` (defaults to the wallet address). Only the account
id, asset id, amount and recipient ever leave the device — there is no key
material on this rail to leak.

## 6. Safety rules

1. **EIP-55** — a recipient whose mixed-case checksum fails is rejected
   (address-poisoning protection), then normalized to the checksummed form.
2. **Exact amounts** — BigInt parsing with the declared decimals; over-precision
   and zero are rejected locally before a distributor round trip.
3. **Finality wording** — the screen states that the distributor settles on
   Ethereum and reports completion only after finality; the UI never implies
   instant settlement.
4. **Compliance is visible** — permissioned / allowlist / pauseable / freezeable
   / mint-redeem chips come from the registry entry, not from strings scattered
   in the UI.
5. **No contract address in the bundle** — see §2.

## 7. Testing

```bash
cd expo-app
npx vitest run sources/lib/__tests__/externalAssets.test.ts \
                 sources/services/__tests__/distributor.test.ts
npx vitest run sources/lib/__tests__/i18n.test.ts   # 12-locale parity
npx tsc --noEmit
```

The adapter tests stub `fetch`, so they need no network. There is no e2e against
a real distributor yet; when one exists, add a mock like
`e2e/eth-rpc-mock.mjs` plus a Playwright spec driving `ext-screen`.

## 8. Not in this change

- A real distributor API (endpoints above are the contract the wallet expects).
- Direct-Ethereum custody for HKDAP (`plan/hkd.md` §7.2 "Direct Ethereum"),
  which would reuse `lib/eth` and add `custody: 'self'` + a contract address.
- RedCoin (Track C, PSP API) — same registry shape, different adapter.
- Native HKD on `L1-order` (Track B) — issued by us, not an external asset.

---

**See also:** [`ethereum.md`](./ethereum.md) (self-custody ETH/ERC-20, EC keys),
[`external-assets-order-trade.md`](./external-assets-order-trade.md) (plan:
HKD, gold and ETH as tradable L1-order assets),
[`external-assets-operations.md`](./external-assets-operations.md) (runbook)
and [`assets-deposit-withdraw.md`](./assets-deposit-withdraw.md).
