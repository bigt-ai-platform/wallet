#!/usr/bin/env bash
# Start / stop the L1-SOCIAL chain (CHAIN_ID=SOCIAL) alongside the L0/L1 dev
# infra from e2e/infra.sh.
#
# The bootstrap mirrors ../blockchain/helper/fulltest/remote.sh for L0: the node
# starts with the shared Test genesis CSV (which funds the dev validator seed
# below), then the validator is staked + activated so the chain actually
# produces blocks. Kafka streams stay off; the DB is recreated on every `up`
# (same fresh-chain behaviour remote.sh has for L0/L1).
#
# Usage: e2e/l1social.sh [up|down]
#
# `up` expects e2e/infra.sh up to have run first: it builds/installs the
# blockchain modules this script resolves via mvn spring-boot:run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BC_ROOT="$ROOT/../blockchain"

# Ports (unique per process on this host):
#   L0      24089 / peer 46307,46308 / gossip 25095   (remote.sh)
#   L1      24086 / peer 46311,46312 / gossip 25099   (remote.sh)
#   SOCIAL  24091 / peer 46315,46316 / gossip 25103   (this script)
L1_SOCIAL_PORT="${L1_SOCIAL_PORT:-24091}"
L1_SOCIAL_PEER_UDP="${L1_SOCIAL_PEER_UDP:-46315}"
L1_SOCIAL_PEER_TCP="${L1_SOCIAL_PEER_TCP:-46316}"
L1_SOCIAL_GOSSIP="${L1_SOCIAL_GOSSIP:-25103}"
PG_PORT="${PG_PORT:-21532}"
SOCIAL_DB="${SOCIAL_DB:-social}"
# Deterministic dev seed, same as L0/L1 in remote.sh — TestGenesisOutput.csv
# funds its address (the f38c... row), which is what /stakeDeposit spends.
SOCIAL_VALIDATOR_KEY="${SOCIAL_VALIDATOR_KEY:-0404040404040404040404040404040404040404040404040404040404040404}"
MINER_ADDRESS="${MINER_ADDRESS:-mj61qqqkFDcXFx6P5bMtspDH7tJZ7jVHL4}"
GENESIS_CSV="${TEST_GENESIS_CSV:-$BC_ROOT/helper/test/TestGenesisOutput.csv}"
SOCIAL_LOG="${SOCIAL_LOG:-/tmp/l1-social-server.log}"
BASE="http://127.0.0.1:$L1_SOCIAL_PORT"
# Browser clients (the Expo web app on :8081) query the node cross-origin.
CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:8081,http://127.0.0.1:8081,http://localhost:18081,http://127.0.0.1:18081}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

CMD="${1:-up}"

stop_node() {
  local pid
  pid=$(ss -tlnp 2>/dev/null | grep -E ":$L1_SOCIAL_PORT " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)
  if [ -n "${pid:-}" ]; then
    info "Killing L1-SOCIAL pid $pid (port $L1_SOCIAL_PORT)"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  # Detached launches leave the mvn wrapper around; match module/class only so
  # other infra JVMs are never touched.
  pkill -9 -f "SocialL1ServerStart" 2>/dev/null || true
  pkill -9 -f "spring-boot:run.*-pl l1-social-server" 2>/dev/null || true
  pkill -9 -f "-pl l1-social-server .*spring-boot:run" 2>/dev/null || true
}

case "$CMD" in
  down|stop)
    stop_node
    log "L1-SOCIAL stopped."
    exit 0
    ;;
  up) ;;
  *) fail "Usage: $0 [up|down]" ;;
esac

# ------------------------------------------------------------------- up -----

if curl -sf "$BASE/" 2>/dev/null | grep -qi "bigtangle"; then
  log "L1-SOCIAL already up at $BASE"
  exit 0
fi
if ss -tln 2>/dev/null | grep -qE ":$L1_SOCIAL_PORT "; then
  fail "Port $L1_SOCIAL_PORT is occupied by another process (ss -ltnp | grep $L1_SOCIAL_PORT)."
fi

# Toolchain auto-detect, same as ../blockchain/helper/fulltest/remote.sh.
if [ -x /tmp/opencode/jdk25/bin/java ]; then
  export JAVA_HOME=/tmp/opencode/jdk25
  export PATH=$JAVA_HOME/bin:$PATH
elif [ -x /home/jcui/.local/java-25/bin/java ]; then
  export JAVA_HOME=/home/jcui/.local/java-25
  export PATH=$JAVA_HOME/bin:$PATH
fi
if ! command -v mvn >/dev/null 2>&1; then
  for cand in /tmp/opencode/maven/bin/mvn /opt/maven/bin/mvn /usr/local/maven/bin/mvn /home/jcui/.local/maven/bin/mvn; do
    if [ -x "$cand" ]; then
      export PATH="$(dirname "$cand"):$PATH"
      break
    fi
  done
