#!/usr/bin/env bash
# deployall.sh — run the full wallet release: the regional web deploy
# (deploy/deploy.sh) then the Android artifact deploy (deploy.apk.sh).
#
#   ./deployall.sh                        # web deploy (interactive) + preview debug APK
#   ./deployall.sh --yes --release        # web deploy (no prompt) + signed release APK
#   ./deployall.sh --env=production --release
#   ./deployall.sh --app-only --yes       # regions only
#   ./deployall.sh --apk-only --release   # Android artifact only
#   ./deployall.sh --dry-run              # web deploy dry-run (APK skipped)
#
# Common flags are routed to the right script; run `./deploy/deploy.sh --help`
# and `./deploy.apk.sh --help` for the full option sets.
#
#   deploy/deploy.sh:  --yes -y --dry-run --commit --deploy-only <version>
#   deploy.apk.sh:     --release --env= --skip-build --no-latest
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

[ -x deploy/deploy.sh ] || { echo "missing deploy/deploy.sh" >&2; exit 1; }
[ -x deploy.apk.sh ] || { echo "missing deploy.apk.sh" >&2; exit 1; }

APP=1; APK=1
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
    --release|--skip-build|--no-latest) APK_ARGS+=("$a") ;;
    --env=*) APK_ARGS+=("$a") ;;
    *) echo "unknown arg: $a (see --help)" >&2; exit 1 ;;
  esac
done

run() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; "$@"; }

if [ "$APP" -eq 1 ]; then
  run ./deploy/deploy.sh ${APP_ARGS[@]+"${APP_ARGS[@]}"}
fi
if [ "$APK" -eq 1 ]; then
  run ./deploy.apk.sh ${APK_ARGS[@]+"${APK_ARGS[@]}"}
fi

printf '\n\033[0;32mdeployall: done.\033[0m\n'
