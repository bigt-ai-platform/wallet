#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$ROOT/packages/bigtangle-ts"
COMPOSE_FILE="$ROOT/e2e/docker-compose.yml"

# Defaults matching e2e/docker-compose.yml host ports
export SERVER_PORT="${SERVER_PORT:-18088}"
export L1_PORT="${L1_PORT:-18086}"

export TEST_CONTEXT_ROOT="http://localhost:${SERVER_PORT}/"
export TEST_L1_URL="http://localhost:${L1_PORT}/"
export L1_ORDER_URL="http://localhost:${L1_PORT}/"
export TEST_WALLET_SERVER_URL="$TEST_CONTEXT_ROOT"
export INCLUDE_INTEGRATION_TESTS=1

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

port_in_use() {
  ss -tlnp 2>/dev/null | grep -q ":$1 " || return 1
}

cleanup() {
  info "Stopping docker-compose infrastructure..."
  docker compose -f "$COMPOSE_FILE" down --remove-orphans -v 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT INT TERM

# === Prerequisites ===
command -v docker >/dev/null 2>&1 || fail "docker is required"

# === Pre-clean: stop any leftover infra (fresh chain each run) ===
info "Pre-cleaning stale infrastructure..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans -v 2>/dev/null || true

# === Step 1: Start docker-compose server infra ===
info "Starting docker-compose infra (L0:$SERVER_PORT, L1:$L1_PORT)..."
docker compose -f "$COMPOSE_FILE" up -d \
  postgres l0-server l0-mcmc postgres-l1-order l1-order-server l1-order-mcmc 2>&1 | tail -3

# === Step 2: Wait for servers ===
info "Waiting for L0 server (port $SERVER_PORT)..."
for i in $(seq 1 60); do
  sleep 3
  if port_in_use "$SERVER_PORT"; then
    log "L0 ready after ${i}x3s"
    break
  fi
  if [ $i -eq 60 ]; then
    docker compose -f "$COMPOSE_FILE" ps
    fail "L0 failed to start"
  fi
done

info "Waiting for L1 order server (port $L1_PORT)..."
for i in $(seq 1 60); do
  sleep 3
  if port_in_use "$L1_PORT"; then
    log "L1 ready after ${i}x3s"
    break
  fi
  if [ $i -eq 60 ]; then
    docker compose -f "$COMPOSE_FILE" ps
    fail "L1 failed to start"
  fi
done

# === Step 3: Wait for chain to produce blocks ===
info "Waiting for chain to produce blocks..."
for i in $(seq 1 36); do
  sleep 5
  HEIGHT=$(docker exec e2e-postgres psql -U root -d layer0 -t -A -c \
    "SELECT max(height) FROM blocks WHERE blocktype <> 'BLOCKTYPE_INITIAL';" 2>/dev/null || echo "0")
  if [ -n "$HEIGHT" ] && [ "${HEIGHT:-0}" -ge 3 ] 2>/dev/null; then
    log "Chain producing blocks, height=$HEIGHT"
    break
  fi
  if [ $((i % 6)) -eq 0 ]; then
    info "  ...still waiting for blocks (current height: ${HEIGHT:-0})"
  fi
  if [ $i -eq 36 ]; then
    info "Chain height still < 3, continuing anyway..."
  fi
done

# === Step 4: Run all remote integration tests ===
info "Running remote integration tests..."
cd "$PKG_DIR"
set +e
npx vitest run --reporter=verbose --exclude '**/RemoteTest.ts' test/testintegration/
STATUS=$?
set -e

if [ $STATUS -eq 0 ]; then
  log "All remote integration tests passed."
else
  info "Remote integration tests finished with status $STATUS."
fi

exit $STATUS
