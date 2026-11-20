#!/usr/bin/env bash
# issuer-wire.sh — end-to-end test of the issuer <-> wallet contract on the wire.
#
# Brings up the REAL issuer service (Fastify + Postgres, not the mock), seeds one
# holder balance, serves the exported web build, and drives
# `e2e/playwright/tests/external-asset-wire.spec.ts` against it.
#
#   ./e2e/issuer-wire.sh                # build must exist (see below)
#
# Prereqs: docker, the web build at e2e/web-build, and the service deps.
#   cd expo-app && npm run web:build
#
# Nothing here touches a chain: the issuer's adapters are inert without
# ETH_RPC_URL / L1_* and the test only exercises the HTTP contract, the store
# and the funding rails.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_NAME="${PG_NAME:-asset-issuer-wire-db}"
PG_PORT="${PG_PORT:-15432}"
API_PORT="${API_PORT:-18092}"
WEB_PORT="${WEB_PORT:-18081}"
DB_URL="postgres://asset_issuer:test1234@127.0.0.1:${PG_PORT}/asset_issuer"
# The EC wallet the spec injects; the seeded balance belongs to this account.
ACCOUNT="1FB3WSwtExGLQUmNp4AQF66tAwAQp6igW3"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
die()  { echo -e "${RED}[FAIL]${NC} $1" >&2; exit 1; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

API_PID=""; HTTP_PID=""
cleanup() {
  [[ -n "$API_PID" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "$HTTP_PID" ]] && kill "$HTTP_PID" 2>/dev/null || true
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[ -d "$ROOT/e2e/web-build" ] || die "no web build — run: (cd expo-app && npm run web:build)"
# A stale server on WEB_PORT would silently serve an older bundle than the one
# under test.
pkill -f "http-server.* ${WEB_PORT}" >/dev/null 2>&1 || true

info "Postgres on :$PG_PORT"
docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
docker run -d --name "$PG_NAME" \
  -e POSTGRES_DB=asset_issuer -e POSTGRES_USER=asset_issuer -e POSTGRES_PASSWORD=test1234 \
  -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
# pg_isready answers during initdb's temporary server (before POSTGRES_DB exists),
# so probe the database itself until a query succeeds.
for _ in $(seq 1 40); do
  docker exec "$PG_NAME" psql -U asset_issuer -d asset_issuer -c 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG_NAME" psql -U asset_issuer -d asset_issuer -c 'select 1' >/dev/null 2>&1 \
  || die "postgres did not become ready"

info "schema"
docker exec -i "$PG_NAME" psql -v ON_ERROR_STOP=1 -U asset_issuer -d asset_issuer \
  < "$ROOT/services/asset-issuer/schema.sql" >/dev/null
log "schema applied"

info "issuer service on :$API_PORT"
(
  cd "$ROOT/services/asset-issuer"
  DATABASE_URL="$DB_URL" NETWORK=Test PORT="$API_PORT" CORS_ORIGIN="http://localhost:${WEB_PORT}" npx tsx src/main.ts >"${TMPDIR:-/tmp}/issuer-wire.log" 2>&1
) &
API_PID=$!
for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1 || {
  tail -20 "${TMPDIR:-/tmp}/issuer-wire.log" >&2
  die "issuer did not become healthy"
}
log "issuer healthy"

info "seed holder balance (1,000 HKD) + reserve"
docker exec -i "$PG_NAME" psql -v ON_ERROR_STOP=1 -U asset_issuer -d asset_issuer >/dev/null <<SQL
INSERT INTO holder_balances (asset_id, account, available_raw, pending_raw)
VALUES ('hkd', '${ACCOUNT}', 1000000000, 0)
ON CONFLICT (asset_id, account) DO UPDATE SET available_raw = 1000000000, pending_raw = 0;
INSERT INTO reserves (asset_id, reserve_raw, supply_raw, dust_raw)
VALUES ('hkd', 1000000000, 1000000000, 0)
ON CONFLICT (asset_id) DO UPDATE SET reserve_raw = 1000000000, supply_raw = 1000000000, dust_raw = 0;
SQL
curl -sf "http://127.0.0.1:${API_PORT}/balances?account=${ACCOUNT}" | grep -q 1000000000 \
  || die "seeded balance is not visible through the API"
log "seeded"

info "web build on :$WEB_PORT"
"$ROOT/node_modules/.bin/http-server" "$ROOT/e2e/web-build" -p "$WEB_PORT" --silent &
HTTP_PID=$!
for _ in $(seq 1 15); do
  curl -sf "http://localhost:${WEB_PORT}/" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://localhost:${WEB_PORT}/" >/dev/null 2>&1 || die "web server not ready"

info "playwright (real issuer)"
cd "$ROOT"
APP_URL="http://localhost:${WEB_PORT}/" ISSUER_URL="http://127.0.0.1:${API_PORT}" \
  "$ROOT/node_modules/.bin/playwright" test --config e2e/playwright.config.ts \
  external-asset-wire.spec.ts --reporter=list