fi
command -v mvn >/dev/null 2>&1 || fail "mvn not found"
command -v java >/dev/null 2>&1 || fail "java not found"
[ -f "$GENESIS_CSV" ] || fail "genesis CSV missing: $GENESIS_CSV"
[ -d "$BC_ROOT/bigtangle-core/target/classes" ] || fail "bigtangle-core not built — run ./e2e/infra.sh up first"

# PostgreSQL (same container auto-detect as remote.sh; role root/test1234).
export PGPASSWORD="${PGPASSWORD:-test1234}"
PG_CONTAINER="${PG_CONTAINER:-}"
if [ -z "$PG_CONTAINER" ] && command -v docker >/dev/null 2>&1; then
  for cand in l0-pg-0 test-bigtangle-postgres; do
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${cand}$"; then
      PG_CONTAINER="$cand"
      break
    fi
  done
fi
pg_exec() { if [ -n "$PG_CONTAINER" ]; then docker exec "$PG_CONTAINER" "$@"; else "$@"; fi; }
PG_INTERNAL_PORT="${PG_INTERNAL_PORT:-}"
if [ -n "$PG_CONTAINER" ]; then
  if [ -z "$PG_INTERNAL_PORT" ]; then
    for cand in "$PG_PORT" 5432; do
      if pg_exec pg_isready -U root -d postgres -p "$cand" >/dev/null 2>&1; then
        PG_INTERNAL_PORT="$cand"
        break
      fi
    done
  fi
  [ -n "$PG_INTERNAL_PORT" ] || PG_INTERNAL_PORT=5432
else
  [ -n "$PG_INTERNAL_PORT" ] || PG_INTERNAL_PORT="$PG_PORT"
fi

# Fresh chain per `up` (remote.sh drops L0/L1 DBs the same way).
if pg_exec psql -U root -d postgres -p "$PG_INTERNAL_PORT" -c \
    "DROP DATABASE IF EXISTS $SOCIAL_DB;" >/dev/null 2>&1; then
  :
else
  info "DROP '$SOCIAL_DB' skipped (still in use?)"
fi
if ! pg_exec psql -U root -d postgres -p "$PG_INTERNAL_PORT" -c \
    "CREATE DATABASE $SOCIAL_DB;" 2>/dev/null; then
  if ! pg_exec psql -U root -d postgres -p "$PG_INTERNAL_PORT" -t -A -c \
      "SELECT 1 FROM pg_database WHERE datname='$SOCIAL_DB';" 2>/dev/null | grep -q 1; then
    fail "could not create database '$SOCIAL_DB' on postgres:$PG_PORT"
  fi
  info "reusing existing database '$SOCIAL_DB'"
fi
log "Database '$SOCIAL_DB' ready"

# Derive the validator pubkey from the configured seed (ValidatorKeyTool with
# the same classpath trick as remote.sh's req_pubkey).
M2_REPO="$HOME/.m2/repository"
if [ ! -d "$M2_REPO" ] && [ -d /root/.m2/repository ]; then
  M2_REPO="/root/.m2/repository"
fi
req_pubkey() {
  local seed="$1"
  local slf4j guava bcprov
  slf4j="$(find "$M2_REPO" -name 'slf4j-api-*.jar' ! -name '*-sources*' ! -name '*-javadoc*' | sort -V | tail -1)"
  guava="$(find "$M2_REPO" -name 'guava-*.jar' ! -name '*-sources*' ! -name '*-javadoc*' | sort -V | tail -1)"
  bcprov="$(find "$M2_REPO" -name 'bcprov-jdk18on-*.jar' ! -name '*-sources*' ! -name '*-javadoc*' | sort -V | tail -1)"
  "$JAVA_HOME/bin/java" -cp \
    "$BC_ROOT/bigtangle-core/target/classes:$slf4j:$guava:$bcprov" \
    net.bigtangle.tools.ValidatorKeyTool pubkey "$seed" 2>/dev/null | grep '^VALIDATOR_PUBKEY=' | cut -d= -f2
}
SOCIAL_VALIDATOR_PUBKEY="$(req_pubkey "$SOCIAL_VALIDATOR_KEY" || true)"
[ -n "$SOCIAL_VALIDATOR_PUBKEY" ] || fail "could not derive validator pubkey (bigtangle-core built? jars in $M2_REPO?)"
info "L1-SOCIAL validator pubkey: ${SOCIAL_VALIDATOR_PUBKEY:0:24}..."

