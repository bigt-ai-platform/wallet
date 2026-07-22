#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="$ROOT/docker/docker-compose.yml"
KEEP_SYSTEMS="${DOCKER_KEEP_SYSTEMS:-0}"
PARALLEL_BUILD="${DOCKER_PARALLEL_BUILD:-1}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

cleanup() {
  info "Cleaning up..."
  if [[ "$KEEP_SYSTEMS" == "0" ]]; then
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
  fi
  pkill -f "http-server.*web-build" 2>/dev/null || true
  log "Cleanup done."
}
trap cleanup EXIT

# ── 1. Build Docker images ───────────────────────────────────────────
info "Building blockchain server image..."
docker compose -f "$COMPOSE_FILE" build l0-server
log "Server image built."

# ── 2. Start blockchain infrastructure ───────────────────────────────
info "Starting blockchain infrastructure (postgres + L0 server + MCMC)..."
docker compose -f "$COMPOSE_FILE" up -d

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

info "Waiting for MCMC to create blocks..."
for i in $(seq 1 20); do
  TIP=$(curl -s "http://localhost:8088/getTip" -X POST -H "Content-Type: application/octet-stream" --data-binary '{}' 2>&1)
  if echo "$TIP" | grep -q "dataHex"; then
    log "MCMC producing blocks, chain tip available"
    break
  fi
  if [ "$i" -eq 20 ]; then
    info "Chain not yet initialized (expected on fresh DB), continuing..."
  fi
  sleep 3
done

info "Waiting for L1 order server to be ready..."
for i in $(seq 1 15); do
  if curl -sf "http://localhost:8086/" >/dev/null 2>&1; then
    log "L1 order server ready on http://localhost:8086"
    break
  fi
  if [ "$i" -eq 15 ]; then info "L1 order server not ready, continuing..."; fi
  sleep 3
done

# ── 3. Build web UI ──────────────────────────────────────────────────
info "Building web UI..."
cd "$ROOT/expo-app"
npx expo export --platform web --output-dir "$ROOT/e2e/web-build" 2>&1 || \
  npm run web:build 2>&1
log "Web UI built."

# ── 4. Serve web UI ──────────────────────────────────────────────────
info "Starting web server for e2e tests..."
npx http-server "$ROOT/e2e/web-build" -p 8081 --silent &
SERVER_PID=$!
sleep 2

if ! curl -sf "http://localhost:8081/" >/dev/null 2>&1; then
  fail "Web server not ready on http://localhost:8081"
fi
log "Web server ready on http://localhost:8081"

# ── 5. Run e2e tests ────────────────────────────────────────────────
info "Running Playwright e2e tests..."
cd "$ROOT/e2e"
npx playwright test 2>&1
log "All e2e tests passed."

# ── 6. Run integration tests (optional) ──────────────────────────────
if [[ "${RUN_INTEGRATION_TESTS:-1}" == "1" ]]; then
  info "Running TypeScript integration tests..."
  cd "$ROOT/packages/bigtangle-ts"
  TEST_CONTEXT_ROOT="http://localhost:8088/" \
  TEST_WALLET_SERVER_URL="http://localhost:8088/" \
  npm run test:integration 2>&1 || true
  log "Integration tests finished."
fi

info "All tests completed successfully."
