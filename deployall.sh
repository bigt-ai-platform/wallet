#!/usr/bin/env bash
# deployall.sh — run the full wallet release: the regional web deploy
# (deploy/deploy.sh) then the Android artifact deploy (deploy.apk.sh).
#
#   ./deployall.sh                        # web deploy + signed release APK (--release --env=production)
#   ./deployall.sh --yes                  # same, no confirmation prompt
#   ./deployall.sh --env=preview          # signed release APK on the preview channel
#   ./deployall.sh --app-only --yes       # regions only
#   ./deployall.sh --apk-only             # Android artifact only (release/production)
#   ./deployall.sh --dry-run              # web deploy dry-run (APK skipped)
#
# Common flags are routed to the right script; run `./deploy/deploy.sh --help`
# and `./deploy.apk.sh --help` for the full option sets.
#
#   deploy/deploy.sh:  --yes -y --dry-run --commit --deploy-only <version>
#   deploy.apk.sh:     --release --env= --skip-build --no-latest
#
# Remote tags are fetched up front, and the APK step auto-loads the S3 creds
# from deploy/env/.env.europa (else ../dai's) when S3_ACCESS_KEY/S3_SECRET_KEY
# are not already in the environment.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Refresh remote tags first: the patch bump (deploy/deploy.sh) and the APK
# version (webapp/scripts/version.mjs) both read the highest `vX.Y.Z` tag, and
# a fresh clone often lacks tags that point at commits not reachable from main
# (releases land on rebased/cherry-picked commits). Without this the bump
# collides with an already-published version and the tag push is rejected.
# Non-fatal: a divergent local tag only warns, and the newer fetched tags still
# advance the computed version.
git fetch --tags --quiet origin 2>/dev/null || true

[ -x deploy/deploy.sh ] || { echo "missing deploy/deploy.sh" >&2; exit 1; }
[ -x deploy.apk.sh ] || { echo "missing deploy.apk.sh" >&2; exit 1; }

APP=1; APK=1; APK_BUILD_SPEC=0
APP_ARGS=(); APK_ARGS=()

for a in "$@"; do
  case "$a" in
    --app-only) APK=0 ;;
    --apk-only) APP=0 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    # deploy/deploy.sh options
    --yes|-y|--commit|--deploy-only) APP_ARGS+=("$a") ;;
    --dry-run) APP_ARGS+=("--dry-run"); APK=0 ;;   # nothing to dry-run on the upload side
    v[0-9]*|[0-9]*) APP_ARGS+=("$a") ;;
    # deploy.apk.sh options
    --release) APK_ARGS+=("$a"); APK_BUILD_SPEC=1 ;;
    --env=*) APK_ARGS+=("$a"); APK_BUILD_SPEC=1 ;;
    --skip-build|--no-latest) APK_ARGS+=("$a") ;;
    *) echo "unknown arg: $a (see --help)" >&2; exit 1 ;;
  esac
done

# Default Android build: signed release on the production channel.
if [ "$APK" -eq 1 ] && [ "$APK_BUILD_SPEC" -eq 0 ]; then
  APK_ARGS+=(--release --env=production)
fi

run() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; "$@"; }

if [ "$APP" -eq 1 ]; then
  run ./deploy/deploy.sh ${APP_ARGS[@]+"${APP_ARGS[@]}"}
fi
if [ "$APK" -eq 1 ]; then
  # deploy.apk.sh needs MinIO creds for the upload; load them from the fleet env
  # file when the caller hasn't already exported S3_ACCESS_KEY/S3_SECRET_KEY
  # (same file scripts/docs-upload.sh uses). Sourced after the web step so its
  # other vars cannot leak into that build.
  if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
    for f in "$ROOT/deploy/env/.env.europa" "$ROOT/../dai/deploy/env/.env.europa"; do
      if [ -f "$f" ]; then set -a; . "$f"; set +a; break; fi
    done
  fi
  run ./deploy.apk.sh ${APK_ARGS[@]+"${APK_ARGS[@]}"}
fi

printf '\n\033[0;32mdeployall: done.\033[0m\n'
