#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCKCHAIN_ROOT="${BLOCKCHAIN_ROOT:-/home/jcui/git/blockchain}"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
KEEP_SYSTEMS="${DOCKER_KEEP_SYSTEMS:-0}"
RUN_TESTS="${DOCKER_RUN_TESTS:-1}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

cleanup() {
  if [[ "$KEEP_SYSTEMS" == "0" ]]; then
    info "Tearing down Docker services..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    log "Cleanup done."
  fi
}
trap cleanup EXIT

# ── Build ────────────────────────────────────────────────────────────
info "Building blockchain server image..."
docker compose -f "$COMPOSE_FILE" build l0-server
log "Image built."

# ── Start ────────────────────────────────────────────────────────────
info "Starting Docker services (postgres + L0 server)..."
docker compose -f "$COMPOSE_FILE" up -d postgres l0-server

info "Waiting for L0 server to be ready..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:8088/" >/dev/null 2>&1; then
    log "L0 server ready on http://localhost:8088"
    break
  fi
  if [ "$i" -eq 30 ]; then
    docker compose -f "$COMPOSE_FILE" logs --tail=50 l0-server
    fail "L0 server not ready after 90s"
  fi
  sleep 3
done

# ── Run TS integration tests ─────────────────────────────────────────
if [[ "$RUN_TESTS" == "1" ]]; then
  info "Running TypeScript integration tests..."
  cd "$ROOT/packages/bigtangle-ts"

  export TEST_CONTEXT_ROOT="http://localhost:8088/"
  export TEST_WALLET_SERVER_URL="http://localhost:8088/"

  npm run test:integration
  log "All integration tests passed."
else
  info "Tests skipped (DOCKER_RUN_TESTS=0)"
  info "Server running at http://localhost:8088"
  info "Press Ctrl+C to stop."
  wait
fi
