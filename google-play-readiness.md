# Google Play Readiness — Wallet (`ai.bigt.wallet`)

Updated 2026-10-18. Supersedes the stale parts of `google-play-publish-plan.md`
(which predates the API 36 deadline and the current build state); keep that file
for the MainNet prerequisite background.

## Verdict at a glance

- **The gating task is a Play-policy review, not build work.** The app is a
  crypto wallet that also ships trading orders and a P2P fiat-settlement flow;
  Play's Digital Assets policy plus licensing rules in the target countries
  decide what may ship.
- The build pipeline is close: no progress blocker found beyond `versionCode`
  handling and secrets.
- The developer account has not been registered (per the old plan), and the
  org route (D-U-N-S verification) has a lead time — start it early.
- Listing assets are ~half done (icons exist; feature graphic, descriptions,
  and the privacy policy do not).

## 1. Hard requirements (Play, as of Oct 2026)

| Requirement | Status | Action |
| --- | --- | --- |
| targetSdk ≥ 36 — since Aug 31, 2026 new apps and updates must target Android 16 (API 36) | Likely done | Expo SDK 57 (`expo ~57.0.20`) defaults; no `expo-build-properties` override pins an older level. Verify the actual `targetSdkVersion` in the built AAB (`bundletool dump` or Play Console) before submitting. |
| AAB builds | Done | `eas.json` production profile: `android.buildType: "app-bundle"` |
| Monotonic `versionCode` | Missing | Nothing sets `android.versionCode` and no `"autoIncrement": true` in the production profile — EAS will keep producing the same code and Play will reject duplicates. Add `autoIncrement` (or manage `versionCode` manually). |
| Play App Signing / upload key | Decide | Simplest: let EAS manage credentials (`eas credentials`); record where the upload key is backed up. |
| 64-bit native support | Done | React Native defaults (no custom ABIs). |
| Developer account | Not started | Register at play.google.com/console ($25). For the bigt.ai **organization** account: organization verification incl. a D-U-N-S number, so start early. If it ends up a **personal** account (created after Nov 2023): 12 testers × 14 days closed testing before production access. |

## 2. Policy review (the real gate — do this before spending on assets)

| Topic | Why it applies | Action |
| --- | --- | --- |
| Crypto / Digital Assets | Wallet with token creation, order placement, and charts is in scope for Play's Digital Assets policy and possibly financial-services declarations | Confirm the permitted feature set for the target countries |
| P2P fiat settlement (CNY rails, 2-of-3 escrow) | The UI is shipped though the engine is not live; user-to-user crypto↔fiat facilitation is a regulated activity (VASP/MiCA-style rules) in many jurisdictions | Decide: exclude for Play builds, restrict by region, or obtain the licensing — legal review |
| Prediction market (`docs/prediction-market.md`) | Status: *proposed*. Real-money event contracts are gambling/prediction-market territory on Play (licensing requirements in most countries) | Keep out of Play builds unless licensed; re-check before shipping |

## 3. Store listing assets

| Asset | Status | Action |
| --- | --- | --- |
| App icon 512×512 | Source ready | Export from `expo-app/sources/assets/images/icon.png` (1024×1024) |
| Feature graphic 1024×500 | Missing | Needs design |
| Phone screenshots (≥2, ideally 6) | Raw material | Branded shots; `docs/p2p-demo/assets/screenshots/` can seed them |
| Short + full description | Missing | Write for the approved feature set (English; add zh-CN if listing in China stores—note: Play is not available in mainland China) |
| Category / tags | Pending policy review | Finance only if the crypto review passes; otherwise keep the listing on non-financial framing |
| Public app name / label | Pending | `app.config.js` currently labels the app "Wallet" — pick the store name (old plan says "Bapp") |

## 4. Play Console declarations

| Item | Status | Action |
| --- | --- | --- |
| Privacy policy URL | Missing | Host (plan suggests `https://bigt.ai/privacy`); must describe on-device key storage, what leaves the device (RPC endpoints, optional push tokens), and that no analytics are collected |
| Data safety form | Missing | No analytics SDKs found in `expo-app/package.json`; declare camera (QR scanning), notifications, and anything else actually transmitted |
| Content rating (IARC) | Missing | Answer the financial/crypto questions accurately |
| Target audience | Missing | 18+ given crypto/trading content |
| Financial features declaration | Missing | Required once the crypto/P2P feature set is settled (see §2) |
| App access (reviewer instructions) | Missing | Reviewers need a working path: wallet creation plus testnet funds/faucet instructions; make sure the testnet endpoints are reachable from review regions |
| Ads / news declarations | Trivial | No ads, not a news app |

## 5. Build & submit pipeline

| Item | Status | Action |
| --- | --- | --- |
| EAS project linked | Done | `extra.eas.projectId` present |
| `publish.yml` workflow | Present | Verify the Android job end-to-end with the production profile |
| GitHub secrets | Missing | `EXPO_TOKEN`, `GOOGLE_SERVICE_ACCOUNT` (used by the workflow) |
| `expo-app/secrets/google-service-account.json` | Missing | Create the GCP service account, grant it Play Console access, save the JSON (`eas.json` `submit.production.android.serviceAccountKeyPath` points there) |
| Closed testing track | Not started | Internal → closed (mandatory 14 days if personal account) → production with staged rollout |

## 6. Carried-over blockers from the old plan

- **MainNetParams EC/PQ key mismatch** — the app is Test-network only until the
  Bigtangle root keys accept post-quantum keys. Decide whether to fix before
  any store listing (a testnet-only wallet on Play is possible but odd) — this
  gated the old plan and still gates a meaningful release.

## Suggested order

1. Policy review for the Play-bound feature set (§2) — selects everything else.
2. Start account registration / org verification (lead time).
3. Fix `versionCode` handling + wire secrets; produce one signed AAB and verify
   `targetSdkVersion`.
4. Listing assets + privacy policy + declarations.
5. Internal testing → closed testing (14 days if personal account) → staged
   production rollout.
