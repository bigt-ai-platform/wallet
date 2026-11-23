# Asset issuer key-risk review (USDT rail)

**Scope:** the deployed wallet services that touch value or keys — `asset-issuer`
(HTTP + scanner/executor + sweeper), its Postgres, the Ethereum deposit rail,
and the future redemption/treasury leg. Adjacent keys (P2P engine, wallet
device) are listed where a compromise crosses into the issuer.

**Decision:** Postgres stays the authoritative ledger. L1-SOCIAL is an audit /
attestation target only (hashes, never keys or PII). This review is about the
keys that authorize value movement, not about replacing the DB.

**Severity:** Critical = direct loss of user funds or unbacked supply;
High = theft of a subset, persistent DoS, or a control that only works by
assumption; Medium = operational/privacy; Low = hygiene.

---

## 1. Assets at risk

| Asset | Why it matters |
|---|---|
| L1 USDT supply | Each unbacked mint is a claim on the reserve; `supply <= reserve` is the solvency line |
| Ethereum USDT in custody | Deposits awaiting credit, plus the redemption float |
| Per-user deposit addresses | Sweepable with `DEPOSIT_XPRV`; a leak drains them |
| Holder balances in the DB | `/transfers` and `/redeem-requests` can move them |
| PII / mappings | Deposit address ↔ L1 account, payment profiles, receipts |
| Availability | A stalled scanner/executor means deposits are not credited |

## 2. Key inventory

| Key | Type / location today | Authority | Blast radius if compromised |
|---|---|---|---|
| `L1_ISSUER_KEY` | ML-DSA seed, env of the `loop` worker, loaded by `PQKey.fromPrivateKeyHex` (`l1.bigtangle.ts`) | reissue/mint + pay holder | **unbacked L1 supply**, up to asset caps |
| `ISSUER_SIGNERS` / `signnumber` | public keys + threshold in `ASSETS_JSON` | M-of-N reissuance | a stolen single share is not enough *if* threshold > 1 |
| Chain **domain key** | operator/chain-held, required on top of the issuer key | validates reissuance | minting stops if lost; misuse is a chain-level event |
| `DEPOSIT_XPUB` | public BIP32 xpub, env/config of `serve` | derive receive addresses | privacy (watch all addresses), **not** theft |
| `DEPOSIT_XPRV` | private BIP32 xprv, env of the `sweep` job | spend every deposit address | **drains all sweepable deposits** |
| `SWEEP_*` settings | env (`SWEEP_MIN_RAW`, gas limit, reserve) | how much is swept | unprofitable sweeps / stranded dust |
| Ethereum custody key (future) | HSM/MPC, `Treasury` adapter | release ERC-20 on redemption | **drains the redemption float** |
| DB credentials | `POSTGRES_URL` / `DATABASE_URL`, compose env | read/write ledger | **effective mint authority**: insert pending ops/reserve (see A4) |
| API credential | `distributor.ts` sends a bearer token; **server does not verify it** | account actions | move any holder's balance (A5) |
| RPC URL / provider key | `ETH_RPC_URL`, region `/eth` | read chain data | false finality/balances; quota abuse; not direct theft |
| P2P engine key | `SETTLEMENT_ENGINE_KEY` (ML-DSA), `/run/p2p-secrets` | anchor/escrow co-sign | P2P settlement integrity |
| P2P blob key | `SETTLEMENT_BLOB_KEY` (AES-256-GCM) | decrypt store-only data | PII/proofs/escrow signings |
| User wallet key | device Keystore / encrypted file | sign user txs | that user's funds only |

---

## 3. Risk register

### A. Issuer L1 key (`L1_ISSUER_KEY`)

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| A1 | Seed in process memory (env → `PQKey`) | full mint authority | **implemented:** `L1_SIGNER=command` + `L1_MINT_COMMAND` keeps the key in an HSM/MPC process; local key is opt-in, `ALLOW_LIVE_L1=1` gate | local mode still has the seed in memory; HSM policy is operator-side | deploy `L1_SIGNER=command` in production; never put the seed in the HTTP service; HSM M-of-N | Critical |
| A2 | Threshold = 1 (default `signers`) | one key mints alone | config supports M-of-N | operators can deploy threshold 1 | require `signnumber >= 2`, separate custodians, ceremony | Critical |
| A3 | Worker trusts DB operations | DB write = mint | **implemented:** executor re-verifies the receipt, log index, amount, recipient and `finalized` before minting, and claims atomically | `mint`/API rows still trust the reserve + auth; DB least privilege remains | keep the verifier mandatory (fail closed without `ETH_RPC_URL`); split DB roles; admin-auth mint requests | Critical |
| A4 | Domain key loss/rotation | minting halts | none in this repo | no runbook | document custody, test on Test, M-of-N for the domain key too | High |
| A5 | No independent supply cap at the signer | a compromised worker can mint up to `maxSupplyRaw` | config caps | caps live in the same DB/config the attacker may control | enforce caps in the HSM policy / on-chain policy, not only in the service | High |
| A6 | Replay/duplicate reissuance | double mint | operation state machine + unique chain refs | `reissue` then `pay` is not atomic; a retry after a partial failure may reissue again | idempotency at the signer/chain level; reconcile `getTokenSignByTokenid` and token supply before retry | High |
| A7 | Key rotation during live swaps | stuck mints | — | no rotation procedure | drain pending ops, rotate signer list + policy, keep old share until drained | Medium |

