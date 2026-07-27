#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/e2e/docker-compose.yml"

SERVER_PORT="${SERVER_PORT:-18088}"
L1_PORT="${L1_PORT:-18086}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

cleanup() {
  info "Cleaning up..."
  docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
  log "Done."
}

if [[ "${1:-}" == "down" ]]; then
  cleanup
  exit 0
fi

# Start L0 + L1 order infrastructure
info "Starting Layer 0 (postgres + L0 server + MCMC)..."
docker compose -f "$COMPOSE_FILE" up -d postgres l0-server l0-mcmc

info "Starting Layer 1 Order (postgres + L1 order server + MCMC)..."
docker compose -f "$COMPOSE_FILE" up -d postgres-l1-order l1-order-server l1-order-mcmc

# Wait for L0 server
info "Waiting for L0 server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${SERVER_PORT}/" >/dev/null 2>&1; then
    log "L0 server ready on http://localhost:${SERVER_PORT}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    docker compose -f "$COMPOSE_FILE" logs --tail=20 l0-server
    fail "L0 server not ready after 90s"
  fi
  sleep 3
done

# Wait for L1 order server
info "Waiting for L1 order server..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${L1_PORT}/" >/dev/null 2>&1; then
    log "L1 order server ready on http://localhost:${L1_PORT}"
    break
  fi
  if [ "$i" -eq 30 ]; then
    docker compose -f "$COMPOSE_FILE" logs --tail=20 l1-order-server
    fail "L1 order server not ready after 90s"
  fi
  sleep 3
done

# Wait for MCMC to produce blocks on L0
info "Waiting for L0 MCMC to produce blocks..."
for i in $(seq 1 20); do
  TIP=$(curl -s "http://localhost:${SERVER_PORT}/getTip" -X POST \
    -H "Content-Type: application/octet-stream" --data-binary '{}' 2>&1)
  if echo "$TIP" | grep -q "dataHex"; then
    log "L0 MCMC producing blocks, chain tip available"
    break
  fi
  if [ "$i" -eq 20 ]; then
    info "Chain not yet initialized (expected on fresh DB), continuing..."
  fi
  sleep 3
done

log "Infrastructure ready"
