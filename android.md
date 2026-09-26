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
| `webapp/scripts/patch-android.mjs` | Post-`sync` patches: loopback-scoped cleartext + release signing config. `webapp/android/` is generated/gitignored. |
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
on native and, on web, a KV that `storage/secureWeb.ts` routes into Android
**EncryptedSharedPreferences** (Keystore-backed) via
`capacitor-secure-storage-plugin`:

- `initSecureStorage()` (awaited in `app/_layout.tsx` before `isReady`) preloads
  every plugin key into an in-memory cache.
- Reads are sync from the cache; writes/deletes update the cache and write
  through to the plugin asynchronously. Values left in localStorage are
  lazily migrated on first read (and removed from localStorage).
- In a plain browser (`window.Capacitor` absent) it is a localStorage
  pass-through, so the web deployment is unchanged.

## Dev workflow

```sh
# from the wallet repo root
npm? # this repo uses yarn@1.22
./webapp.sh                    # export web → cap sync → assembleDebug → install + adb reverse + launch
./webapp.sh --skip-build       # reinstall/launch the existing APK only
./webapp.sh --release          # signed release APK
./webapp.sh --aab              # signed App Bundle
```

`webapp.sh` resolves a JDK 21 (system JREs lack `javac`; Capacitor's AGP rejects
Java 25) and the Android SDK, and in dev mode reverses the API ports so the
device reaches a local stack.

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
   `app/build.gradle` on the next sync.
2. **Endpoints** — bake the production node/API URLs before exporting (the web
   build inlines them).
3. **Build**: `./webapp.sh --release` / `--aab`; verify with `apksigner verify`.
4. **Publish** — `./deploy.apk.sh --release` builds the signed Capacitor
   artifact via `webapp.sh` and uploads it to MinIO (`S3_*` from env). For a
   release APK it also writes `wallet-<env>-release-latest.json` (the OTA
   manifest). Pass `MANDATORY=true` to force the install.

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
`https://minio-s1001.bigt.ai/aifeeds-content/releases` and is overridable with
`EXPO_PUBLIC_OTA_BASE`. Only `--release` builds publish/consume a manifest — a
debug/release signature mismatch cannot install over the other, and
`versionCode` must strictly increase.

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

## Limitations / non-goals

- No native background features beyond the web app's.
- Cleartext permitted only for loopback; production uses https.
- iOS out of scope for this pass (same Capacitor project can target it).

## Open items

- Decide whether to retire `expo-app`'s native `android/` prebuild and the
  Expo docker APK build now that `webapp.sh`/`deploy.apk.sh` ship the Capacitor
  artifact.
