#!/usr/bin/env bash
# publishpdf.sh — publish the rendered guide PDFs to the public `apps` bucket
# (s3.bigt.ai) under wallet/docs/demo.
#
# Those are exactly the objects the app links to: expo-app/sources/lib/docs.ts
# builds `https://s3-<region>.bigt.ai/apps/wallet/docs/demo/<guide>[.<lang>].pdf`
# (unit-tested in lib/__tests__/docs.test.ts). The PDFs are build artifacts —
# gitignored, produced by `./p2pdemo.sh pdf` / `scripts/docs-pdf.mts`, and only
# live here + in the bucket.
#
# Writing goes to the EU write primary only (s3.bigt.ai); the other sites are
# GEO reads (asia serves a replica, us 302-redirects to the primary), so this
# script uploads once and then *verifies* every site with a follow-redirect HEAD.
#
# Usage:
#   scripts/publishpdf.sh                      # every PDF, verify all sites
#   scripts/publishpdf.sh -n                   # dry run: print keys, no network
#   scripts/publishpdf.sh docs/p2p-demo/assets/p2p.pdf
#   scripts/publishpdf.sh -p wallet/docs/demo  # override the key prefix
#
# Options:
#   -n, --dry-run            print what would be uploaded, do nothing
#       --verify-only        skip the upload, only HEAD the read sites
#       --strict             fail (exit 1) when a replica does not serve the file
#                            (default: the write primary must pass, replicas warn)
#   -w, --write-endpoint URL write primary (default: https://s3.bigt.ai)
#   -s, --verify-sites LIST  eu,us,asia (default) | "" to skip the HEAD checks
#       --no-verify          same as -s ""
#   -b, --bucket NAME        bucket (default: apps)
#   -p, --prefix PREFIX      key prefix (default: wallet/docs/demo)
#       --env FILE           env file with S3_ACCESS_KEY / S3_SECRET_KEY
#                            (default: deploy/env/.env.europa, else ../dai's)
#
# Needs docker (image ghcr.io/bigt-ai-platform/mc) unless `mc` is on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUCKET="apps"
PREFIX="wallet/docs/demo"
WRITE_EP="https://s3.bigt.ai"
VERIFY_SITES="eu,us,asia"
DRY_RUN=0
VERIFY_ONLY=0
STRICT=0
MC_IMG="${MC_IMG:-ghcr.io/bigt-ai-platform/mc:latest}"
# Every rendered guide directory (flat: <guide>[.<lang>].pdf).
SRC_DIRS=("docs/p2p-demo/assets" "docs/prediction-demo/assets")

log() { echo -e "\033[0;32m[publishpdf]\033[0m $*"; }
die() { echo -e "\033[0;31m[publishpdf]\033[0m $*" >&2; exit 1; }
usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

FILES=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --strict) STRICT=1; shift ;;
    -w|--write-endpoint|--endpoint) WRITE_EP="${2%/}"; shift 2 ;;
    -s|--verify-sites|--sites) VERIFY_SITES="$2"; shift 2 ;;
    --no-verify) VERIFY_SITES=""; shift ;;
    -b|--bucket) BUCKET="$2"; shift 2 ;;
    -p|--prefix) PREFIX="${2#/}"; shift 2 ;;
    --env) ENV_FILE="$2"; shift 2 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) FILES+=("$1"); shift ;;
  esac
done

# ── collect the PDFs ────────────────────────────────────────────────────────
if [ ${#FILES[@]} -eq 0 ]; then
  for d in "${SRC_DIRS[@]}"; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do FILES+=("$f"); done < <(find "$d" -maxdepth 1 -name '*.pdf' -type f | sort)
  done
fi
[ ${#FILES[@]} -gt 0 ] || die "no PDFs found — render first: ./p2pdemo.sh pdf (or scripts/docs-pdf.mts p2p / predict-demo)"

declare -A SEEN=()
for f in "${FILES[@]}"; do
  [ -f "$f" ] || die "no such file: $f"
  case "$f" in *.pdf) ;; *) die "not a PDF: $f" ;; esac
  k="$(basename "$f")"
  [ -z "${SEEN[$k]:-}" ] || die "duplicate key '$k' across guides ($f) — pass explicit files"
  SEEN[$k]="$f"
done

log "bucket : $BUCKET/$PREFIX"
log "write  : $WRITE_EP"
[ -n "$VERIFY_SITES" ] && log "verify : $VERIFY_SITES"
log "files  : ${#FILES[@]} PDF(s)"
for f in "${FILES[@]}"; do printf '           %-26s %7s  %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)" "$f"; done

if [ "$DRY_RUN" = "1" ]; then
  for f in "${FILES[@]}"; do echo "  PUT $WRITE_EP/$BUCKET/$PREFIX/$(basename "$f")  <- $f"; done
  log "dry run — nothing uploaded"
  exit 0
fi

# ── credentials ─────────────────────────────────────────────────────────────
ENV_FILE="${ENV_FILE:-$ROOT/deploy/env/.env.europa}"
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT/../dai/deploy/env/.env.europa" ]; then
  ENV_FILE="$ROOT/../dai/deploy/env/.env.europa"
fi
[ -f "$ENV_FILE" ] || die "missing env file with S3_ACCESS_KEY / S3_SECRET_KEY (pass --env FILE)"
set -a; . "$ENV_FILE"; set +a
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY not set in $ENV_FILE}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY not set in $ENV_FILE}"
log "creds  : $(basename "$ENV_FILE")"

