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

# MinIO client image. quay.io/minio/mc is preferred; where it's blocked the
# minio server image (which bundles `mc`) is used instead.
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc}"
if ! docker image inspect "$MC_IMAGE" >/dev/null 2>&1; then
  docker pull "$MC_IMAGE" >/dev/null 2>&1 || true
fi
if ! docker image inspect "$MC_IMAGE" >/dev/null 2>&1; then
  alt="quay.io/minio/minio:latest"
  docker image inspect "$alt" >/dev/null 2>&1 || docker pull "$alt" >/dev/null 2>&1 || true
  if docker image inspect "$alt" >/dev/null 2>&1; then
    echo "mc image $MC_IMAGE unavailable — using $alt (bundles mc)" >&2
    MC_IMAGE="$alt"
  fi
fi

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
  # + signing) via webapp.sh. Needs webapp/keystore.properties, pinned in
  # webapp/signing.sha256 — every build carries the production certificate.
  # APP_VERSION_NAME/CODE + EXPO_PUBLIC_APK_ENV are exported above.
  case "$BUILD_TYPE" in
    release) ./webapp.sh --env="$APP_ENV" --release --no-install ;;
    *)       ./webapp.sh --env="$APP_ENV" --no-install ;;
  esac
fi
SRC="$ROOT/webapp/android/app/build/outputs/apk/$BUILD_TYPE/app-$BUILD_TYPE.apk"
APK="$OUT_DIR/wallet-$APP_ENV-$BUILD_TYPE.apk"
[ -f "$SRC" ] || { echo "missing built artifact $SRC (run without --skip-build first)" >&2; exit 1; }
# Last gate before an OTA manifest points devices at this file: a non-production
# signing key makes every upgrade of the installed app fail as incompatible.
node "$ROOT/webapp/scripts/signing.mjs" artifact "$SRC" \
  || { echo "signing check failed — $SRC is not signed with the production key" >&2; exit 1; }
node "$ROOT/webapp/scripts/appid.mjs" artifact "$SRC" \
  || { echo "package check failed — $SRC declares the wrong Android package" >&2; exit 1; }
cp -f "$SRC" "$APK"
sha256sum "$APK"

MC_ENV=(-e S3_ENDPOINT="$S3_ENDPOINT" -e S3_ACCESS_KEY="$S3_ACCESS_KEY" -e S3_SECRET_KEY="$S3_SECRET_KEY"
  -e S3_BUCKET="$S3_BUCKET" -e S3_PREFIX="$S3_PREFIX")

# mc cp inside the client container ($1 = source, $2 = destination). OUT_DIR is
# mounted read-write so the same helper can pull objects back for checking.
mc_cp() {
  docker run --rm "${MC_ENV[@]}" -v "$OUT_DIR:/out" -e MC_SRC="$1" -e MC_DST="$2" \
    --entrypoint /bin/sh "$MC_IMAGE" -c \
    'mc alias set up "$S3_ENDPOINT" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null && \
     mc cp "$MC_SRC" "$MC_DST"'
}

# Key check: what is live right now. A release published under a different
# certificate leaves every installed copy unable to upgrade in place
# (INSTALL_FAILED_UPDATE_INCOMPATIBLE), so say so before overwriting the object
# those devices are pointed at. Warns rather than fails — publishing a fixed,
# production-signed release over a wrongly signed one is the repair.
LIVE_JSON=".live-$APP_ENV-$BUILD_TYPE.json"
LIVE_APK=".live-$APP_ENV-$BUILD_TYPE.apk"
if [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ] \
  && mc_cp "up/$S3_BUCKET/$S3_PREFIX/wallet-$APP_ENV-release-latest.json" "/out/$LIVE_JSON" 2>/dev/null; then
  LIVE_VER="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(String(j.versionName ?? "?")+" / code "+String(j.versionCode ?? "?"))' "$OUT_DIR/$LIVE_JSON" 2>/dev/null || echo unknown)"
  LIVE_URL="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(typeof j.url === "string" ? j.url : "")' "$OUT_DIR/$LIVE_JSON" 2>/dev/null || true)"
  LIVE_KEY="${LIVE_URL#*"$S3_PREFIX/"}"
  # versionCode must strictly increase. The OTA updater compares codes, and
  # Android refuses a same-or-older install, so publishing a regression would
  # hand every device an update it can never take (today the code comes from
  # `git describe`, which goes backwards after a tag moves).
  LIVE_CODE="$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(Number(j.versionCode)||0)' "$OUT_DIR/$LIVE_JSON" 2>/dev/null || echo 0)"
  if [ "${LIVE_CODE:-0}" -ge "$VERSION_CODE" ]; then
    echo "refusing to publish: the live manifest is versionCode $LIVE_CODE but this build is $VERSION_CODE" >&2
    echo "    versionCode must strictly increase — pass APP_VERSION=<newer> (and tag it)." >&2
    rm -f "$OUT_DIR/$LIVE_JSON" "$OUT_DIR/$LIVE_APK"
    exit 1
  fi
  if [ -n "$LIVE_URL" ] && [ "$LIVE_KEY" != "$LIVE_URL" ] \
    && mc_cp "up/$S3_BUCKET/$S3_PREFIX/$LIVE_KEY" "/out/$LIVE_APK" 2>/dev/null; then
    if LIVE_SIGNING="$(node "$ROOT/webapp/scripts/signing.mjs" artifact "$OUT_DIR/$LIVE_APK" 2>&1)"; then
      echo "live: published release ($LIVE_VER) carries the production key"
    elif printf '%s' "$LIVE_SIGNING" | grep -q "not the production key"; then
      echo "WARNING: the published release ($LIVE_VER) is signed by a DIFFERENT certificate:" >&2
      printf '%s\n' "$LIVE_SIGNING" | sed 's/^/    /' >&2
      echo "    devices running it cannot upgrade in place and must be reinstalled;" >&2
      echo "    publishing a production-signed release does not repair them." >&2
    else
      echo "note: could not check the published release: $LIVE_SIGNING" >&2
    fi
  fi
