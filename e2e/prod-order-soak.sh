#!/usr/bin/env bash
# prod-order-soak.sh — long-running RemoteOrderIT loop against the DEPLOYED
# prod L1-order node (buy + matching sell), with Nvidia/USDT as the default
# market. This is the WRITE/load companion to e2e/prod-soak.mjs (read soak).
#
#   ./e2e/prod-order-soak.sh                         # 1h, one Nvidia/USDT pair/min
#   ORDER_SOAK_SECONDS=14400 ORDER_SOAK_INTERVAL_SEC=120 \
#     ./e2e/prod-order-soak.sh                       # 4h, one pair/2min
#   DRY_RUN=1 ./e2e/prod-order-soak.sh               # print the Java command
#
# It delegates to ../blockchain/helper/prod/testorder.sh → prodtest.sh →
# RemoteOrderIT#testCnyBasedTradePairs:
#   - mints/reuses the fixed quote (USDT) and pair (Nvidia) tokens on L1-order,
#   - funds the fixed seller/buyer wallets with L1 BC,
#   - places one sell and one matching buy, then asserts both balances moved.
#
# WARNING: this writes to the target chain (token issuance, BC funding, orders).
# The quote token id is fixed (seed 0x05); if that id already exists as CNY,
# ORDER_TOKEN_NAME=USDT reuses it without renaming. Verify the first log line
# says it minted USDT, or use a freshly reset L1-order chain.
#
# All RemoteOrderIT knobs pass through: ORDER_COUNT, ORDER_PRICE,
# ORDER_STAGGER_MS, ORDER_BINANCE_LIVE, REQUIRE_BINANCE, ORDER_PRICE_NVIDIA,
# EXTRA_ARGS, PROD_URL, PROD_L1_URL, NET_PARAMS, MAX_FAILS, LOG_DIR.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$ROOT/../blockchain/helper/prod/testorder.sh"
[[ -x "$HELPER" ]] || { echo "ERROR: $HELPER not found (wallet repo must sit next to ../blockchain)" >&2; exit 1; }

ORDER_SOAK_SECONDS="${ORDER_SOAK_SECONDS:-3600}"
ORDER_SOAK_INTERVAL_SEC="${ORDER_SOAK_INTERVAL_SEC:-60}"
[[ "$ORDER_SOAK_INTERVAL_SEC" =~ ^[0-9]+$ && "$ORDER_SOAK_INTERVAL_SEC" -gt 0 ]] \
  || { echo "ERROR: ORDER_SOAK_INTERVAL_SEC must be a positive integer" >&2; exit 2; }
ORDER_SOAK_ITERS="${ORDER_SOAK_ITERS:-$(( (ORDER_SOAK_SECONDS + ORDER_SOAK_INTERVAL_SEC - 1) / ORDER_SOAK_INTERVAL_SEC ))}"
TARGET="${1:-testCnyBasedTradePairs}"

export ORDER_TOKEN_NAME="${ORDER_TOKEN_NAME:-USDT}"
export ORDER_QUOTE_SEED="${ORDER_QUOTE_SEED:-12}"
export ORDER_PAIR_TOKENS="${ORDER_PAIR_TOKENS:-Nvidia}"
export ORDER_COUNT="${ORDER_COUNT:-1}"
export PAUSE_SEC="${ORDER_SOAK_INTERVAL_SEC}"
export LOOP_ITERS="$ORDER_SOAK_ITERS"
export MAX_FAILS="${MAX_FAILS:-3}"
export LOG_DIR="${LOG_DIR:-$ROOT/e2e/test-results/order-soak-$(date +%Y%m%d-%H%M%S)}"
export PROD_URL="${PROD_URL:-https://eu1.bigtangle.org/}"
export PROD_L1_URL="${PROD_L1_URL:-https://ordereu1.bigtangle.org/}"

echo "=== prod order soak: $TARGET ==="
echo "duration:    ~${ORDER_SOAK_SECONDS}s (${ORDER_SOAK_ITERS} iterations, ${ORDER_SOAK_INTERVAL_SEC}s apart)"
echo "quote/pair:  $ORDER_TOKEN_NAME (seed $ORDER_QUOTE_SEED) / $ORDER_PAIR_TOKENS"
echo "L0 / L1:     $PROD_URL / $PROD_L1_URL"
echo "logs:        $LOG_DIR"
echo ""

exec "$HELPER" "$TARGET"