info "Starting l1-social-server (log: $SOCIAL_LOG)..."
info "  HTTP $L1_SOCIAL_PORT, gossip $L1_SOCIAL_GOSSIP, peer $L1_SOCIAL_PEER_UDP/$L1_SOCIAL_PEER_TCP, db '$SOCIAL_DB'"
cd "$BC_ROOT"
DB_HOSTNAME=127.0.0.1 DB_PORT="$PG_PORT" DB_NAME="$SOCIAL_DB" \
DB_USERNAME=root DB_PASSWORD=test1234 \
SERVER_PORT="$L1_SOCIAL_PORT" SERVER_NET=Test \
RUNKAFKASTREAM=false CREATETABLE=true \
CHAIN_ID=SOCIAL \
POS_VALIDATOR_KEY="$SOCIAL_VALIDATOR_KEY" POS_SLOT_INTERVAL_MS=6000 \
GOSSIP_PORT="$L1_SOCIAL_GOSSIP" \
PEER_UDPPORT="$L1_SOCIAL_PEER_UDP" PEER_TCPPORT="$L1_SOCIAL_PEER_TCP" \
SERVICE_CHAINLENGTH=true SERVICE_MICROBATCH=true \
SERVICE_BLOCKBATCH=true SERVICE_BLOCKBATCH_RATE=10000 SERVICE_INITSYNC=true \
nohup mvn -q -pl l1-social-server spring-boot:run \
  -Dspring-boot.run.jvmArguments="-Dbigtangle.genesis.csv=$GENESIS_CSV -Dserver.corsAllowedOrigins=$CORS_ORIGINS" \
  >"$SOCIAL_LOG" 2>&1 &
SOCIAL_PID=$!

info "Waiting for L1-SOCIAL HTTP on $BASE ..."
READY=0
for i in $(seq 1 90); do
  if curl -sf "$BASE/" 2>/dev/null | grep -qi "bigtangle"; then
    READY=1
    break
  fi
  if ! kill -0 "$SOCIAL_PID" 2>/dev/null; then
    tail -40 "$SOCIAL_LOG" >&2 2>/dev/null || true
    fail "l1-social-server exited during startup (see $SOCIAL_LOG)."
  fi
  sleep 2
done
if [ "$READY" != "1" ]; then
  tail -40 "$SOCIAL_LOG" >&2 2>/dev/null || true
  fail "timed out waiting for L1-SOCIAL on $BASE (see $SOCIAL_LOG)."
fi
log "L1-SOCIAL HTTP ready after ~${i}x2s."

# Same POST retry helper as remote.sh: endpoints answer via the shared
# {"errorcode":0} response envelope.
post_ok() {
  local url="$1"
  local data="$2"
  local tmp resp=""
  tmp=$(mktemp)
  printf '%s' "$data" > "$tmp"
  for _ in $(seq 1 60); do
    resp=$(curl -s -X POST "$url" -H 'Content-Type: application/json' --data-binary @"$tmp" 2>/dev/null || true)
    if printf '%s' "$resp" | grep -q '"errorcode" *: *0'; then
      rm -f "$tmp"
      return 0
    fi
    sleep 2
  done
  echo "  last response: ${resp:+$(printf '%s' "$resp" | head -c 300)}" >&2
  rm -f "$tmp"
  return 1
}

# Genesis funding must be visible before the deposit can be spent.
sleep 2
if post_ok "$BASE/stakeDeposit" \
    "{\"pubkey\":\"$SOCIAL_VALIDATOR_PUBKEY\",\"amount\":\"32000000\"}"; then
  log "L1-SOCIAL stake deposited"
else
  fail "stakeDeposit failed (genesis CSV $GENESIS_CSV? see $SOCIAL_LOG)"
fi
if post_ok "$BASE/activateValidator" \
    "{\"pubkey\":\"$SOCIAL_VALIDATOR_PUBKEY\",\"epoch\":0}"; then
  log "L1-SOCIAL validator activated"
else
  fail "activateValidator failed (see $SOCIAL_LOG)"
fi

# Warn-only: a beacon that does not start within 2 minutes leaves the node up
# for inspection instead of failing the whole `up`.
info "Waiting for the first L1-SOCIAL beacon block..."
PRODUCED=0
HEIGHT=""
for _ in $(seq 1 60); do
  HEIGHT=$(pg_exec psql -U root -d "$SOCIAL_DB" -p "$PG_INTERNAL_PORT" -t -A -c \
    "SELECT max(height) FROM blocks WHERE blocktype <> 'BLOCKTYPE_INITIAL';" 2>/dev/null || echo 0)
  if [ -n "$HEIGHT" ] && [ "$HEIGHT" -gt 0 ] 2>/dev/null; then
    PRODUCED=1
    break
  fi
  sleep 2
done
if [ "$PRODUCED" = "1" ]; then
  log "L1-SOCIAL beacon produced, height=$HEIGHT"
else
  info "WARNING: no beacon block after 120s — chain may still be warming up (see $SOCIAL_LOG)"
fi

log "L1-SOCIAL ready at $BASE (log: $SOCIAL_LOG)"
