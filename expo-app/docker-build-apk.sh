#!/bin/bash
# Build the wallet Android APK inside the Dockerfile.android container.
# Also runnable on a host that already has Node 20 + yarn + JDK 17 + Android SDK.
#
#   APP_ENV=preview  BUILD_TYPE=debug  ./docker-build-apk.sh
#
# Env: APP_ENV (development|preview|production, default preview),
#      BUILD_TYPE (debug|release, default debug),
#      ABI_SPLIT (e.g. arm64-v8a, or comma list; default all four ABIs),
#      OUT_DIR (default /out, falls back to expo-app/out),
#      KEYSTORE_FILE / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD (release).
set -euo pipefail

APP_ENV="${APP_ENV:-preview}"
BUILD_TYPE="${BUILD_TYPE:-debug}"
OUT_DIR="${OUT_DIR:-/out}"
[ -d "$OUT_DIR" ] || OUT_DIR="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT_DIR"

export CI=1
export EXPO_NO_TELEMETRY=1
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$APP_DIR/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -d node_modules ]; then
  yarn install --frozen-lockfile
fi

cd "$APP_DIR"
APP_ENV="$APP_ENV" npx expo prebuild --platform android --clean

SDKM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
yes 2>/dev/null | "$SDKM" --licenses > /dev/null || true
need_pkgs=()
have() { [ -e "$ANDROID_HOME/$1" ]; }
SDK_V=$(grep -rhoP 'compileSdkVersion[^0-9]*\K[0-9]+' android/build.gradle android/app/build.gradle 2>/dev/null | head -1 || true)
BT_V=$(grep -rhoP 'buildToolsVersion[^0-9]*\K[0-9.]+' android/build.gradle android/app/build.gradle 2>/dev/null | head -1 || true)
NDK_V=$(grep -rhoP 'ndkVersion[^0-9]*\K[0-9.]+' android/build.gradle android/app/build.gradle 2>/dev/null | head -1 || true)
# Expo SDK 57 plugin defaults (ExpoRootProjectPlugin) when the catalog pins nothing else
SDK_V="${SDK_V:-35}"
BT_V="${BT_V:-35.0.0}"
NDK_V="${NDK_V:-27.1.12297006}"
! have "platforms/android-$SDK_V" && need_pkgs+=("platforms;android-$SDK_V")
! have "build-tools/$BT_V" && need_pkgs+=("build-tools;$BT_V")
! have "ndk/$NDK_V" && need_pkgs+=("ndk;$NDK_V")
if [ "${#need_pkgs[@]}" -gt 0 ]; then
  "$SDKM" "${need_pkgs[@]}"
fi

TASK="assembleDebug"
GRADLE_OPTS_EXTRA=()
ABI_SUFFIX=""
if [ -n "${ABI_SPLIT:-}" ]; then
  GRADLE_OPTS_EXTRA+=("-PreactNativeArchitectures=$ABI_SPLIT")
  ABI_SUFFIX="-$(echo "$ABI_SPLIT" | tr ',' '+' | tr -d ' ')"
fi
OUT_APK="wallet-$APP_ENV-debug$ABI_SUFFIX.apk"
if [ "$BUILD_TYPE" = "release" ]; then
  TASK="assembleRelease"
  OUT_APK="wallet-$APP_ENV-release$ABI_SUFFIX.apk"
  if [ -n "${KEYSTORE_FILE:-}" ]; then
    STORE="$KEYSTORE_FILE"
  else
    STORE="$OUT_DIR/wallet-release.keystore"
    if [ ! -f "$STORE" ]; then
      keytool -genkeypair -v -keystore "$STORE" -alias wallet -keyalg RSA \
        -keysize 2048 -validity 10000 -storepass android -keypass android \
        -dname "CN=wallet, OU=dev, O=bigtai, L=Berlin, C=DE"
    fi
  fi
  GRADLE_OPTS_EXTRA+=(
    "-Pandroid.injected.signing.store.file=$STORE"
    "-Pandroid.injected.signing.store.password=${KEYSTORE_PASSWORD:-android}"
    "-Pandroid.injected.signing.key.alias=${KEY_ALIAS:-wallet}"
    "-Pandroid.injected.signing.key.password=${KEY_PASSWORD:-android}"
  )
fi

./android/gradlew -p android "$TASK" "${GRADLE_OPTS_EXTRA[@]}"
APK=$(ls android/app/build/outputs/apk/"$BUILD_TYPE"/*.apk | head -1)
cp "$APK" "$OUT_DIR/$OUT_APK"
sha256sum "$OUT_DIR/$OUT_APK"
