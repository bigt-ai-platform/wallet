#!/usr/bin/env bash
set -euo pipefail

# Publish the rendered P2P guide PDFs to the shared `apps` bucket under
# `wallet/docs/demo`, on every site (expo-app/sources/lib/docs.ts links via the
# region endpoint), mirroring ../dai scripts/docs-upload.sh. The apps bucket is
# public static content — anonymous download is (re)asserted on every run; no
# signing involved.
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

BUCKET=apps
PREFIX=wallet/docs

SCRIPT='mc alias set r "$EP" "$AK" "$SK" >/dev/null \
 && mc mb --ignore-existing "r/$B" \
 && { mc version enable "r/$B" >/dev/null 2>&1 || :; } \
 && mc anonymous set download "r/$B" \
 && mc mirror --overwrite --exclude "*.jpg" /data "r/$B/$P/demo/"'

# site => write host that serves the public s3-<region> reads. s3.bigt.ai is a
# transparent proxy that preserves Host (SigV4 stays valid), so every region
# uses its public `s3-*` name.
endpoint_for() {
  case "$1" in
    eu)   echo "https://s3.bigt.ai" ;;
    us)   echo "https://s3-us.bigt.ai" ;;
    asia) echo "https://s3-asia.bigt.ai" ;;
    *) return 1 ;;
  esac
}

for site in eu us asia; do
  EP="$(endpoint_for "$site")"
  echo "==> apps/wallet/docs/demo ← $EP"
  # Resolve via public DNS so a stale local/router cache (the *.bigt.ai
  # wildcard) cannot send mc to the wrong backend and break the TLS handshake.
  docker run --rm --dns 1.1.1.1 --dns 8.8.8.8 \
    -e EP="$EP" -e AK="$S3_ACCESS_KEY" -e SK="$S3_SECRET_KEY" -e B="$BUCKET" -e P="$PREFIX" \
    -v "$SRC:/data:ro" --entrypoint sh "$MCIMG" -c "$SCRIPT"
done

echo "==> published $(ls "$SRC"/*.pdf | wc -l) PDFs × 3 sites to $BUCKET/$PREFIX/demo"
