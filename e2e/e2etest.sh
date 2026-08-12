#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="$ROOT/e2e"
WEB_BUILD="$ROOT/e2e/web-build"
WEB_PORT="${WEB_PORT:-18081}"
SERVER_PORT="${SERVER_PORT:-18088}"
L1_PORT="${L1_PORT:-18086}"

# Optional first arg selects which part(s) to run:
#   payment | tracking | order | remaining | tests (all 4 greps) | demo | all (default)
CMD="${1:-all}"
case " $CMD " in
  " all "|" payment "|" tracking "|" order "|" remaining "|" tests "|" demo ") ;;
  *) fail "Unknown part '$CMD'. Use one of: all, payment, tracking, order, remaining, tests, demo";;
esac

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

# Independently verify the payment e2e test's result on-chain. The payment spec
# writes the confirmed txHash/status to test-results/payment-verification.json
# (it uses random wallets, so the script cannot know the recipient in advance).
# We re-check the transaction status via the L0 getTransactionStatus API.
verify_payment_status() {
  local handoff="$E2E_DIR/test-results/payment-verification.json"
  if [[ ! -f "$handoff" ]]; then
    fail "Payment verification handoff missing: $handoff (payment spec did not confirm a transaction)"
  fi
  local txhash status address
  txhash=$(node -e "const v=require('$handoff'); process.stdout.write(v.txHash||'')" 2>/dev/null)
  status=$(node -e "const v=require('$handoff'); process.stdout.write(v.status||'')" 2>/dev/null)
  address=$(node -e "const v=require('$handoff'); process.stdout.write(v.address||'')" 2>/dev/null)
  if [[ -z "$txhash" || -z "$status" ]]; then
    fail "Payment verification handoff is invalid (missing txHash/status): $(cat "$handoff")"
  fi
  if [[ "$status" != "CONFIRMED" ]]; then
    fail "Payment test handoff reports status=$status (expected CONFIRMED) for txHash=$txhash"
  fi
  info "Payment handoff: txHash=$txhash status=$status address=$address"

  local body api_status
  body=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/getTransactionStatus" \
    -H 'Content-Type: application/json' \
    -d "{\"txHash\":\"$txhash\"}") || fail "L0 getTransactionStatus request failed for $txhash"
  api_status=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status||'')" "$body" 2>/dev/null)
  if [[ "$api_status" != "CONFIRMED" ]]; then
    fail "On-chain verification FAILED: L0 getTransactionStatus=$api_status (expected CONFIRMED) for txHash=$txhash"
  fi
  log "Payment verified on-chain: txHash=$txhash status=$api_status"
}

cleanup() {
  info "Cleaning up..."
  pkill -f "http-server.*web-build" 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT

info "Checking infrastructure..."
curl -sf "http://localhost:${SERVER_PORT}/" >/dev/null 2>&1 || fail "Infra not ready — run ./e2e/infra.sh first"
log "Infrastructure ready."

# 1. Build web app
if [[ ! -d "$WEB_BUILD" ]]; then
  info "Building web app..."
  cd "$ROOT/expo-app"
  npm run web:build 2>&1 | tail -3
  log "Web app built."
else
  info "Web build already exists, skipping build."
fi

# 3. Start web server
info "Starting web server..."
npx http-server "$WEB_BUILD" -p "$WEB_PORT" --silent &
sleep 2
curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 || fail "Web server not ready"
log "Web server on http://localhost:$WEB_PORT"

# 4. Run Playwright payment test
if [[ "$CMD" == "all" || "$CMD" == "payment" || "$CMD" == "tests" ]]; then
info "Running payment transaction test..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
  npx playwright test --reporter=list --grep "Payment" 2>&1
log "Payment test passed."

# 4a. Verify the payment is DONE on-chain and its transaction status:
#     re-check the confirmed txHash via the L0 getTransactionStatus API.
verify_payment_status
fi

# 4b. Run payment & order tracking tests
if [[ "$CMD" == "all" || "$CMD" == "tracking" || "$CMD" == "tests" ]]; then
info "Running payment & order tracking tests..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  npx playwright test --reporter=list --grep "Tracking" 2>&1
log "Tracking tests passed."
fi

# 4b2. Run the order/chart/market-data tests (same base/env as the payment
#      tests: web app on WEB_PORT, L0 on SERVER_PORT, L1 order server on
#      L1_PORT). Standalone only — `all` covers them via the remaining greps.
if [[ "$CMD" == "order" ]]; then
info "Running order e2e tests..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  npx playwright test --reporter=list order.spec.ts chart.spec.ts 2>&1
log "Order e2e tests passed."
fi

# 4c. Run remaining specs (tokens, settings, order, wallet-flow, L1 Test Tab,
#     desktop, demo-flow) not covered by the Payment/Tracking greps.
if [[ "$CMD" == "all" || "$CMD" == "remaining" || "$CMD" == "tests" ]]; then
info "Running remaining e2e specs..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  npx playwright test --reporter=list --grep-invert "Payment|Tracking" 2>&1
log "Remaining e2e specs passed."
fi

# 5. Capture payment flow screenshots and generate payment-flow.pdf. Runs
#    after the chosen test part(s) — part of the default e2etest output.
#    Set NO_PDF=1 to skip.
if [[ -z "${NO_PDF:-}" ]]; then
info "Capturing payment flow screenshots and generating PDF..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  node capture-payment.mjs 2>&1
log "PDF generated: demo-output/pdfs/payment-flow.pdf"


# 5b. Capture order-flow screenshots (Order market list, buy/sell sheet,
#     Chart) and generate order-flow.pdf. Creates a real matched trade on the
#     L1 order chain so the screenshots show real market/chart data.
info "Capturing order flow screenshots and generating PDF..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  node capture-order.mjs 2>&1
log "PDF generated: demo-output/pdfs/order-flow.pdf"
fi
