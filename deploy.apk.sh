#!/bin/bash
# deploy.apk.sh — build the wallet Android APK (docker) and upload it to MinIO.
#
#   ./deploy.apk.sh                          # preview debug APK
#   ./deploy.apk.sh --release                # signed release APK
#   ./deploy.apk.sh --env production --release
#   ./deploy.apk.sh --skip-build             # upload the APK already in out/
#   ./deploy.apk.sh --no-latest              # skip the -latest aliases/manifest
#
# Env:
#   APP_ENV          android variant (default preview)
#   BUILD_TYPE       debug|release (default debug)
#   ABI_SPLIT        e.g. arm64-v8a (default all four ABIs)
#   S3_ENDPOINT (default https://minio-s1001.bigt.ai)
#   S3_ACCESS_KEY / S3_SECRET_KEY (required)
#   S3_BUCKET (default aifeeds-content) / S3_PREFIX (default releases)
#   OUT_DIR          local APK dir (default ./out)
#   IMAGE            builder image name (default wallet-android)
#   APP_VERSION      override the release version (default: latest git tag, else package.json)
#   MANDATORY        true to mark the release mandatory in the OTA manifest (default false)
#   PUBLIC_BASE_URL  public base the OTA manifest url is built from
#                    (default $S3_ENDPOINT/$S3_BUCKET)
#
# Uploads out/wallet-<env>-<type>-<app-version>.apk plus a
# wallet-<env>-<type>-latest.apk alias to s3://$S3_BUCKET/$S3_PREFIX/.
# For release APKs it also writes wallet-<env>-release-latest.json (the OTA
# manifest the app reads; see expo-app/sources/lib/ota.ts).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

APP_ENV="${APP_ENV:-preview}"
BUILD_TYPE="${BUILD_TYPE:-debug}"
S3_ENDPOINT="${S3_ENDPOINT:-https://minio-s1001.bigt.ai}"
S3_BUCKET="${S3_BUCKET:-aifeeds-content}"
S3_PREFIX="${S3_PREFIX:-releases}"
OUT_DIR="${OUT_DIR:-$ROOT/out}"
IMAGE="${IMAGE:-wallet-android}"
SKIP_BUILD=0; LATEST=1

for a in "$@"; do
  case "$a" in
    --release) BUILD_TYPE=release ;;
    --env=*) APP_ENV="${a#--env=}" ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-latest) LATEST=0 ;;
    --help|-h) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

: "${S3_ACCESS_KEY:?set S3_ACCESS_KEY}"
: "${S3_SECRET_KEY:?set S3_SECRET_KEY}"

# Release version: the git tag (vX.Y.Z) when on one, else the app package
# version. versionCode is a monotonic integer (semver → major*1e6+minor*1e3+
# patch) so the on-device updater can compare against the manifest regardless
# of semver string formatting.
VERSION="${APP_VERSION:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || true)}"
if [ -z "$VERSION" ]; then
  VERSION="$(node -e "console.log(require('./expo-app/package.json').version)")"
fi
BASE_VERSION="$(printf '%s' "$VERSION" | sed -E 's/[-+].*$//')"
MAJOR="$(printf '%s' "$BASE_VERSION" | cut -d. -f1 | sed 's/[^0-9]//g')"
MINOR="$(printf '%s' "$BASE_VERSION" | cut -d. -f2 | sed 's/[^0-9]//g')"
PATCH="$(printf '%s' "$BASE_VERSION" | cut -d. -f3 | sed 's/[^0-9]//g')"
VERSION_CODE="$(( (MAJOR * 1000000) + (MINOR * 1000) + PATCH ))"
[ "${VERSION_CODE:-0}" -gt 0 ] || VERSION_CODE="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
export APP_VERSION_NAME="$VERSION" APP_VERSION_CODE="$VERSION_CODE"
# Bake the release channel this APK updates from.
export EXPO_PUBLIC_APK_ENV="$APP_ENV"
# Public base used to build the OTA manifest's APK url.
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-${S3_ENDPOINT%/}/$S3_BUCKET}"

