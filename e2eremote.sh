#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$ROOT/packages/bigtangle-ts"
INFRA_SH="$ROOT/e2e/infra.sh"
VALIDATOR_ENV="${VALIDATOR_ENV:-$ROOT/../blockchain/validator.env}"

# PoS validator keys (shared with ../blockchain remote.sh)
if [ -f "$VALIDATOR_ENV" ]; then
  set -a; . "$VALIDATOR_ENV"; set +a
fi
export POS_VALIDATOR_KEY VALIDATOR_PUBKEY

# L1-order runs its own ordermatch chain, so it needs its own validator
# (ML-DSA-87 seed 0x05). Matches remote.sh. Its key is read by remote.sh from
# ../blockchain/.l1validatorpub.
export L1_VALIDATOR_KEY="${L1_VALIDATOR_KEY:-0505050505050505050505050505050505050505050505050505050505050505}"

# Ports matching the TS remote tests (must match remote.sh L0_PORT/L1_PORT and
# the postgres container's exposed port). remote.sh's defaults are tuned to
# avoid dev-machine collisions; the TS tests read these via TEST_CONTEXT_ROOT /
# TEST_L1_URL.
export L0_PORT="${L0_PORT:-18088}"
export L1_PORT="${L1_PORT:-18086}"
export MCMC_PORT="${MCMC_PORT:-18091}"
export PG_PORT="${PG_PORT:-5432}"

export SERVER_PORT="$L0_PORT"
export TEST_CONTEXT_ROOT="http://localhost:${L0_PORT}/"
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

INFRA_PID=""
cleanup() {
  info "Stopping infra via infra.sh -> remote.sh stop..."
  "$INFRA_SH" down 2>/dev/null || true
  if [ -n "$INFRA_PID" ]; then
    kill "$INFRA_PID" 2>/dev/null || true
    wait "$INFRA_PID" 2>/dev/null || true
  fi
  log "Done."
}
trap cleanup EXIT INT TERM

# === Prerequisites ===
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v mvn >/dev/null 2>&1 || fail "mvn is required (infra runs via ../blockchain remote.sh)"

# === Pre-clean: stop any leftover infra (fresh chain each run) ===
info "Pre-cleaning stale infra..."
"$INFRA_SH" down 2>/dev/null || true

# === Step 1: Ensure the postgres container remote.sh requires is up ===
# remote.sh uses `l0-pg-0` or `test-bigtangle-postgres` (helper compose).
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qE "^(l0-pg-0|test-bigtangle-postgres)$"; then
  info "Starting postgres via ../blockchain/helper/docker-compose-base.yml..."
  docker compose -f "$ROOT/../blockchain/helper/docker-compose-base.yml" up -d 2>&1 | tail -2
fi

# === Step 2: Start infra via infra.sh -> remote.sh infra ===
# remote.sh infra builds/runs L0+L1+MCMC, registers the PoS validators, waits
# for a stable beacon chain, then holds until killed. Run it in the background
# and poll for readiness so we can drive the TS test suite.
info "Starting infra via infra.sh -> remote.sh infra (L0:$L0_PORT, L1:$L1_PORT)..."
"$INFRA_SH" up &
INFRA_PID=$!

# === Step 3: Wait for L0 server ===
info "Waiting for L0 server (port $L0_PORT)..."
for i in $(seq 1 90); do
  if port_in_use "$L0_PORT"; then
    log "L0 ready after ${i}x2s"
    break
  fi
  if [ $i -eq 90 ]; then
    info "L0 log tail:"; tail -40 /tmp/l0-server.log 2>/dev/null || true
    fail "L0 failed to start"
  fi
  sleep 2
done

# === Step 4: Wait for L1 order server ===
info "Waiting for L1 order server (port $L1_PORT)..."
for i in $(seq 1 90); do
  if port_in_use "$L1_PORT"; then
    log "L1 ready after ${i}x2s"
    break
  fi
  if [ $i -eq 90 ]; then
    info "L1 log tail:"; tail -40 /tmp/l1-order-server.log 2>/dev/null || true
    fail "L1 failed to start"
  fi
  sleep 2
done

# === Step 5: Wait for a stable L0 beacon chain ===
# Mirrors remote.sh's STABLE_BEACONS wait: a token block built on an early,
# still-reorganising beacon parent can be orphaned and never confirmed.
STABLE_BEACONS="${STABLE_BEACONS:-6}"
PG_CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "^(l0-pg-0|test-bigtangle-postgres)$" | head -1)
info "Waiting for a stable L0 beacon chain (>= $STABLE_BEACONS confirmed beacons)..."
for i in $(seq 1 60); do
  STABLE_COUNT=$(docker exec "$PG_CONTAINER" psql -U root -d info -t -A -c \
    "SELECT count(*) FROM blocks WHERE confirmed AND chainlength > 0;" 2>/dev/null || echo "0")
  if [ -n "$STABLE_COUNT" ] && [ "${STABLE_COUNT//[^0-9]/}" -ge "$STABLE_BEACONS" ] 2>/dev/null; then
    log "L0 beacon chain stable: $STABLE_COUNT confirmed beacons"
    break
  fi
  if [ $i -eq 60 ]; then
    info "WARNING: L0 beacon chain not stable after 180s (confirmed=${STABLE_COUNT:-0}), continuing anyway..."
  fi
  sleep 3
done
sleep 3

# === Step 6: Run all remote integration tests ===
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
