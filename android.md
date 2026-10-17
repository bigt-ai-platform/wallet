# Android app: Capacitor wrap of the wallet web app

Status: plan + implementation. Goal: ship the **wallet web app as a standalone
Android app** — the same Expo/React Native Web UI, bundled and served on device
from a local `http://localhost` origin by [Capacitor](https://capacitorjs.com),
so there is no wallet-operated origin in the path. Mirrors `../dai/android.md`.

This replaces the native `expo run:android` build as the shipping Android client:
one UI (the web export) for browser and device, instead of a separate native
build path.

## Why

- The app is already an Expo Router app rendered with `react-native-web`; its
  shell (persistent **sidebar with icons** on desktop, **hamburger drawer +
  bottom tab menu** on mobile) is already the target style — see
  `expo-app/sources/components/Sidebar.tsx` and `expo-app/sources/app/(tabs)/_layout.tsx`.
- Wrapping the web export keeps **one component tree** for web + Android and
  avoids a parallel native UI.

## Architecture

```
expo-app  ──(expo export --platform web)──▶  expo-app/dist  ──(cap sync)──▶  webapp/android
   Expo Router + RNW                          static SPA                     Capacitor WebView
                                                                             served at http://localhost
```

| Path | Role |
| --- | --- |
| `expo-app` | The app. Expo Router; `web.output: "single"` (SPA). |
| `expo-app/dist` | Web export (`npx expo export --platform web`), the Capacitor `webDir`. |
| `webapp/` | Capacitor project (`webDir: ../expo-app/dist`, `androidScheme: http`). |
| `webapp/scripts/patch-android.mjs` | Post-`sync` patches: loopback-scoped cleartext + production signing config (fail-closed). `webapp/android/` is generated/gitignored. |
| `webapp/scripts/signing.mjs` | The signing guard: pins the certificate in `signing.sha256`, wires it into `app/build.gradle` for both build types, and re-checks a built artifact before it reaches a device or an upload. CLI: `node scripts/signing.mjs keystore` / `… artifact <apk\|aab>`. |
| `webapp/signing.sha256` | SHA-256 of the single certificate every APK/AAB carries. |
| `webapp.sh` | Build/install/run helper (see **Dev workflow**). |

## Shell (style parity with `../dai`)

- **Desktop web** (≥768px): persistent left **sidebar** with section headers and
  icon (symbol) rows — `Sidebar.tsx` (`NavSection`/`NavItemRow`).
- **Mobile web / device**: header **hamburger → drawer**, plus a **bottom tab
  menu** (`order · tokens · settings`) — `app/(tabs)/_layout.tsx`.
Both come from the shared component tree, so web and Android are identical.

## Branding / icons

The launcher icon and splash use dai's logo
(`../dai/apps/web/public/bigT_ai_192x192.png`), copied to `webapp/assets/icon.png`.
`@capacitor/assets generate --android` (wired into `add:android`, or
`npm run assets` from `webapp/`) regenerates the Android mipmaps + splashes;
`webapp/android/` is gitignored.

## Keys on device (Keystore)

The wallet's storage abstraction (`expo-app/sources/storage/index.ts`) uses MMKV
on native and, on web, a KV wrapper (`storage/secureWeb.ts`). Large non-secret
data (the encrypted wallet file, address, settings, discovery cache) lives in the
WebView's **localStorage**; Android **EncryptedSharedPreferences**
(Keystore-backed via `capacitor-secure-storage-plugin`) is reserved for genuine
key material — `isSecureKey()` in `secureWeb.ts`, empty today (see **Keystore
scope** below):

- `initSecureStorage()` (awaited in `app/_layout.tsx` before `isReady`) drains
  any legacy Keystore entries back to localStorage, then preloads key material
  into an in-memory cache.
- Reads are sync; writes/deletes update the cache and write through to the plugin
  asynchronously for key material, and go straight to localStorage otherwise.
- In a plain browser (`window.Capacitor` absent) it is a localStorage
  pass-through, so the web deployment is unchanged.

### Boot steps (diagnosing a slow / hanging start)

`initSecureStorage(onPhase)` reports three phases — `platform` → `storage` →
`ready` — and `app/_layout.tsx` renders `components/BootScreen.tsx` while it
loads (mirrors `../dai`'s `BootstrapGate`). The steps replace the blank frame
the app used to show, and the reporter logs each one (`[boot] <phase> <detail>`
— visible in `adb logcat` on a debug build; `transform-remove-console` strips it
from release).

Measured on an Honor LLY-NX1 (production 1.0.62), the `storage` step was the
hang: the RSA-2048 plugin (one private-key op per 245-byte block) held the whole
46 KB `device.walletEncryptedContent` blob — ~135 RSA ops on *every* cold start,
before anything rendered (the other 10 entries were ~370 B each).

### Keystore scope: only key material

As `../dai` does with its chat replica, large non-secret data no longer goes in
the RSA plugin. The wallet's only secret is the **scrypt-encrypted wallet file**,
which is self-protecting, so it is not Keystore key material either — the plugin
now holds nothing (`SECURE_PREFIXES` in `secureWeb.ts` is empty and exists for
future key material). Boot drops from ~9 s to sub-second: the `storage` step just
lists the plugin (empty after the first launch) and reads localStorage.

`initSecureStorage()` performs a one-time **drain**: on the first launch after
the update it reads each remaining legacy plugin entry and writes it back to
localStorage, deleting it from the plugin only once the localStorage copy is
safe. So an existing install keeps its wallet, address, settings and discovery
cache — the wallet file simply moves from `EncryptedSharedPreferences`
(`cap_sec.xml`) into the `http://localhost` localStorage. Trade-off: the
ciphertext is no longer device-bound, but it is still scrypt-encrypted, and the
per-block RSA cost was the entire startup delay.

## Dev workflow

```sh
# from the wallet repo root
npm? # this repo uses yarn@1.22
./webapp.sh                    # export web → cap sync → assembleDebug → install + adb reverse + launch
./webapp.sh --skip-build       # reinstall/launch the existing APK only
./webapp.sh --release          # signed release APK
./webapp.sh --aab              # signed App Bundle
./webapp.sh --force-reinstall  # uninstall first when install -r cannot update (wipes app data)
```

`webapp.sh` resolves a JDK 21 (system JREs lack `javac`; Capacitor's AGP rejects
Java 25) and the Android SDK, and in dev mode reverses the API ports so the
device reaches a local stack. Every build — debug included — is signed with the
production certificate: `patch-android.mjs` refuses to run without
`webapp/keystore.properties`, and `webapp.sh` re-checks the built APK against
the `webapp/signing.sha256` pin before installing it (a second key anywhere
turns the next upgrade into `INSTALL_FAILED_UPDATE_INCOMPATIBLE`).

Debug and release builds share that certificate, so switching between them is
an in-place `install -r` and never costs the device its data. When `install -r`
still cannot update the installed package, `webapp.sh` prints adb's reason and
stops instead of silently uninstalling; `--force-reinstall` opts into the wipe.

## Production release runbook

1. **Keystore** (once; never commit):
   ```sh
   keytool -genkeypair -v -keystore webapp/release.keystore -alias wallet \
     -keyalg RSA -keysize 2048 -validity 10000
   cat > webapp/keystore.properties <<EOF
   storeFile=$PWD/webapp/release.keystore
   storePassword=<store-pass>
   keyAlias=wallet
   keyPassword=<key-pass>
   EOF
   ```
   `patch-android.mjs` injects the signingConfig into the generated
   `app/build.gradle` on the next sync — after checking the keystore against
   the committed pin:
   ```sh
   node webapp/scripts/signing.mjs keystore   # must print "signing: keystore ok"
   ```
   The pin lives in `webapp/signing.sha256` (tracked). If the keystore ever
   holds a different certificate, update that file only after every installed
   copy has been uninstalled — otherwise those devices cannot upgrade in place.
2. **Endpoints** — bake the production node/API URLs before exporting (the web
   build inlines them).
3. **Build**: `./webapp.sh --release` / `--aab`; `webapp.sh` verifies the
   artifact itself (`signing.mjs artifact`), or check manually with
   `node webapp/scripts/signing.mjs artifact <apk\|aab>` / `apksigner verify`.
4. **Publish** — `./deploy.apk.sh --release` builds the signed Capacitor
   artifact via `webapp.sh` and uploads it to MinIO (`S3_*` from env). For a
   release APK it also writes `wallet-<env>-release-latest.json` (the OTA
   manifest). Pass `MANDATORY=true` to force the install. Before uploading it
   re-runs the signing check, warns if the currently published release carries
   a different certificate, and after uploading re-downloads the object to
   confirm both its sha256 and its signer.

## Automatic updates (OTA)

Analog of `../dai/apps/web/src/lib/updater.ts`. The release bucket
(`aifeeds-content`, `releases/`) is public-read, so the app needs no gateway:
it fetches the manifest directly and the manifest's `url` is the APK object.

| Piece | Role |
| --- | --- |
| `deploy.apk.sh` | Writes `wallet-<env>-release-latest.json`: `{versionName, versionCode, url, sha256, mandatory}` next to the release APK. |
| `expo-app/sources/lib/ota.ts` | Pure manifest url/parse/compare helpers (unit tested). |
| `expo-app/sources/services/updater.ts` | Fetches the manifest, reads the installed versionCode via the native plugin, drives install. |
| `webapp/native/updater/…` | `UpdaterPlugin` (`getVersion`, `install` via `PackageInstaller`) + `UpdateReceiver`; copied into the generated project by `patch-android.mjs`. |
| `expo-app/sources/app/_layout.tsx` | Auto-checks ~4s after first paint; installs mandatory updates silently, prompts otherwise. |
| Settings → Updates | Shows the installed version and a manual "Check for updates" button. |

The channel is baked at build time (`EXPO_PUBLIC_APK_ENV`, default
`production`); the manifest base defaults to
`https://s3.bigt.ai/apps/wallet/apk` and is overridable with
`EXPO_PUBLIC_OTA_BASE`. Debug and release builds share the one pinned
certificate, so either can install over the other, but only `--release` builds
publish/consume a manifest — and `versionCode` must strictly increase.

```sh
./deploy.apk.sh --env=production --release          # publish + manifest
./deploy.apk.sh --env=production --release --skip-build  # re-upload existing
```

## L0/L1 endpoint discovery

DNS is only the bootstrap for the **seed** set; the app then verifies every seed
and picks the best (details below). DNS is resolved over **DNS-over-HTTPS**
(`services/discovery.ts` → `lib/dnsseeds.ts`) because the WebView/RN runtime
cannot query SRV/TXT directly; DoH is ordinary HTTPS, so it works on web and
device (both `https://dns.google/resolve` and Cloudflare send
`Access-Control-Allow-Origin: *`). Override the resolver with
`EXPO_PUBLIC_DOH_URL`, the seed domain with `EXPO_PUBLIC_DNS_SEEDS_DOMAIN`
(default `bigtangle.org`).

Ops publishes, per network domain:

```
_bigtangle-l0.<domain>       TXT  "https://eu1.bigtangle.org" "https://eu2.bigtangle.org" "https://eu3.bigtangle.org"
_bigtangle-l1.<domain>       TXT  "https://ordereu1.bigtangle.org" "https://ordereu2.bigtangle.org" "https://ordereu3.bigtangle.org"
_bigtangle-l0._tcp.<domain>  SRV  0 0 443 eu1.bigtangle.org.
_bigtangle-l1._tcp.<domain>  SRV  0 0 443 ordereu1.bigtangle.org.
```

(TXT with several quoted strings or several RRs; SRV is an alternative giving
target + port. `A` records are used only to resolve SRV targets.)

`EXPO_PUBLIC_SEEDS_URLS` (comma-separated) points at the
[`bigtangle-seeds`](https://github.com/bigt-ai-platform/seeds) registries: the
client `POST`s `/serverinfolist`, keeps the active nodes for its chain (`L0`,
`ordermatch`) and caches them 1h. This is the *live* node list, so the compiled
`MAINNET_*_URLS` seeds (the censorable `NetworkParameters` set) are only a
fallback. The registry must be TLS-reachable from the app — an `http://`
registry is blocked by the WebView/Android cleartext policy, so expose it over
https (a wallet-domain `/seeds/` proxy, or a cert on the registry itself).

Verify a registry serves usable nodes with the same code path the app uses:

```sh
yarn verify:seeds https://eu.wallet.bigt.ai/seeds L0      # exit 1 if none healthy
yarn verify:seeds http://92.5.34.128:8089 ordermatch
```

A newly published seed is picked up on the next refresh (1h cache) with **no
client rebuild**; `expo-app/sources/lib/__tests__/seeds-discovery.test.ts`
covers exactly that against a mock registry + node.

Then, per role L0/L1, the client:

1. resolves the DNS seed list **and the seeds registry** (both cached 1h) and
   unions them with the static `MAINNET_*_URLS` fallback **and the peers it
   reached before**;
2. health-checks every candidate with `POST /getChainNumber` — the
   `checkchain.sh` rule: HTTP 200, no `errorcode`, and `txReward.chainLength`;
3. ranks by chain length then latency (cached 10 min), uses #1 and fails over
   down the list; a failing base is demoted for the session.

**Learned peers (anti-censorship).** Every base that answered a request is
persisted (`discovery-learned/<net>/<role>`, most-recent first, cap 16) and
folded back into the candidate set. So if the seeds are later blocked, the app
still has a way back in without any seed or DNS — the seed set is needed at most
once. Scoped per network (`dev`/`test`/`main`) so networks never mix.

**Tor.** `.onion` entries from the seeds registry are accepted and tried *last*
(clear-net always preferred); they need a Tor route, so the plain app skips them
and they never block a clear-net request.

DNS discovery is native-mainnet only: the browser build can only reach its
same-origin `/l0/`,`/l1/` proxy (the chain nodes send no CORS), so remote seeds
would be unusable there. To discover *more than the seeds*, the network itself
must return its peer list (a public `/seeds`-style RPC); `/getPeers` exists but
returns no public URLs today.

## P2P settlement engine

The P2P screen talks to `services/p2p-engine`, which is **not** part of the
Capacitor bundle — it is a host-side service. The web build bakes the
same-origin `/p2p` path (`deploy/tag.sh`, proxied by the deploy stack's Caddy),
but the Android app is served from its own local asset origin, so a relative
`/p2p` would resolve to the WebView itself. Native builds therefore use the
public engine directly, `PROD_P2P_URL` (`https://wallet.bigt.ai/p2p`, the apex
vhost's `/p2p/*` route) — the same "direct endpoint" rule as L0/L1 (see
`IS_WEB_BROWSER` in `constants/app.ts`). Cross-origin is a non-issue: the
Capacitor `CapacitorHttp` plugin (enabled in `capacitor.config.json`) performs
`fetch` natively, so the engine does not need the WebView origin in
`CORS_ORIGIN`.

For local development use `./webapp.sh --with-p2p`: it starts the engine,
reverses its port, and bakes `EXPO_PUBLIC_P2P_ENGINE_URL` (overriding the
default) into the export.

Release builds should also bake `EXPO_PUBLIC_P2P_ENGINE_PUBKEYS` with the
deployed engine's escrow public key(s). With an empty allowlist a device has no
trusted key, so it cannot reject a seller-pinned rogue `enginePubkey`
(docs/p2p.md §27.4 #1) — the built-in engine URL does not by itself constrain
which vault the wallet will sign for.

## Limitations / non-goals

- No native background features beyond the web app's.
- Cleartext permitted only for loopback; production uses https.
- iOS out of scope for this pass (same Capacitor project can target it).

## Open items

- Decide whether to retire `expo-app`'s native `android/` prebuild and the
  Expo docker APK build now that `webapp.sh`/`deploy.apk.sh` ship the Capacitor
  artifact.
