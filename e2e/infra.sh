#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_SH="$ROOT/../blockchain/helper/fulltest/remote.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

if [ ! -f "$REMOTE_SH" ] && [ ! -x "$REMOTE_SH" ]; then
  fail "remote.sh not found at $REMOTE_SH"
fi

CMD="${1:-up}"

case "$CMD" in
  up)
    info "Starting blockchain infra via remote.sh (infra mode)..."
    info "  L0   : http://localhost:${L0_PORT:-24089}/"
    info "  L1   : http://localhost:${L1_PORT:-24086}/"
    info "  MCMC : port ${MCMC_PORT:-24091}"
    info "  DB   : postgres:${PG_PORT:-21532}"

    # remote.sh infra builds the modules, starts L0/L1/MCMC, registers the
    # PoS validator, and keeps everything running until Ctrl+C. Env overrides
    # (L0_PORT, L1_PORT, MCMC_PORT, PG_PORT, ...) are forwarded through.
    exec bash "$REMOTE_SH" infra
    ;;
  down|stop)
    info "Stopping blockchain infra via remote.sh..."
    exec bash "$REMOTE_SH" stop
    ;;
  *)
    fail "Usage: $0 [up|down]"
    ;;
esac
