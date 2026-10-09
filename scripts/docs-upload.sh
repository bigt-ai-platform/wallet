#!/usr/bin/env bash
set -euo pipefail

# Publish the rendered P2P guide PDFs to the per-region MinIO docs buckets the
# wallet links to (expo-app/sources/lib/docs.ts): wallet-docs-eu / -us / -asia,
# one per geo site (../pm/minio/GEO.md), mirroring ../dai scripts/docs-upload.sh.
# The buckets are public static content — anonymous download is (re)asserted on
# every run; no signing involved.
#
# Usage: scripts/docs-upload.sh [pdf-dir]
#   pdf-dir defaults to docs/p2p-demo/assets (committed p2p*.pdf, 12 languages).
#   Needs: docker (mc image ghcr.io/bigt-ai-platform/mc) + S3 root creds. The
#   creds live in a deploy/env/.env.europa on the shared fleet (identical on
#   every geo site); when this repo has none, ../dai's is used.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$ROOT/docs/p2p-demo/assets}"
MCIMG=ghcr.io/bigt-ai-platform/mc:latest

ENV_FILE="${ENV_FILE:-$ROOT/deploy/env/.env.europa}"
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT/../dai/deploy/env/.env.europa" ]; then
  ENV_FILE="$ROOT/../dai/deploy/env/.env.europa"
fi

if [ ! -d "$SRC" ]; then
  echo "no such dir: $SRC" >&2
  exit 1
fi
if ! ls "$SRC"/*.pdf >/dev/null 2>&1; then
  echo "no PDFs in $SRC" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE (set ENV_FILE to a file with S3_ACCESS_KEY/S3_SECRET_KEY)" >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

SCRIPT='mc alias set r "$EP" "$AK" "$SK" >/dev/null \
 && mc mb --ignore-existing "r/$B" \
 && { mc version enable "r/$B" >/dev/null 2>&1 || :; } \
 && mc anonymous set download "r/$B" \
 && mc mirror --overwrite --exclude "*.jpg" /data "r/$B/demo/"'

# bucket => write endpoint of its geo site (server-to-server host)
REGION_BUCKETS="wallet-docs-eu wallet-docs-us wallet-docs-asia"
endpoint_for() {
  case "$1" in
    wallet-docs-eu) echo "https://minio-s2001.bigt.ai" ;;
    wallet-docs-us) echo "https://minio-us1001.bigt.ai" ;;
    wallet-docs-asia) echo "https://minio-hk1002.bigt.ai" ;;
    *) return 1 ;;
  esac
}

for B in $REGION_BUCKETS; do
  EP="$(endpoint_for "$B")"
  echo "==> $B ← $EP"
  # Resolve via public DNS so a stale local/router cache (the *.bigt.ai
  # wildcard) cannot send mc to the wrong backend and break the TLS handshake.
  docker run --rm --dns 1.1.1.1 --dns 8.8.8.8 \
    -e EP="$EP" -e AK="$S3_ACCESS_KEY" -e SK="$S3_SECRET_KEY" -e B="$B" \
    -v "$SRC:/data:ro" --entrypoint sh "$MCIMG" -c "$SCRIPT"
done

echo "==> published $(ls "$SRC"/*.pdf | wc -l) PDFs × $(echo $REGION_BUCKETS | wc -w) regions"