ABI_SUFFIX=""
if [ -n "${ABI_SPLIT:-}" ]; then
  ABI_SUFFIX="-$(echo "$ABI_SPLIT" | tr ',' '+' | tr -d ' ')"
fi
NAME="wallet-$APP_ENV-$BUILD_TYPE-$VERSION.apk"
LATEST_NAME="wallet-$APP_ENV-$BUILD_TYPE-latest.apk"

if [ "$SKIP_BUILD" -eq 0 ]; then
  # Build the signed Capacitor artifact (static web export → cap sync → gradle
  # + signing) via webapp.sh. Needs webapp/keystore.properties for --release.
  # APP_VERSION_NAME/CODE + EXPO_PUBLIC_APK_ENV are exported above.
  case "$BUILD_TYPE" in
    release) ./webapp.sh --env="$APP_ENV" --release --no-install ;;
    *)       ./webapp.sh --env="$APP_ENV" --no-install ;;
  esac
fi
SRC="$ROOT/webapp/android/app/build/outputs/apk/$BUILD_TYPE/app-$BUILD_TYPE.apk"
APK="$OUT_DIR/wallet-$APP_ENV-$BUILD_TYPE.apk"
[ -f "$SRC" ] || { echo "missing built artifact $SRC (run without --skip-build first)" >&2; exit 1; }
cp -f "$SRC" "$APK"
sha256sum "$APK"

MC_ENV=(-e S3_ENDPOINT="$S3_ENDPOINT" -e S3_ACCESS_KEY="$S3_ACCESS_KEY" -e S3_SECRET_KEY="$S3_SECRET_KEY"
  -e S3_BUCKET="$S3_BUCKET" -e S3_PREFIX="$S3_PREFIX" -e APK_FILE="$(basename "$APK")"
  -e NAME="$NAME" -e LATEST_NAME="$LATEST_NAME")
docker run --rm "${MC_ENV[@]}" -v "$OUT_DIR:/out:ro" --entrypoint /bin/sh quay.io/minio/mc -c \
  'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && \
   mc cp "/out/$APK_FILE" "up/$S3_BUCKET/$S3_PREFIX/$NAME"' \
  || { echo "upload failed — check S3_* creds" >&2; exit 1; }
if [ "$LATEST" -eq 1 ]; then
  docker run --rm "${MC_ENV[@]}" --entrypoint /bin/sh quay.io/minio/mc -c \
    'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && \
     mc cp "up/$S3_BUCKET/$S3_PREFIX/$NAME" "up/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME"' \
    || { echo "latest-alias copy failed" >&2; exit 1; }
fi

# OTA version manifest — the on-device updater fetches this straight from the
# (public-read) release prefix and compares versionCode. Only signed release
# APKs are upgradeable (a debug/release signature mismatch cannot install), so
# only the release variant publishes a manifest.
if [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ]; then
  SHA="$(sha256sum "$APK" | awk '{print $1}')"
  MANIFEST="wallet-$APP_ENV-release-latest.json"
  printf '{"versionName":"%s","versionCode":%s,"url":"%s/%s/%s","sha256":"%s","mandatory":%s}\n' \
    "$VERSION" "$VERSION_CODE" "${PUBLIC_BASE_URL%/}" "$S3_PREFIX" "$NAME" "$SHA" "${MANDATORY:-false}" \
    > "$OUT_DIR/$MANIFEST"
  MC_ENV+=(-e MANIFEST="$MANIFEST")
  docker run --rm "${MC_ENV[@]}" -v "$OUT_DIR:/out:ro" --entrypoint /bin/sh quay.io/minio/mc -c \
    'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && \
     mc cp "/out/$MANIFEST" "up/$S3_BUCKET/$S3_PREFIX/$MANIFEST"' \
    || { echo "manifest upload failed" >&2; exit 1; }
  echo "uploaded: $PUBLIC_BASE_URL/$S3_PREFIX/$MANIFEST ($VERSION / code $VERSION_CODE)"
fi

echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$NAME"
[ "$LATEST" -eq 1 ] && echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME"
