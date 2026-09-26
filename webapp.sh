#!/usr/bin/env bash
# webapp.sh — build the standalone Android app (Capacitor wrap of the wallet web
# export), install it on a USB device, and launch it. Mirrors ../dai/webapp.sh.
#
#   ./webapp.sh                    # export web → cap sync → assembleDebug → install + launch
#   ./webapp.sh --device=ALHX6R…   # pick a device when several are attached
#   ./webapp.sh --skip-build       # reuse the built APK (install + launch only)
#   ./webapp.sh --no-install       # build the APK only
#   ./webapp.sh --release          # assembleRelease (signed, needs webapp/keystore.properties)
#   ./webapp.sh --aab              # signed App Bundle
#   ./webapp.sh --env=production   # OTA release channel baked into the app
#
# Dev: the wallet's default node is http://localhost:8088 — reverse it (plus any
# extra ports in REVERSE_PORTS) so the device reaches a local node. For prod,
# the app's built-in https node URLs are used.
#
# Env: ADB, DEVICE, JAVA_HOME (JDK 21), ANDROID_HOME, REVERSE_PORTS, OUT_DIR,
#      APP_ENV (OTA channel), APP_VERSION/APP_VERSION_NAME/APP_VERSION_CODE.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

WEBAPP_DIR="$ROOT/webapp"
WEB_DIR="$ROOT/expo-app"
OUT_DIR="${OUT_DIR:-$ROOT/out}"
BUILD_TYPE="debug"
SKIP_BUILD=0
DO_INSTALL=1
DO_LAUNCH=1
DEVICE="${DEVICE:-}"
APP_ENV="${APP_ENV:-preview}"

# Wallet node (dev) + anything extra; space/comma separated.
REVERSE_PORTS=(${REVERSE_PORTS:-8088})
PKG="com.example.bapp.webapp"
ACTIVITY="$PKG/.MainActivity"

for a in "$@"; do
  case "$a" in
    --device=*) DEVICE="${a#--device=}" ;;
    --env=*) APP_ENV="${a#--env=}" ;;
    --release) BUILD_TYPE="release" ;;
    --aab) BUILD_TYPE="aab" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-install) DO_INSTALL=0 ;;
    --no-launch) DO_LAUNCH=0 ;;
    --help|-h) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

# Release version identity for the OTA updater: baked into the APK (gradle
# versionName/versionCode via patch-android.mjs) and written into the manifest
# by deploy.apk.sh. versionCode is a monotonic integer derived from semver so
# the on-device updater can compare regardless of tag formatting.
if [ -z "${APP_VERSION_NAME:-}" ]; then
  APP_VERSION_NAME="${APP_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)}"
  [ -n "$APP_VERSION_NAME" ] || APP_VERSION_NAME="$(node -e "console.log(require('./expo-app/package.json').version)")"
fi
BASE_VERSION="$(printf '%s' "$APP_VERSION_NAME" | sed -E 's/[-+].*$//')"
MAJOR="$(printf '%s' "$BASE_VERSION" | cut -d. -f1 | sed 's/[^0-9]//g')"
MINOR="$(printf '%s' "$BASE_VERSION" | cut -d. -f2 | sed 's/[^0-9]//g')"
PATCH="$(printf '%s' "$BASE_VERSION" | cut -d. -f3 | sed 's/[^0-9]//g')"
APP_VERSION_CODE="${APP_VERSION_CODE:-$(( (MAJOR * 1000000) + (MINOR * 1000) + PATCH ))}"
[ "${APP_VERSION_CODE:-0}" -gt 0 ] || APP_VERSION_CODE="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
export APP_VERSION_NAME APP_VERSION_CODE
# Release channel the OTA updater checks; inlined into the web bundle.
export EXPO_PUBLIC_APK_ENV="${EXPO_PUBLIC_APK_ENV:-$APP_ENV}"
# Version shown in Settings/About; inlined into the web bundle.
export EXPO_PUBLIC_APP_VERSION="$APP_VERSION_NAME"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass() { echo -e "  ${GREEN}PASS${NC} $1"; }
warn() { echo -e "  ${YELLOW}WARN${NC} $1"; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }
die()  { echo -e "${RED}[FAIL]${NC} $1" >&2; exit 1; }

APK="$WEBAPP_DIR/android/app/build/outputs/apk/$BUILD_TYPE/app-$BUILD_TYPE.apk"
if [ "$BUILD_TYPE" = "aab" ]; then
  APK="$WEBAPP_DIR/android/app/build/outputs/bundle/release/app-release.aab"
  DO_INSTALL=0
fi

ADB="${ADB:-}"
if [ -z "$ADB" ]; then
  for c in "$(command -v adb 2>/dev/null || true)" \
           "${ANDROID_HOME:-}/platform-tools/adb" "$HOME/android-sdk/platform-tools/adb" \
           "$HOME/Android/Sdk/platform-tools/adb" /opt/android-sdk/platform-tools/adb; do
    [ -n "$c" ] && [ -x "$c" ] && { ADB="$c"; break; }
  done
