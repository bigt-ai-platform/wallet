#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="$ROOT/e2e"
WEB_BUILD="$ROOT/e2e/web-build"
WEB_PORT="${WEB_PORT:-18081}"
SERVER_PORT="${SERVER_PORT:-18088}"
L1_PORT="${L1_PORT:-18086}"
P2P_PORT="${P2P_PORT:-18089}"
P2P_ENGINE_URL="http://localhost:${P2P_PORT}"
P2P_PID=""
HTTP_PID=""
RAISE_PID=""

# Optional first arg selects which part(s) to run:
#   payment | tracking | order | token | blocks | p2p | p2p-ui | remaining | tests (all 4 greps) | demo | all (default)
CMD="${1:-all}"
case " $CMD " in
  " all "|" payment "|" tracking "|" order "|" token "|" blocks "|" p2p "|" p2p-ui "|" remaining "|" tests "|" demo ") ;;
  *) fail "Unknown part '$CMD'. Use one of: all, payment, tracking, order, token, blocks, p2p, p2p-ui, remaining, tests, demo";;
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

  # The single-validator test beacon chain can reorg in the seconds between the
  # test confirming the payment and this harness re-checking it (a confirmed
  # block on a competing branch drops the tx back to BATCHED). Poll until it
  # re-confirms (the orphaned tx re-enters the mempool and confirms again), up
  # to ~90s.
  local body api_status
  for i in $(seq 1 30); do
    body=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/getTransactionStatus" \
      -H 'Content-Type: application/json' \
      -d "{\"txHash\":\"$txhash\"}" 2>/dev/null || true)
    api_status=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status||'')" "$body" 2>/dev/null)
    if [[ "$api_status" == "CONFIRMED" ]]; then
      log "Payment verified on-chain: txHash=$txhash status=$api_status"
      return 0
    fi
    sleep 3
  done
  fail "On-chain verification FAILED: L0 getTransactionStatus=$api_status (expected CONFIRMED) for txHash=$txhash"
}

# Independently verify the p2p settlement handoff (both wallet legs) on-chain:
# the spec writes escrow/release txHash+address to
# test-results/p2p-settlement.json; each leg must be CONFIRMED and pay the
# address it claims — the same evidence bigtai's chain gate re-checks.
verify_p2p_legs() {
  local handoff="$E2E_DIR/test-results/p2p-settlement.json"
  if [[ ! -f "$handoff" ]]; then
    fail "P2P settlement handoff missing: $handoff (p2p spec did not confirm both legs)"
  fi
  local leg txhash address
  for leg in escrow release; do
    txhash=$(node -e "const v=require('$handoff'); process.stdout.write((v['$leg']||{}).txHash||'')" 2>/dev/null)
    address=$(node -e "const v=require('$handoff'); process.stdout.write((v['$leg']||{}).address||'')" 2>/dev/null)
    if [[ -z "$txhash" || -z "$address" ]]; then
      fail "P2P $leg leg invalid in handoff: $(cat "$handoff")"
    fi
    local body api_status api_address
    for i in $(seq 1 30); do
      body=$(curl -sf -X POST "http://localhost:${SERVER_PORT}/getTransactionStatus" \
        -H 'Content-Type: application/json' \
        -d "{\"txHash\":\"$txhash\"}" 2>/dev/null || true)
      api_status=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).status||'')" "$body" 2>/dev/null)
      if [[ "$api_status" == "CONFIRMED" ]]; then
        api_address=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).address||'')" "$body" 2>/dev/null)
        if [[ -n "$api_address" && "$api_address" != "$address" ]]; then
          fail "P2P $leg leg pays $api_address, expected $address (txHash=$txhash)"
        fi
        log "P2P $leg leg verified on-chain: txHash=$txhash address=$address"
        break
      fi
      if [[ "$i" == "30" ]]; then
        fail "P2P $leg leg L0 getTransactionStatus=$api_status (expected CONFIRMED) for txHash=$txhash"
      fi
      sleep 3
    done
  done
}