### B. Deposit xpub / xprv and the sweeper

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| B1 | `DEPOSIT_XPRV` leaks | drains every deposit address | **implemented:** `SWEEP_SIGN_COMMAND` (HSM/MPC) with local xprv fallback; signer must control the allocation; `ALLOW_LIVE_SWEEP=1` | local xprv path is still hot; HSM policy is operator-side | use the command in production; testnet/small float only for local xprv; rotate xpub/sweep after a leak | Critical |
| B2 | xpub and xprv mismatch | deposits unspendable | sweep verifies derived key == allocation before signing | failure discovered only at sweep time | startup self-test: derive address 0 from xpub and xprv and compare; refuse to serve if they differ | High |
| B3 | xprv/seed lost | all deposit-address funds stranded | none | no backup requirement | offline backup (split/Shamir), restore drill, record path + index range | Critical |
| B4 | xpub leak | privacy: all addresses watchable | xpub only in `serve`/env | address clustering | acceptable if documented; rotate xpub for new cohorts; never reuse across envs | Medium |
| B5 | Index reuse after DB restore | two accounts map to the same address / wrong attribution | global unique `(account, address, index)` | a restored snapshot forgets recent rows; the chain still has the funds | reconcile `deposit_addresses` with a backup before allocating; never reset the index; anchor address-range commitments | High |
| B6 | Wrong `DEPOSIT_XPRV_PATH` | sweep refuses (safe) or wrong key (caught) | signer == allocation check | misconfiguration | same-path validation at startup; document xpub/xprv node | Medium |
| B7 | Sweep from an address without gas | funds stuck | planner marks `no-gas` | no top-up job | gas policy/top-up; monitor `no-gas` counts; raise `SWEEP_MIN_RAW` above gas cost | Medium |
| B8 | Concurrent sweeps / nonce race | failed tx, duplicate attempt | balance-based, sequential within a run | no global lock | single cron run; advisory lock; wait for receipt before the next pass | Medium |
| B9 | ERC-20 returns `false` but tx succeeds | balance not moved, no error | receipt status only | non-standard tokens | allowlist standard tokens; check balance delta / `Transfer` log | Medium |
| B10 | Sweep to a wrong/poisoned omnibus | loss | `custodyAddress` from config | config compromise | validate checksum + allowlist; signed config / change control | High |

### C. Ethereum custody / redemption (future)

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| C1 | Hot wallet key online | drains redemption float | `RefusingTreasury`; **implemented seam:** `TREASURY_RELEASE_COMMAND` gated by `ALLOW_LIVE_TREASURY=1` | destination binding + approval not implemented; keep the flag off | HSM/MPC + approval above threshold; float cap; resolve L1↔ETH at the signer | Critical |
| C2 | Release destination not authenticated | attacker redirects a redemption | **implemented:** `/redeem-intents` verifies an L1-key signature over account+amount+destination+nonce/expiry; `operations.destination`; `executeRelease` refuses without it; `/deposit` has the signing card | — | keep observed L1 transfers failing closed; test the card on device | Critical |
| C3 | Redeem from issuer float | releases value for its own stock | `BigtangleRedemptionSource` only reads `redemptionAddress` | a misconfig could point at the float | separate address, tests, reconcile supply vs reserve | High |
| C4 | No finality before release | reorg after release | design says L1 finality | not coded | finality gate, idempotent release | High |
| C5 | Approval bypass / replay | unauthorized release | — | no approval flow | signed intents, nonce/expiry, 2-person rule | High |

