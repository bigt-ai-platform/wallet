#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$ROOT/packages/bigtangle-ts"
COMPOSE_FILE="$ROOT/e2e/docker-compose.yml"
VALIDATOR_ENV="${VALIDATOR_ENV:-$ROOT/../blockchain/validator.env}"

# PoS validator keys (shared with ../blockchain remote.sh)
if [ -f "$VALIDATOR_ENV" ]; then
  set -a; . "$VALIDATOR_ENV"; set +a
fi
export POS_VALIDATOR_KEY VALIDATOR_PUBKEY

# L1-order runs its own ordermatch chain, so it needs its own validator
# (ML-DSA-87 seed 0x05). Matches remote.sh. The docker image reads
# L1_POS_VALIDATOR_KEY via the pos.validatorKey application.yml property.
L1_POS_VALIDATOR_KEY="${L1_POS_VALIDATOR_KEY:-0505050505050505050505050505050505050505050505050505050505050505}"
export L1_POS_VALIDATOR_KEY
L1_VALIDATOR_PUBKEY="${L1_VALIDATOR_PUBKEY:-$(cat "$ROOT/../blockchain/.l1validatorpub" 2>/dev/null || true)}"
L1_GENESIS_PUBKEY="${L1_GENESIS_PUBKEY:-$(cat "$ROOT/../blockchain/.l1genesispub" 2>/dev/null || true)}"
export L1_VALIDATOR_PUBKEY L1_GENESIS_PUBKEY

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
  postgres l0-server l0-mcmc postgres-l1-order l1-order-server 2>&1 | tail -3

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

# === Step 2b: Register PoS validator (stake) ===
# Wait for L0 to be fully ready before the fund/stake/activate calls
info "Waiting for L0 to be ready..."
for i in $(seq 1 40); do
  sleep 3
  if curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/" -H 'Content-Type: application/json' -d '{}' 2>/dev/null | grep -q "Bigtangle"; then
    log "L0 ready"
    break
  fi
  if [ $i -eq 40 ]; then
    fail "L0 not ready for validator registration"
  fi
done
if [ -n "${POS_VALIDATOR_KEY:-}" ] && [ -n "${VALIDATOR_PUBKEY:-}" ]; then
  info "Registering PoS validator..."
  FUND_AMOUNT=1000000000000
  curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/fundAddresses" \
    -H 'Content-Type: application/json' \
    -d "{\"addresses\":[{\"address\":\"validator\",\"value\":$FUND_AMOUNT,\"pubkey\":\"$VALIDATOR_PUBKEY\"}]}" \
    >/dev/null 2>&1 && echo "validator funded" || echo "validator funding failed"
  sleep 2
  curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/stakeDeposit" \
    -H 'Content-Type: application/json' \
    -d "{\"pubkey\":\"$VALIDATOR_PUBKEY\",\"amount\":\"32000000\"}" \
    >/dev/null 2>&1 && echo "stake deposited" || echo "stake deposit failed"
  sleep 2
  curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/activateValidator" \
    -H 'Content-Type: application/json' \
    -d "{\"pubkey\":\"$VALIDATOR_PUBKEY\",\"epoch\":0}" \
    >/dev/null 2>&1 && echo "validator activated" || echo "validator activation failed"
else
  info "No validator keys found (expected $VALIDATOR_ENV); PoS chain will not produce blocks"
fi

# === Step 3: Wait for chain to produce PoS beacons ===
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

# === Step 3b: Restart L1 after L0 is ready (fixes L1 init-sync startup race) ===
info "Restarting L1 order server so it syncs the ready L0 chain..."
docker compose -f "$COMPOSE_FILE" up -d --force-recreate l1-order-server 2>&1 | tail -2
for i in $(seq 1 40); do
  sleep 3
  if port_in_use "$L1_PORT"; then
    log "L1 ready after restart"
    break
  fi
  if [ $i -eq 40 ]; then
    docker compose -f "$COMPOSE_FILE" ps
    fail "L1 failed to restart"
  fi
done
# Allow the L1 to sync the L0 chain (index orders) before running tests
sleep 25

# === Step 3c: Bootstrap the L1-order chain's own validator ===
# L1-order runs a fully separated ordermatch chain (own DB, own consensus).
# It must have its own staked validator so it can produce beacons and confirm
# on-chain order funding (mirrors remote.sh Step 7c).
if [ -n "${L1_POS_VALIDATOR_KEY:-}" ] && [ -n "${L1_VALIDATOR_PUBKEY:-}" ]; then
  info "Registering L1-order validator..."
  L1_FUND_AMOUNT=1000000000000
  curl -sf -X POST "http://127.0.0.1:$L1_PORT/fundAddresses" \
    -H 'Content-Type: application/json' \
    -d "{\"addresses\":[{\"address\":\"validator\",\"value\":$L1_FUND_AMOUNT,\"pubkey\":\"$L1_VALIDATOR_PUBKEY\"}]}" \
    >/dev/null 2>&1 && echo "L1 validator funded" || echo "L1 validator funding failed"
  sleep 2
  curl -sf -X POST "http://127.0.0.1:$L1_PORT/stakeDeposit" \
    -H 'Content-Type: application/json' \
    -d "{\"pubkey\":\"$L1_VALIDATOR_PUBKEY\",\"amount\":\"32000000\"}" \
    >/dev/null 2>&1 && echo "L1 stake deposited" || echo "L1 stake deposit failed"
  sleep 2
  curl -sf -X POST "http://127.0.0.1:$L1_PORT/activateValidator" \
    -H 'Content-Type: application/json' \
    -d "{\"pubkey\":\"$L1_VALIDATOR_PUBKEY\",\"epoch\":0}" \
    >/dev/null 2>&1 && echo "L1 validator activated" || echo "L1 validator activation failed"

  # Fund the L1 genesis wallet (ML-DSA-87 seed 0x01) so the remote tests can
  # pay fees / create tokens directly on the L1-order chain.
  if [ -n "${L1_GENESIS_PUBKEY:-}" ]; then
    curl -sf -X POST "http://127.0.0.1:$L1_PORT/fundAddresses" \
      -H 'Content-Type: application/json' \
      -d "{\"addresses\":[{\"address\":\"genesis\",\"value\":100000000000000,\"pubkey\":\"$L1_GENESIS_PUBKEY\"}]}" \
      >/dev/null 2>&1 && echo "L1 genesis wallet funded" || echo "L1 genesis funding failed"
  fi

  info "Waiting for L1-order beacon production..."
  for i in $(seq 1 40); do
    sleep 3
    L1_H=$(docker exec e2e-l1-order-pg psql -U root -d ordermatch -t -A -c \
      "SELECT max(height) FROM blocks WHERE blocktype <> 'BLOCKTYPE_INITIAL';" 2>/dev/null || echo "0")
    if [ -n "$L1_H" ] && [ "${L1_H:-0}" -ge 1 ] 2>/dev/null; then
      log "L1-order chain producing blocks, height=$L1_H"
      break
    fi
  done
  sleep 5
else
  info "No L1 validator keys; L1-order chain will not produce beacons"
fi

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
