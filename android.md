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
   artifact via `webapp.sh` and uploads it to MinIO (`S3_*` from env).

## Limitations / non-goals

- No native background features beyond the web app's.
- Cleartext permitted only for loopback; production uses https.
- iOS out of scope for this pass (same Capacitor project can target it).

## Open items

- Decide whether to retire `expo-app`'s native `android/` prebuild and the
  Expo docker APK build now that `webapp.sh`/`deploy.apk.sh` ship the Capacitor
  artifact.