# ── upload (one mc run; the .pdf extension sets Content-Type) ───────────────
upload_local() {
  local f mdir; mdir="$(mktemp -d)"
  export MC_CONFIG_DIR="$mdir"
  mc alias set pub "$WRITE_EP" "$S3_ACCESS_KEY" "$S3_SECRET_KEY" >/dev/null
  mc mb --ignore-existing "pub/$BUCKET" >/dev/null 2>&1 || true
  mc anonymous set download "pub/$BUCKET" >/dev/null 2>&1 || true
  for f in "${FILES[@]}"; do mc cp "$f" "pub/$BUCKET/$PREFIX/" >/dev/null; done
  rm -rf "$mdir"
}

upload_docker() {
  local mounts=() cmd f
  cmd="mc alias set pub \"\$EP\" \"\$AK\" \"\$SK\" >/dev/null"
  cmd="$cmd && { mc mb --ignore-existing 'pub/$BUCKET' >/dev/null 2>&1 || true; }"
  cmd="$cmd && { mc anonymous set download 'pub/$BUCKET' >/dev/null 2>&1 || true; }"
  for f in "${FILES[@]}"; do
    mounts+=(-v "$(realpath "$f"):/data/$(basename "$f"):ro")
    cmd="$cmd && mc cp '/data/$(basename "$f")' 'pub/$BUCKET/$PREFIX/' >/dev/null"
  done
  docker run --rm --dns 1.1.1.1 --dns 8.8.8.8 \
    -e EP="$WRITE_EP" -e AK="$S3_ACCESS_KEY" -e SK="$S3_SECRET_KEY" \
    "${mounts[@]}" --entrypoint sh "$MC_IMG" -c "$cmd"
}

if [ "$VERIFY_ONLY" = "0" ]; then
  for f in "${FILES[@]}"; do printf '  ✓ PUT %s/%s/%s\n' "$WRITE_EP" "$BUCKET" "$PREFIX/$(basename "$f")"; done
  if command -v mc >/dev/null 2>&1; then upload_local; else upload_docker; fi
else
  log "verify only — no upload"
fi

# ── verify each read site (follows the us 302 back to the primary) ──────────
verify_site() { # $1 = site → base URL
  case "$1" in
    eu)   echo "https://s3.bigt.ai" ;;
    us)   echo "https://s3-us.bigt.ai" ;;
    asia) echo "https://s3-asia.bigt.ai" ;;
    *) return 1 ;;
  esac
}

PRIMARY_BAD=0
REPLICA_BAD=0
if [ -n "$VERIFY_SITES" ]; then
  IFS=',' read -ra _sites <<<"$VERIFY_SITES"
  for s in "${_sites[@]}"; do
    s="$(echo "$s" | tr -d '[:space:]')"
    [ -n "$s" ] || continue
    base="$(verify_site "$s")" || die "unknown site '$s' (use eu, us, asia)"
    # The US name is a redirect to the write primary; the ASIA read replica is
    # occasionally flaky (502 on the gateway), so retry before judging it.
    attempts=3; [ "$s" = "eu" ] && attempts=3
    ok=0; bad=0
    for f in "${FILES[@]}"; do
      name="$(basename "$f")"
      want="$(wc -c <"$f" | tr -d ' ')"
      good=0
      for try in $(seq 1 "$attempts"); do
        got="$(curl -sSL -o /dev/null -m 60 -w '%{http_code} %{size_download}' "$base/$BUCKET/$PREFIX/$name" || echo '000 0')"
        code="${got%% *}"; size="${got##* }"
        if [ "$code" = "200" ] && [ "$size" = "$want" ]; then good=1; break; fi
        sleep 3
      done
      if [ "$good" = "1" ]; then ok=$((ok + 1)); else
        bad=$((bad + 1))
        echo "  ✗ $base/$BUCKET/$PREFIX/$name (http $code, $size/$want bytes)" >&2
      fi
    done
    if [ "$bad" -eq 0 ]; then
      log "verified $s: $ok/$ok objects"
    elif [ "$s" = "eu" ]; then
      PRIMARY_BAD=1; log "FAILED $s: $bad object(s) missing at the write primary"
    else
      REPLICA_BAD=1; log "WARN $s: $bad object(s) not served right now (replica flaky/lagging)"
    fi
  done
fi

log "published ${#FILES[@]} PDF(s) — $BUCKET/$PREFIX"
log "public: https://s3.bigt.ai/$BUCKET/$PREFIX/p2p.pdf"
[ "$PRIMARY_BAD" = "0" ] || die "the write primary does not serve the uploaded bytes"
if [ "$REPLICA_BAD" != "0" ]; then
  [ "$STRICT" = "0" ] || die "a read replica does not serve the uploads (--strict)"
  log "note: a replica is behind — the app still resolves (us redirects, asia retries); re-run --verify-only later"
fi
exit 0