### D. Database

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| D1 | DB write access = mint authority | arbitrary pending ops | **implemented:** atomic claim + chain revalidation (A3) | `mint` requests are still reserve/auth-based; DB roles are not split | least-privilege roles (writer vs reader), audit triggers, admin auth on mint requests | Critical |
| D2 | DB credentials leak | ledger tampering, PII | compose env | `docker inspect`, backups, no TLS if remote | `_FILE`/secrets, TLS, rotate, separate roles, network policy | High |
| D3 | Restore from an old snapshot | replay / double mint | unique chain refs | restored state may be behind the chain | freeze mints, reconcile ops/refs with chain, then resume | High |
| D4 | No encryption at rest / RLS | PII + balances exposed | host disk | backups copied around | disk encryption, encrypted backups, access control, retention | High |
| D5 | Memory store on Test leaks idempotency | double mint if a Test run is treated as real | `NETWORK != Test` refuses without DB | operator could set Test in prod | immutable `NETWORK` in deployment, alert if memory store in prod | High |
| D6 | Asset seed drift | ops for an asset not in the DB / wrong decimals | `seedAssets` on `serve` boot | worker-only deploy does not seed | always start `serve` (or a seed job) before the worker; one `ASSETS_JSON` | Medium |

### E. API / account authority

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| E1 | No authentication on `serve` | anyone can `/transfers`, `/redeem-requests`, `/deposit-address` for any account | **implemented:** default-deny outside Test, `AUTH_MODE=bearer` or `hmac`, `/health` public | `bearer` is shared, not account-bound; `hmac` needs a signing client | set `hmac` (or a signing proxy) in production; keep the proxy; rate-limit | Critical |
| E2 | Account id spoofing | move another holder's balance | **implemented:** `hmac` ties `x-account` to the request account | `bearer` mode does not | require `hmac`/DID signatures for value routes; bearer only for reads if needed | Critical |
| E3 | Address-allocation spam | DB growth / index exhaustion | unique constraints | unauthenticated | auth + per-account cap + rate limit | Medium |
| E4 | Admin paths (`requeue`) | replay failed ops | code only | no role separation | admin auth + audit | High |

### F. RPC / provider

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| F1 | RPC lies about `finalized` | unbacked mint | `eth_getBlockByNumber('finalized')` | single provider | quorum across providers for large deposits; finalized block recorded with the operation | High |
| F2 | Provider key leaks | quota abuse / metadata | env or region proxy | — | proxy-held keys, rotate, per-IP limits | Medium |
| F3 | RPC outage | deposits not scanned | — | no queue/alert | multi-RPC, alert on scan lag, resume from cursor | Medium |
| F4 | Wrong chain/network | credits a testnet deposit as mainnet | `chain` recorded, config | operator error | chain id check at startup; refuse mismatched contract/chain | High |

### G. User-side keys (context)

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| G1 | Device compromise / malware | user funds | encrypted wallet, device auth | OS-level | device hardening, no key export without password, biometric + password fallback | Medium |
| G2 | Clipboard / address poisoning | send to a wrong address | EIP-55 + warnings | UI only | saved-address allowlist, first-use warning, full-address review | Medium |
| G3 | Wrong network deposit | loss | network gate | cannot recover on Ethereum | UI warning; support runbook | Medium |
| G4 | Malicious RPC | wrong nonce/gas, but signed intent is local | local signing | — | user-selectable RPC, multiple providers | Low |

### H. Adjacent P2P keys (only where they cross the issuer)

| ID | Risk | Impact | Current control | Gap | Mitigation | Sev |
|---|---|---|---|---|---|---|
| H1 | Engine key compromise | forged swap records/escrow co-sign | secrets file, additive rotation | hot process | HSM/MPC, rotate additively (`SETTLEMENT_ENGINE_KEYS`), monitor | High |
| H2 | Blob key + bucket access | PII/proofs/escrow signings | AES-256-GCM | key stored with data? | separate key custody, rotation/re-encrypt plan | High |
| H3 | Admin token | dispute/requeue authority | admin IP allowlist | token in env | short-lived tokens, audit | Medium |

---

## 4. Deposit-specific failure modes (keys involved)

1. **Address attribution** — without per-user addresses, an exchange-origin
   deposit is attributed to the sender. That is an operational loss
   (mis-credit), not a key compromise, but it is the reason `DEPOSIT_XPUB`
   exists. The xpub is public; the **mapping** is the sensitive part.
2. **Credit before finality** — the only remedy for a reorg after mint is a burn
   the holder never authorized. Keep the `finalized` gate, record the finalized
   block with the operation, and do not let a “confirmations” setting override
   it.
3. **Double credit/mint** — one scanner/executor, or an atomic claim +
   transactional reserve update. The DB unique key protects rows, not the
   read-modify-write reserve.
4. **Index/DB restore** — the xprv can regenerate addresses; the account
   mapping cannot. Reconcile before allocating after a restore.
5. **Sweep key** — the only key that can move deposit-address funds. Keep it out
   of `serve`, out of the scanner, and out of the host that serves HTTP.
6. **Gas** — a deposit address without ETH is safe but stuck; the planner skips
   it (`no-gas`). Budget a top-up policy.
