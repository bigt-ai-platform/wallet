#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
INFRA_SH="$ROOT/e2e/infra.sh"
EXPO_DIR="$ROOT/expo-app"

L0_PORT="${L0_PORT:-24089}"
L1_PORT="${L1_PORT:-24086}"
L0_URL="http://127.0.0.1:${L0_PORT}/"
L1_URL="http://127.0.0.1:${L1_PORT}/"
# Override the dev command, e.g. DEV_CMD="yarn web" ./dev.sh
# Default starts the blockchain infra and the Expo web client.
DEV_CMD="${DEV_CMD:-yarn web}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

CMD="${1:-up}"

DEV_PID=""
CLEANUP_DONE=0
cleanup() {
  [ "$CLEANUP_DONE" = "1" ] && return
  CLEANUP_DONE=1
  if [ -n "$DEV_PID" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    info "Stopping dev server..."
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  info "Stopping blockchain infra..."
  "$INFRA_SH" down 2>/dev/null || true
  log "Done."
}

case "$CMD" in
  up)
    ;;
  restart)
    info "Restarting infra: resetting DB and servers..."
    "$INFRA_SH" down 2>/dev/null || true
    ;;
  down|stop)
    info "Stopping blockchain infra and any dev server..."
    "$INFRA_SH" down 2>/dev/null || true
    log "Done."
    exit 0
    ;;
  *)
    fail "Usage: $0 [up|restart|down]"
    ;;
esac

trap cleanup EXIT INT TERM

# 1. Start blockchain infra (L0/L1/MCMC + DB) in the background
info "Starting blockchain infra (L0: $L0_URL, L1: $L1_URL)..."
"$INFRA_SH" up &
INFRA_PID=$!

# 2. Wait for infra to become ready
info "Waiting for infrastructure to come up..."
READY=0
for i in $(seq 1 120); do
  if curl -sf "$L0_URL" >/dev/null 2>&1 && curl -sf "$L1_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$INFRA_PID" 2>/dev/null; then
    fail "Infrastructure process exited unexpectedly."
  fi
  sleep 2
done
[ "$READY" = "1" ] || fail "Timed out waiting for infrastructure."
log "Infrastructure ready."

# 3. Start the Expo dev server (foreground) in web mode by default. Press 'a'
#    for Android or scan the QR code with Expo Go for manual testing.
info "Starting dev server: '$DEV_CMD'"
cd "$EXPO_DIR"
bash -c "$DEV_CMD" &
DEV_PID=$!

# 4. Wait until the web dev server is actually serving before showing the URL.
WEB_PORT="${WEB_PORT:-8081}"
WEB_URL="http://localhost:${WEB_PORT}/"
info "Waiting for the web dev server on $WEB_URL..."
for i in $(seq 1 60); do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    fail "Dev server exited unexpectedly."
  fi
  if curl -sf "$WEB_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf "$WEB_URL" >/dev/null 2>&1 || fail "Timed out waiting for $WEB_URL"
log "Dev server started (PID $DEV_PID). Press Ctrl+C to stop everything."
log "Open the web app at: $WEB_URL"

wait "$DEV_PID"
