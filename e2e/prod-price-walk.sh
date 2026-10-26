#!/usr/bin/env bash
# prod-price-walk.sh — drive the Nvidia/USDT order market through a price
# walk, one matched sell+buy per step. This is the long-running companion that
# makes the wallet's Home/Spot last price, 24h high/low and chart actually move.
#
#   ./e2e/prod-price-walk.sh
#   ORDER_PRICE_WALK=205,210,215,220,215,210 PRICE_WALK_PAUSE_SEC=10 \
#     ./e2e/prod-price-walk.sh
#   PRICE_WALK_ROUNDS=4 ./e2e/prod-price-walk.sh       # repeat the walk 4x
#   DRY_RUN=1 ./e2e/prod-price-walk.sh
#
# Each step invokes e2e/prod-order-soak.sh with ORDER_PRICE_NVIDIA=<step>, so it
# mints/funds/places one sell and one matching buy at that price and asserts
# both balances. All RemoteOrderIT knobs still pass through.
#
# Writes to prod: token issuance only on the first step, then BC funding and
# orders. Use a price range the fixed seller's supply can cover.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOAK="$ROOT/e2e/prod-order-soak.sh"
[[ -x "$SOAK" ]] || { echo "ERROR: $SOAK not found" >&2; exit 1; }

ORDER_PRICE_WALK="${ORDER_PRICE_WALK:-205,210,215,220,215,210}"
PRICE_WALK_ROUNDS="${PRICE_WALK_ROUNDS:-1}"
PRICE_WALK_PAUSE_SEC="${PRICE_WALK_PAUSE_SEC:-20}"
LOG_DIR="${PRICE_WALK_LOG_DIR:-$ROOT/e2e/test-results/price-walk-$(date +%Y%m%d-%H%M%S)}"

IFS=',' read -r -a PRICES <<< "$ORDER_PRICE_WALK"
[[ "${#PRICES[@]}" -gt 0 ]] || { echo "ERROR: empty ORDER_PRICE_WALK" >&2; exit 2; }

echo "=== prod Nvidia/USDT price walk ==="
echo "prices:  $ORDER_PRICE_WALK"
echo "rounds:  $PRICE_WALK_ROUNDS (pause ${PRICE_WALK_PAUSE_SEC}s)"
echo "logs:    $LOG_DIR"
echo ""

if [ "${DRY_RUN:-0}" = "1" ]; then
  n=0
  for _ in $(seq 1 "$PRICE_WALK_ROUNDS"); do
    for p in "${PRICES[@]}"; do
      n=$((n + 1))
      echo "  step $n: ORDER_PRICE_NVIDIA=$p"
    done
  done
  echo "(dry run) $n matched order(s); no write performed"
  exit 0
fi

mkdir -p "$LOG_DIR"
step=0
for round in $(seq 1 "$PRICE_WALK_ROUNDS"); do
  for p in "${PRICES[@]}"; do
    step=$((step + 1))
    log="$LOG_DIR/step-$(printf '%02d' "$step")-price-${p}.log"
    echo "--- step $step  Nvidia/USDT @ $p  (round $round)"
    start=$(date +%s)
    if ORDER_PRICE_NVIDIA="$p" \
       ORDER_SOAK_SECONDS=60 ORDER_SOAK_INTERVAL_SEC=60 \
       "$SOAK" >"$log" 2>&1; then
      dur=$(( $(date +%s) - start ))
      echo "    PASS  ${dur}s  $(grep -E 'Pair .* matched' "$log" | tail -1 || true)"
    else
      echo "    FAIL  log=$log"
      tail -n 20 "$log" | sed 's/^/    | /'
      exit 1
    fi
    if [ "$PRICE_WALK_PAUSE_SEC" -gt 0 ]; then sleep "$PRICE_WALK_PAUSE_SEC"; fi
  done
done
echo ""
echo "=== price walk done: $step matched step(s) ==="
echo "Home/Spot now show the new last price and recent trades. Logs: $LOG_DIR"
