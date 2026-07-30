#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLOCKCHAIN="$ROOT/../blockchain"

SERVER_PORT="${SERVER_PORT:-8089}"
L1_PORT="${L1_PORT:-8086}"
MCMC_PORT="${MCMC_PORT:-8091}"
DB_NAME="${DB_NAME:-info}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

PG_CONTAINER=""
L0_PID=""; MCMC_PID=""; L1_PID=""
L0_LOG="/tmp/l0-server.log"; MCMC_LOG="/tmp/l0-mcmc.log"; L1_LOG="/tmp/l1-order-server.log"

DB_ARGS="-DDB_HOSTNAME=127.0.0.1 -DDB_USERNAME=root -DDB_PASSWORD=test1234 -DDB_PORT=$DB_PORT -DDB_NAME=$DB_NAME"
SCHED_ARGS="-Dservice.schedule.mcmc=true -Dservice.schedule.microbatch=true -Dservice.schedule.blockbatch=true -Dservice.schedule.blockbatchrate=5000 -Dservice.schedule.initsync=true"
L0_ARGS="--server.net=Test --server.port=$SERVER_PORT --server.mineraddress=mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4"
L1_ARGS="--server.net=Test --server.port=$L1_PORT --server.mineraddress=mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4"

cleanup() {
  info "Cleaning up..."
  kill $L0_PID $MCMC_PID $L1_PID 2>/dev/null || true
  wait 2>/dev/null || true
  log "Done."
}
# Only cleanup on INT/TERM (Ctrl+C or kill), not on normal exit
trap cleanup INT TERM

# === Step 1: Find PostgreSQL ===
info "Finding PostgreSQL container..."
for candidate in "l0-pg-0" "test-bigtangle-postgres" "e2e-postgres"; do
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${candidate}$"; then
    PG_CONTAINER="$candidate"
    break
  fi
done
if [ -z "$PG_CONTAINER" ]; then
  fail "No PostgreSQL container found. Start one first."
fi
log "Using PostgreSQL container: $PG_CONTAINER"

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
MCMC_PEER_ARGS="-Dpeer.udpPort=30309 -Dpeer.tcpPort=30310 -Dgossip.port=9097"
MCMC_ARGS="--server.net=Test --server.port=$MCMC_PORT --server.mineraddress=mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4"
nohup mvn spring-boot:run -pl layer0-mcmc \
  -Dspring-boot.run.jvmArguments="$DB_ARGS $SCHED_ARGS $MCMC_PEER_ARGS -Dserver.port=$MCMC_PORT -Dservice.schedule.rewardonlywithreferenced=false" \
  -Dspring-boot.run.arguments="$MCMC_ARGS" \
  > "$MCMC_LOG" 2>&1 &
MCMC_PID=$!
log "MCMC PID: $MCMC_PID"

# === Step 7: Start L1 Order Server ===
info "Starting L1 Order Server (port $L1_PORT)..."
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

# === Step 9: Wait for MCMC to produce blocks ===
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