cleanup() {
  info "Cleaning up..."
  [[ -n "$P2P_PID" ]] && kill "$P2P_PID" 2>/dev/null || true
  # Kill by saved PID: http-server rewrites its process title to just
  # "http-server", so a `pkill -f` cmdline pattern can never match it and the
  # 18081 listener would leak into the next run (EADDRINUSE).
  [[ -n "$HTTP_PID" ]] && kill "$HTTP_PID" 2>/dev/null || true
  [[ -n "$RAISE_PID" ]] && kill "$RAISE_PID" 2>/dev/null || true
  pkill -f "http-server.*web-build" 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT

# HEADED=1: Playwright's browser window can map behind an already-open
# (typically maximized) browser on the X desktop, so nothing appears to
# happen even though the tests are running. Watch for each new Playwright
# window and raise/focus it as soon as it appears. No-op when headless, when
# DISPLAY is unset, or when xdotool is unavailable.
start_window_raiser() {
  [[ "${HEADED:-}" == "1" ]] || return 0
  [[ -n "${DISPLAY:-}" ]] || return 0
  command -v xdotool >/dev/null 2>&1 || return 0
  info "Headed mode: the Playwright window will be raised into view automatically."
  (
    raised=""
    for _ in $(seq 1 1800); do
      for wid in $(xdotool search --onlyvisible --name "Google Chrome for Testing" 2>/dev/null || true); do
        case " $raised " in *" $wid "*) continue ;; esac
        if xdotool windowactivate --sync "$wid" 2>/dev/null; then
          xdotool windowraise "$wid" 2>/dev/null || true
          raised="$raised $wid"
        fi
      done
      sleep 1
    done
  ) &
  RAISE_PID=$!
}
start_window_raiser

# Build and start the P2P settlement engine (mem store, insecure PayPal, no
# chain check) so the wallet P2P UI can be driven end-to-end. Self-contained —
# the flow needs no L0/L1.
start_p2p_engine() {
  info "Building p2p engine..."
  for pkg in did p2p-protocol record-sig; do
    ( cd "$ROOT/packages/$pkg" && npm run build >/dev/null 2>&1 ) || fail "build $pkg failed"
  done
  # The engine runs from an esbuild bundle: bigtangle-ts ships extensionless
  # ESM + CJS-interop deps that plain `node dist/server.js` cannot load.
  ( cd "$ROOT/services/p2p-engine" && npm run build >/dev/null 2>&1 && npm run bundle >/dev/null 2>&1 ) || fail "build/bundle p2p-engine failed"

  info "Starting p2p engine on $P2P_ENGINE_URL ..."
  PORT="$P2P_PORT" HOST=127.0.0.1 \
    SETTLEMENT_STORE=mem \
    SETTLEMENT_PAYPAL_INSECURE=1 \
    SETTLEMENT_ADMIN_TOKEN=adm \
    CORS_ORIGIN="http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}" \
    node "$ROOT/services/p2p-engine/dist/server.bundle.mjs" >/tmp/p2p-engine.log 2>&1 &
  P2P_PID=$!
  for i in $(seq 1 30); do
    curl -sf "http://localhost:${P2P_PORT}/healthz" >/dev/null 2>&1 && break
    sleep 0.5
  done
  curl -sf "http://localhost:${P2P_PORT}/healthz" >/dev/null 2>&1 || fail "p2p engine not ready (see /tmp/p2p-engine.log)"
  log "P2P engine ready."
}

# The P2P UI flow (p2p-ui) is self-contained: it never touches L0/L1, so the
# infra gate is skipped for it.
if [[ "$CMD" != "p2p-ui" ]]; then
  info "Checking infrastructure..."
  curl -sf "http://localhost:${SERVER_PORT}/" >/dev/null 2>&1 || fail "Infra not ready — run ./e2e/infra.sh first"
  log "Infrastructure ready."
fi

# 1. Build web app. The P2P engine URL is inlined by `expo export`, so rebuild
#    whenever it changes (a stale build would point the app at the wrong port).
export EXPO_PUBLIC_P2P_ENGINE_URL="$P2P_ENGINE_URL"
NEED_BUILD=0
[[ -d "$WEB_BUILD" ]] || NEED_BUILD=1
if [[ -d "$WEB_BUILD" && "$(cat "$WEB_BUILD/.p2p-url" 2>/dev/null)" != "$P2P_ENGINE_URL" ]]; then NEED_BUILD=1; fi
if [[ "$NEED_BUILD" == "1" ]]; then
  info "Building web app (P2P engine: $P2P_ENGINE_URL)..."
  cd "$ROOT/expo-app"
  npm run web:build 2>&1 | tail -3
  echo "$P2P_ENGINE_URL" > "$WEB_BUILD/.p2p-url"
  log "Web app built."
else
  info "Web build already exists, skipping build."
fi

# 3. Start web server (use the workspace binary directly — plain `npx` can
# stall on registry resolution and the old fixed 2s sleep raced the bind).
info "Starting web server..."
"$ROOT/node_modules/.bin/http-server" "$WEB_BUILD" -p "$WEB_PORT" --silent &
HTTP_PID=$!
for i in $(seq 1 15); do
  if curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 || fail "Web server not ready"
log "Web server on http://localhost:$WEB_PORT"

