#!/bin/bash
# deploy.apk.sh — build the wallet Android APK (docker) and upload it to MinIO.
#
#   ./deploy.apk.sh                          # preview debug APK
#   ./deploy.apk.sh --release                # signed release APK
#   ./deploy.apk.sh --env production --release
#   ./deploy.apk.sh --skip-build             # upload the APK already in out/
#   ./deploy.apk.sh --no-latest              # skip the -latest.apk alias object
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
#
# Uploads out/wallet-<env>-<type>-<app-version>.apk plus a
# wallet-<env>-<type>-latest.apk alias to s3://$S3_BUCKET/$S3_PREFIX/.
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

VERSION="$(node -e "console.log(require('./expo-app/package.json').version)")"
ABI_SUFFIX=""
if [ -n "${ABI_SPLIT:-}" ]; then
  ABI_SUFFIX="-$(echo "$ABI_SPLIT" | tr ',' '+' | tr -d ' ')"
fi
NAME="wallet-$APP_ENV-$BUILD_TYPE$ABI_SUFFIX-$VERSION.apk"
LATEST_NAME="wallet-$APP_ENV-$BUILD_TYPE$ABI_SUFFIX-latest.apk"

if [ "$SKIP_BUILD" -eq 0 ]; then
  docker build -f expo-app/Dockerfile.android -t "$IMAGE" .
  mkdir -p "$OUT_DIR"
  docker run --rm -v "$OUT_DIR:/out" \
    -e "APP_ENV=$APP_ENV" -e "BUILD_TYPE=$BUILD_TYPE" \
    -e "ABI_SPLIT=${ABI_SPLIT:-}" "$IMAGE"
fi
APK="$OUT_DIR/wallet-$APP_ENV-$BUILD_TYPE$ABI_SUFFIX.apk"
[ -f "$APK" ] || { echo "missing $APK (run without --skip-build first)" >&2; exit 1; }
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

echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$NAME"
[ "$LATEST" -eq 1 ] && echo "uploaded: $S3_ENDPOINT/$S3_BUCKET/$S3_PREFIX/$LATEST_NAME"