fi

resolve_device() {
  [ "$DO_INSTALL" -eq 0 ] && return 0
  [ -n "$ADB" ] && [ -x "$ADB" ] || die "adb not found — set ADB="
  mapfile -t DEVS < <("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}')
  if [ -n "$DEVICE" ]; then
    "$ADB" -s "$DEVICE" get-state >/dev/null 2>&1 || die "device '$DEVICE' not attached"
  elif [ "${#DEVS[@]}" -eq 1 ]; then DEVICE="${DEVS[0]}"
  elif [ "${#DEVS[@]}" -eq 0 ]; then die "no device attached"
  else die "multiple devices: ${DEVS[*]} — pass --device=<serial>"; fi
  pass "device $DEVICE"
}

resolve_jdk() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/javac" ]; then return 0; fi
  local c
  for c in "$HOME/.sdkman/candidates/java"/* /usr/lib/jvm/*21* /opt/*jdk*21* "$OUT_DIR/cache/jdk21"; do
    [ -x "$c/bin/javac" ] && { export JAVA_HOME="$c"; return 0; }
  done
  local dest="$OUT_DIR/cache/jdk21"
  info "no JDK 21 found — downloading Temurin 21 to $dest…"
  mkdir -p "$dest"
  curl -sfL --retry 3 -o "$OUT_DIR/cache/jdk21.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" \
    || die "JDK 21 download failed — install a JDK 21 and set JAVA_HOME"
  tar xzf "$OUT_DIR/cache/jdk21.tar.gz" -C "$dest" --strip-components=1
  rm -f "$OUT_DIR/cache/jdk21.tar.gz"
  export JAVA_HOME="$dest"
}

resolve_android_sdk() {
  [ -n "${ANDROID_HOME:-}" ] && { export ANDROID_SDK_ROOT="$ANDROID_HOME"; return 0; }
  for c in "$HOME/android-sdk" "$HOME/Android/Sdk" /opt/android-sdk /usr/lib/android-sdk; do
    [ -d "$c" ] && { export ANDROID_HOME="$c" ANDROID_SDK_ROOT="$c"; return 0; }
  done
  die "Android SDK not found — set ANDROID_HOME"
}

build_web_export() {
  info "Exporting the wallet web build (expo export)…"
  ( cd "$WEB_DIR" && CI=1 EXPO_NO_TELEMETRY=1 npx expo export --platform web --output-dir dist ) \
    || die "expo export failed"
  [ -f "$WEB_DIR/dist/index.html" ] || die "export produced no expo-app/dist/index.html"
  pass "web export → expo-app/dist"
}

build_apk() {
  info "Syncing Capacitor + building $BUILD_TYPE APK…"
  ( cd "$WEBAPP_DIR" && npx cap sync android && node scripts/patch-android.mjs ) || die "cap sync failed"
  resolve_jdk; resolve_android_sdk
  local task="assembleDebug"
  [ "$BUILD_TYPE" = "release" ] && task="assembleRelease"
  [ "$BUILD_TYPE" = "aab" ] && task="bundleRelease"
  ( cd "$WEBAPP_DIR" && ./android/gradlew -p android -Dorg.gradle.java.home="$JAVA_HOME" "$task" ) \
    || die "gradle $task failed"
  [ -f "$APK" ] || die "APK not found: $APK"
  pass "built $APK ($(du -h "$APK" | cut -f1))"
}

install_and_run() {
  if ! "$ADB" -s "$DEVICE" install -r "$APK" >/dev/null 2>&1; then
    warn "install -r failed — uninstalling $PKG and retrying"
    "$ADB" -s "$DEVICE" uninstall "$PKG" >/dev/null 2>&1 || true
    "$ADB" -s "$DEVICE" install "$APK" >/dev/null 2>&1 || die "adb install failed"
  fi
  pass "installed $PKG"
  for p in "${REVERSE_PORTS[@]}"; do [ -n "$p" ] && "$ADB" -s "$DEVICE" reverse "tcp:$p" "tcp:$p" >/dev/null 2>&1 || true; done
  pass "reversed ${REVERSE_PORTS[*]} → host"
  if [ "$DO_LAUNCH" -eq 1 ]; then
    "$ADB" -s "$DEVICE" shell am force-stop "$PKG" >/dev/null 2>&1 || true
    "$ADB" -s "$DEVICE" shell am start -n "$ACTIVITY" >/dev/null 2>&1 || die "am start failed"
    pass "launched $ACTIVITY"
  fi
}

resolve_device
if [ "$SKIP_BUILD" -eq 0 ]; then
  build_web_export
  build_apk
else
  [ -f "$APK" ] || die "--skip-build: no APK at $APK"
  warn "reusing existing $APK"
fi
if [ "$DO_INSTALL" -eq 1 ]; then install_and_run; else info "APK ready: $APK"; fi