# Start the P2P engine for the parts that drive the wallet P2P UI.
if [[ "$CMD" == "all" || "$CMD" == "tests" || "$CMD" == "remaining" || "$CMD" == "p2p-ui" ]]; then
  start_p2p_engine
fi

# 4. Run Playwright payment test
if [[ "$CMD" == "all" || "$CMD" == "payment" || "$CMD" == "tests" ]]; then
info "Running payment transaction test..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list --grep "Payment" 2>&1
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
  "$ROOT/node_modules/.bin/playwright" test --reporter=list --grep "Tracking" 2>&1
log "Tracking tests passed."
fi

# 4b2. Run the order/market-data tests (same base/env as the payment
#      tests: web app on WEB_PORT, L0 on SERVER_PORT, L1 order server on
#      L1_PORT). Standalone only — `all` covers them via the remaining greps.
if [[ "$CMD" == "order" ]]; then
info "Running order e2e tests..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list order.spec.ts 2>&1
log "Order e2e tests passed."
fi

# 4b3. Run the token tests (browse / search / SDK token creation).
if [[ "$CMD" == "token" ]]; then
info "Running token e2e tests..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list tokens.spec.ts 2>&1
log "Token e2e tests passed."
fi

# 4b4. Run the block-explorer tests (latest blocks / hash search / dump details).
if [[ "$CMD" == "blocks" ]]; then
info "Running block explorer e2e tests..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list blocks.spec.ts 2>&1
log "Block explorer e2e tests passed."
fi

# 4b5. Run the p2p settlement wallet legs (escrow lock + release) standalone.
#      `all` covers the spec via the remaining greps.
if [[ "$CMD" == "p2p" ]]; then
info "Running p2p settlement legs..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list --grep "P2P Settlement" 2>&1
log "P2P settlement legs passed."

# Re-check both legs via the L0 getTransactionStatus API.
verify_p2p_legs
fi

# 4b6. Run the wallet P2P UI flow (order book / match / lock / pay) against the
#      engine started above. Self-contained (no L0/L1), so `p2p-ui` needs no
#      infra. `all`/`remaining` cover it via the remaining greps.
if [[ "$CMD" == "p2p-ui" ]]; then
info "Running P2P UI flow..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_P2P_ENGINE_URL="$P2P_ENGINE_URL" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list --grep "P2P Page|P2P Flow" 2>&1
log "P2P UI flow passed."
fi

# 4c. Run remaining specs (tokens, settings, order, wallet-flow, L1 Test Tab,
#     desktop, demo-flow) not covered by the Payment/Tracking greps.
if [[ "$CMD" == "all" || "$CMD" == "remaining" || "$CMD" == "tests" ]]; then
info "Running remaining e2e specs..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
E2E_P2P_ENGINE_URL="$P2P_ENGINE_URL" \
  "$ROOT/node_modules/.bin/playwright" test --reporter=list --grep-invert "Payment|Tracking" 2>&1
log "Remaining e2e specs passed."
fi

# 5. Capture payment flow screenshots and generate payment-flow.pdf. Runs for
#    the payment (or all/tests) part — part of the default e2etest output.
#    Set NO_PDF=1 to skip.
if [[ -z "${NO_PDF:-}" ]] && [[ "$CMD" == "all" || "$CMD" == "tests" || "$CMD" == "payment" ]]; then
info "Capturing payment flow screenshots and generating PDF..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  node capture-payment.mjs 2>&1
log "PDF generated: demo-output/pdfs/payment-flow.pdf"
fi

# 5b. Capture order-flow screenshots (Order market list, buy/sell sheet,
#     Spot chart) and generate order-flow.pdf. Creates a real matched trade on the
#     L1 order chain so the screenshots show real market/chart data.
if [[ -z "${NO_PDF:-}" ]] && [[ "$CMD" == "all" || "$CMD" == "tests" || "$CMD" == "order" ]]; then
info "Capturing order flow screenshots and generating PDF..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  node capture-order.mjs 2>&1
log "PDF generated: demo-output/pdfs/order-flow.pdf"
fi

# 5c. Capture token-flow screenshots (browse / search / create form / created
#     token) and generate token-flow.pdf. Creates a real confirmed token on L0
#     so the browse list and search show real data.
if [[ -z "${NO_PDF:-}" ]] && [[ "$CMD" == "all" || "$CMD" == "tests" || "$CMD" == "token" ]]; then
info "Capturing token flow screenshots and generating PDF..."
cd "$E2E_DIR"
APP_URL="http://localhost:${WEB_PORT}/" \
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  node capture-token.mjs 2>&1
log "PDF generated: demo-output/pdfs/token-flow.pdf"
fi
