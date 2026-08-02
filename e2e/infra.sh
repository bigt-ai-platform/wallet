#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCKCHAIN="$ROOT/../blockchain"
VALIDATOR_ENV="$BLOCKCHAIN/validator.env"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

# Use Java 25 if available (matches ../blockchain remote.sh)
if [ -x /home/jcui/.local/java-25/bin/java ]; then
    export JAVA_HOME=/home/jcui/.local/java-25
    export PATH="$JAVA_HOME/bin:$PATH"
fi

# PoS validator configuration (if the env file is present)
POS_ARGS=""
if [ -f "$VALIDATOR_ENV" ]; then
    set -a; . "$VALIDATOR_ENV"; set +a
    # PoS-only: reward service disabled so the ONLY beacon producer is the
    # slot proposer (single-headed chain, no forks). Short slots confirm
    # blocks quickly so the remote tests' polling windows fit.
    POS_ARGS="-Dservice.schedule.reward=false -Dpos.validatorKey=$POS_VALIDATOR_KEY -Dpos.slotIntervalMs=2000"
    info "PoS enabled: reward disabled, validator key configured (${#POS_VALIDATOR_KEY} hex)"
fi

SERVER_PORT="${SERVER_PORT:-8089}"
L1_PORT="${L1_PORT:-8086}"
MCMC_PORT="${MCMC_PORT:-8091}"
DB_NAME="${DB_NAME:-info}"
DB_PORT="${DB_PORT:-5432}"
PG_CONTAINER_NAME="${PG_CONTAINER_NAME:-}"
PG_IMAGE="${PG_IMAGE:-postgres:16}"
PG_MARKER="$ROOT/e2e/.postgres-created"

PG_CONTAINER=""
CREATED_PG=0
L0_PID=""; MCMC_PID=""; L1_PID=""
L0_LOG="/tmp/l0-server.log"; MCMC_LOG="/tmp/l0-mcmc.log"; L1_LOG="/tmp/l1-order-server.log"

SCHED_ARGS="-Dservice.schedule.mcmc=true -Dservice.schedule.microbatch=true -Dservice.schedule.blockbatch=true -Dservice.schedule.blockbatchrate=5000 -Dservice.schedule.initsync=true"
L0_ARGS="--server.net=Test --server.port=$SERVER_PORT --server.mineraddress=mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4"
L1_ARGS="--server.net=Test --server.port=$L1_PORT --server.mineraddress=mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4 --server.chain=L0"

cleanup() {
  info "Cleaning up..."
  kill $L0_PID $MCMC_PID $L1_PID 2>/dev/null || true
  wait 2>/dev/null || true
  if [ "$CREATED_PG" = "1" ]; then
    info "Removing PostgreSQL container: $PG_CONTAINER"
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
    rm -f "$PG_MARKER"
  fi
  log "Done."
}
# Only cleanup on INT/TERM (Ctrl+C or kill), not on normal exit
trap cleanup INT TERM

# === Step 1: Find or create PostgreSQL ===
info "Finding PostgreSQL container..."

create_postgres() {
  local name="$1"
  info "Creating PostgreSQL container: $name"
  docker rm -f "$name" >/dev/null 2>&1 || true
  if ! docker run -d --name "$name" \
    -e POSTGRES_USER=root -e POSTGRES_PASSWORD=test1234 -e POSTGRES_DB=postgres \
    -p "$DB_PORT:5432" "$PG_IMAGE" -c max_connections=200 >/dev/null 2>&1; then
    fail "Failed to create PostgreSQL container '$name'"
  fi
  PG_CONTAINER="$name"
  CREATED_PG=1
  echo "$name" > "$PG_MARKER"
}

if [ -n "$PG_CONTAINER_NAME" ]; then
  # A specific container was requested (e.g. by e2eremote.sh)
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${PG_CONTAINER_NAME}$"; then
    PG_CONTAINER="$PG_CONTAINER_NAME"
  else
    create_postgres "$PG_CONTAINER_NAME"
  fi
else
  for candidate in "l0-pg-0" "test-bigtangle-postgres" "e2e-postgres"; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${candidate}$"; then
      PG_CONTAINER="$candidate"
      break
    fi
  done
  if [ -z "$PG_CONTAINER" ]; then
    create_postgres "e2e-postgres"
  fi
fi
log "Using PostgreSQL container: $PG_CONTAINER"

# Determine the host port the container's 5432 is published on
HOST_PORT=$(docker port "$PG_CONTAINER" 5432/tcp 2>/dev/null | head -n1 | sed 's/.*://')
if [ -z "$HOST_PORT" ]; then
  fail "PostgreSQL container '$PG_CONTAINER' does not expose 5432 on the host; cannot connect from Java apps"