7. **Token semantics** — fee-on-transfer or rebasing tokens break 1:1 credit;
   verify the received amount, not the requested amount.

## 5. Withdrawal/redeem-specific failure modes

1. **Destination binding** — a redemption observation carries the L1 redemption
   address, not an Ethereum address. Releasing to `account` directly is wrong;
   require a verified L1↔ETH mapping or a signed withdrawal intent.
2. **Float separation** — never release from the address that receives
   redemptions or holds freshly minted float.
3. **Approval** — a single hot key that can release is a single point of
   failure; use HSM/MPC and a second approval above a threshold.
4. **Replay** — sign the full intent (asset, amount, destination, nonce, expiry)
   and store the release reference; a retry must not release twice.

## 6. Cross-cutting controls

- **Key separation:** issuer mint key ≠ deposit xprv ≠ redemption hot key ≠ DB
  credentials ≠ RPC key. No key should be able to do two jobs.
- **Watch-only by default:** `serve` gets the xpub only; the worker gets the
  issuer key only; the sweep job gets the xprv only. Do not co-locate them.
- **Ceremonies:** generate the xprv/seed offline, split backups, record the
  derivation path and index range, test restore on a staging address.
- **Least privilege:** the HTTP service should have a DB role that can insert
  operations and read balances, not alter `reserves` or `deposit_addresses`
  directly. The worker needs the reserve-update role. The sweeper needs read on
  allocations + the custody key.
- **Audit:** log operation ids, chain refs, amounts and actor, never keys or
  seeds. DB audit triggers on `reserves`, `holder_balances`, `operations`.
- **Backups:** issuer DB (authoritative), `deposit_addresses` mapping, xprv
  backup, domain/issuer key shares, blob key + bucket. Test a restore and
  reconcile before resuming.
- **Rotation:** xpub for new cohorts; old xprv kept until swept; issuer M-of-N
  rotation with a drain; DB/RPC/admin tokens on a schedule; blob re-encryption
  when the AES key rotates.
- **Monitoring:** reserve breach, pending/failed ops, scan lag, `no-gas` sweeps,
  failed sends, DB auth failures, signer errors, capped mints.
- **Supply chain:** pin `secp256k1`/`@noble` versions, lockfiles, image digests;
  no secrets in build args; scan the runtime image.

## 7. Prioritized remediation

**P0 (before any real funds)**

1. **Done:** authenticate `serve` (`AUTH_MODE=bearer|hmac`, default-deny outside
   Test). Until `hmac` is deployed with a signing client, treat `bearer` as
   transport auth only (E1/E2).
2. **Done:** atomic claim + receipt/finality revalidation before minting
   (A3/D1). Split DB roles and admin-auth `mint-requests` remain.
3. **Seam done:** `L1_MINT_COMMAND`, `SWEEP_SIGN_COMMAND`,
   `TREASURY_RELEASE_COMMAND` (gated) keep keys out of the service. Still
   required: deploy them with an HSM/MPC policy and enforce M-of-N + caps at
   the signer (A1/A2/B1/C1).
4. Enforce caps at the signer/on-chain policy, not only in the service (A5).
5. **Done:** signed redemption intents (C2) including the `/deposit` signing
   card. Remaining: the signer-side approval policy/M-of-N.
6. Back up the xprv and the DB; test a restore + reconciliation (B3/D3).

**P1**

7. Startup xpub/xprv self-test (B2).
8. Multi-provider finality quorum (F1).
9. Sweep gas top-up policy and receipt wait (B7/B8).
10. Token allowlist + received-amount check (B9).
11. Separate DB roles and encrypted backups (D2/D4).
12. Resolve `processing` leases / stale ops (D3).

**P2**

13. L1-SOCIAL hash-only audit/attestation (no keys, no PII).
14. Key ceremony/rotation drills and incident runbooks.
15. Blob key rotation and PII retention.

## 8. Residual risks to accept explicitly

- A compromised host running the worker can mint up to the caps until the key
  is rotated; only an HSM policy + caps + monitoring reduce this.
- A compromised `serve` host can act for any account until API auth lands.
- ERC-20 USDT can freeze/blacklist addresses; the reserve can become
  non-transferable even with perfect key custody.
- A user who sends on the wrong network cannot be helped on Ethereum.

---

**See also:** [`usdt-issuer-deposit-withdraw.md`](./usdt-issuer-deposit-withdraw.md),
[`external-assets-operations.md`](./external-assets-operations.md),
`services/asset-issuer/src/l1.bigtangle.ts`, `src/executor.ts`, `src/sweep.evm.ts`,
`src/server.ts`, `src/store.pg.ts`.