elif [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ]; then
  echo "live: no published $APP_ENV-release manifest to compare against"
fi
rm -f "$OUT_DIR/$LIVE_JSON" "$OUT_DIR/$LIVE_APK"

mc_cp "/out/$(basename "$APK")" "up/$S3_BUCKET/$S3_PREFIX/$NAME" \
  || { echo "upload failed — check S3_* creds" >&2; exit 1; }
if [ "$LATEST" -eq 1 ]; then
  mc_cp "up/$S3_BUCKET/$S3_PREFIX/$NAME" "up/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME" \
    || { echo "latest-alias copy failed" >&2; exit 1; }
fi

# OTA version manifest — the on-device updater fetches this straight from the
# (public-read) release prefix and compares versionCode. Every build carries the
# production certificate now, but only the release variant publishes a manifest.
if [ "$LATEST" -eq 1 ] && [ "$BUILD_TYPE" = "release" ]; then
  SHA="$(sha256sum "$APK" | awk '{print $1}')"
  MANIFEST="wallet-$APP_ENV-release-latest.json"
  printf '{"versionName":"%s","versionCode":%s,"url":"%s/%s/%s","sha256":"%s","mandatory":%s}\n' \
    "$VERSION" "$VERSION_CODE" "${PUBLIC_BASE_URL%/}" "$S3_PREFIX" "$NAME" "$SHA" "${MANDATORY:-false}" \
    > "$OUT_DIR/$MANIFEST"
  mc_cp "/out/$MANIFEST" "up/$S3_BUCKET/$S3_PREFIX/$MANIFEST" \
    || { echo "manifest upload failed" >&2; exit 1; }
  echo "uploaded: $PUBLIC_BASE_URL/$S3_PREFIX/$MANIFEST ($VERSION / code $VERSION_CODE)"
fi

# Verify what we actually published: the OTA manifest points devices at this
# exact object, so re-download it and confirm both the bytes and the key.
VERIFY_APK=".verify-$APP_ENV-$BUILD_TYPE.apk"
mc_cp "up/$S3_BUCKET/$S3_PREFIX/$NAME" "/out/$VERIFY_APK" \
  || { echo "could not re-download $S3_PREFIX/$NAME to verify it" >&2; exit 1; }
WANT_SHA="$(sha256sum "$APK" | awk '{print $1}')"
GOT_SHA="$(sha256sum "$OUT_DIR/$VERIFY_APK" | awk '{print $1}')"
[ "$WANT_SHA" = "$GOT_SHA" ] || {
  echo "uploaded object sha256 $GOT_SHA != built $WANT_SHA" >&2; exit 1; }
node "$ROOT/webapp/scripts/signing.mjs" artifact "$OUT_DIR/$VERIFY_APK" \
  || { echo "uploaded object is not signed with the production key" >&2; exit 1; }
node "$ROOT/webapp/scripts/appid.mjs" artifact "$OUT_DIR/$VERIFY_APK" \
  || { echo "uploaded object declares the wrong Android package" >&2; exit 1; }
rm -f "$OUT_DIR/$VERIFY_APK"
echo "verified: $S3_PREFIX/$NAME ($GOT_SHA, production key)"

echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$NAME"
[ "$LATEST" -eq 1 ] && echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME"