fi
DB_PORT="$HOST_PORT"

DB_ARGS="-DDB_HOSTNAME=127.0.0.1 -DDB_USERNAME=root -DDB_PASSWORD=test1234 -DDB_PORT=$DB_PORT -DDB_NAME=$DB_NAME"

echo "Waiting for PostgreSQL..."
for i in $(seq 1 15); do
  if docker exec "$PG_CONTAINER" pg_isready -U root -d postgres >/dev/null 2>&1; then
    log "PostgreSQL ready"
    break
  fi
  if [ "$i" -eq 15 ]; then
    fail "PostgreSQL not ready"
  fi
  sleep 2
done

# === Step 2: Drop & recreate database ===
info "Recreating database '$DB_NAME'..."
docker exec "$PG_CONTAINER" psql -U root -d postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" 2>/dev/null || true
docker exec "$PG_CONTAINER" psql -U root -d postgres -c "CREATE DATABASE $DB_NAME;"
log "Database '$DB_NAME' ready"

# === Step 3: Build modules ===
info "Building Java modules..."
# Use -q for quiet, skip tests, only build needed modules
cd "$BLOCKCHAIN"
mvn install -DskipTests -q \
  -pl bigtangle-core,bigtangle-servercore,layer0-server,layer0-mcmc,l1-order-server -am \
  2>&1 | tail -5
log "Build complete"

# === Step 4: Start L0 server ===
info "Starting L0 HTTP server (port $SERVER_PORT)..."
pkill -f "spring-boot:run -pl layer0-server" 2>/dev/null || true
SERVER_PEER_ARGS="-Dpeer.udpPort=30307 -Dpeer.tcpPort=30308 -Dgossip.port=9095"
nohup mvn spring-boot:run -pl layer0-server \
  -Dspring-boot.run.jvmArguments="$DB_ARGS $SCHED_ARGS $SERVER_PEER_ARGS -Dbridge.active=false -Danchor.active=false" \
  -Dspring-boot.run.arguments="$L0_ARGS" \
  > "$L0_LOG" 2>&1 &
L0_PID=$!

for i in $(seq 1 30); do
  sleep 2
  if ss -tlnp 2>/dev/null | grep -q ":$SERVER_PORT "; then
    log "L0 HTTP ready after ${i}s (port $SERVER_PORT)"
    break
  fi
  if [ $i -eq 30 ]; then
    tail -30 "$L0_LOG"
    fail "L0 HTTP failed to start"
  fi
done

# === Step 5: Wait for genesis block ===
info "Waiting for genesis block..."
for i in $(seq 1 10); do
  sleep 3
  HASH=$(docker exec "$PG_CONTAINER" psql -U root -d $DB_NAME -t -A -c "
    SELECT encode(hash, 'hex') FROM blocks WHERE blocktype = 'BLOCKTYPE_INITIAL' LIMIT 1;
  " 2>/dev/null || echo "")
  if [ -n "$HASH" ]; then
    log "Genesis block found: $HASH"
    break
  fi
  if [ $i -eq 10 ]; then
    fail "No genesis block found after 30s"
  fi
done

# === Step 6: Start L0 MCMC ===
info "Starting L0 MCMC (port $MCMC_PORT)..."
pkill -f "spring-boot:run -pl layer0-mcmc" 2>/dev/null || true
MCMC_PEER_ARGS="-Dpeer.udpPort=30309 -Dpeer.tcpPort=30310 -Dgossip.port=9097"
MCMC_ARGS="--server.net=Test --server.port=$MCMC_PORT --server.mineraddress=mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4"
nohup mvn spring-boot:run -pl layer0-mcmc \
  -Dspring-boot.run.jvmArguments="$DB_ARGS $SCHED_ARGS $MCMC_PEER_ARGS -Dserver.port=$MCMC_PORT -Dserver.requester=http://127.0.0.1:$SERVER_PORT -Dservice.schedule.rewardonlywithreferenced=false $POS_ARGS" \
  -Dspring-boot.run.arguments="$MCMC_ARGS" \
  > "$MCMC_LOG" 2>&1 &
MCMC_PID=$!
log "MCMC PID: $MCMC_PID"

# === Step 7: Start L1 Order Server ===
info "Starting L1 Order Server (port $L1_PORT)..."
pkill -f "spring-boot:run -pl l1-order-server" 2>/dev/null || true
L1_PEER_ARGS="-Dpeer.udpPort=30311 -Dpeer.tcpPort=30312 -Dgossip.port=9099"
nohup mvn spring-boot:run -pl l1-order-server \
  -Dspring-boot.run.jvmArguments="$DB_ARGS -Dservice.schedule.mcmc=true $L1_PEER_ARGS -Dserver.port=$L1_PORT -Dservice.schedule.rewardonlywithreferenced=false" \
  -Dspring-boot.run.arguments="$L1_ARGS" \
  > "$L1_LOG" 2>&1 &
L1_PID=$!

for i in $(seq 1 30); do
  sleep 2
  if ss -tlnp 2>/dev/null | grep -q ":$L1_PORT "; then
    log "L1 Order Server ready after ${i}s (port $L1_PORT)"
    break
  fi
  if [ $i -eq 30 ]; then
    tail -30 "$L1_LOG"
    fail "L1 Order Server failed to start"
  fi
done

# === Step 8: Insert genesis into TipsQueue ===
info "Initializing TipsQueue..."
docker exec "$PG_CONTAINER" psql -U root -d $DB_NAME -c "
  INSERT INTO tipsqueue (hash, block, height, inserttime)
  SELECT b.hash, b.block, b.height, b.inserttime
  FROM blocks b WHERE b.blocktype = 'BLOCKTYPE_INITIAL' LIMIT 1
  ON CONFLICT (hash) DO NOTHING;
" 2>/dev/null || true
docker exec "$PG_CONTAINER" psql -U root -d $DB_NAME -c "
  INSERT INTO tipsqueue (hash, block, height, inserttime)
  SELECT decode(lpad(to_hex(nextval('hibernate_sequence')::bigint), 64, '0'), 'hex'),
         b.block, b.height, b.inserttime
  FROM blocks b WHERE b.blocktype = 'BLOCKTYPE_INITIAL' LIMIT 1
  ON CONFLICT (hash) DO NOTHING;
" 2>/dev/null || true
sleep 3
TIP_COUNT=$(docker exec "$PG_CONTAINER" psql -U root -d $DB_NAME -t -A -c "SELECT count(*) FROM tipsqueue;")
log "TipsQueue has $TIP_COUNT entries"

# === Step 9: Register the PoS validator ===
if [ -f "$VALIDATOR_ENV" ] && [ -n "${VALIDATOR_PUBKEY:-}" ]; then
    info "Registering PoS validator..."
    FUND_AMOUNT=1000000000000
    curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/fundAddresses" \
        -H 'Content-Type: application/json' \
        -d "{\"addresses\":[{\"address\":\"validator\",\"value\":$FUND_AMOUNT,\"pubkey\":\"$VALIDATOR_PUBKEY\"}]}" \
        >/dev/null 2>&1 && echo "validator funded" || echo "validator funding failed"
    sleep 2
    curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/stakeDeposit" \
        -H 'Content-Type: application/json' \
        -d "{\"pubkey\":\"$VALIDATOR_PUBKEY\",\"amount\":\"32000000\",\"privateKey\":\"$POS_VALIDATOR_KEY\"}" \
        >/dev/null 2>&1 && echo "stake deposited" || echo "stake deposit failed"
    sleep 2
    curl -sf -X POST "http://127.0.0.1:$SERVER_PORT/activateValidator" \
        -H 'Content-Type: application/json' \
        -d "{\"pubkey\":\"$VALIDATOR_PUBKEY\",\"epoch\":0}" \
        >/dev/null 2>&1 && echo "validator activated" || echo "validator activation failed"
fi

# === Step 10: Wait for MCMC/PoS to produce blocks ===
info "Waiting for MCMC to produce blocks..."
for i in $(seq 1 20); do
  sleep 3
  HEIGHT=$(docker exec "$PG_CONTAINER" psql -U root -d $DB_NAME -t -A -c "
    SELECT max(height) FROM blocks WHERE blocktype <> 'BLOCKTYPE_INITIAL';
  " 2>/dev/null || echo "0")
  if [ -n "$HEIGHT" ] && [ "$HEIGHT" -gt 0 ]; then
    log "MCMC producing blocks, height=$HEIGHT"
    break
  fi
  if [ $i -eq 20 ]; then
    info "Chain height still 0, continuing anyway..."
  fi
done
sleep 5

log "Infrastructure ready"
echo ""
echo "  L0 server:    http://localhost:${SERVER_PORT}/"
echo "  L1 order:     http://localhost:${L1_PORT}/"
echo "  MCMC:         port ${MCMC_PORT}"
echo ""
echo "Run tests with:"
echo "  TEST_CONTEXT_ROOT=http://localhost:${SERVER_PORT}/ TEST_L1_URL=http://localhost:${L1_PORT}/ INCLUDE_INTEGRATION_TESTS=1 ..."
echo ""
echo "Stop with:  kill $L0_PID $MCMC_PID $L1_PID"
