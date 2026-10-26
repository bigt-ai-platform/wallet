#!/usr/bin/env bash
# prod-maker.sh — leave a two-sided Nvidia/USDT order book open on prod.
#
# Unlike prod-order-soak/price-walk (which match their own sell+buy), this
# places a resting sell above and a resting buy below the current price and
# leaves both in the book, so Home/Spot show an actual order book.
#
#   ./e2e/prod-maker.sh
#   MAKER_PRICE=220 MAKER_SPREAD=4 MAKER_AMOUNT=25 ./e2e/prod-maker.sh
#   DRY_RUN=1 ./e2e/prod-maker.sh
#
# It uses the fixed test issuer keys (quote seed 12, Nvidia pair seed 0x06) and
# the same funding/supply logic as RemoteOrderIT. This is a WRITE test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$ROOT/../blockchain/helper/prod/testorder.sh"
[[ -x "$HELPER" ]] || { echo "ERROR: $HELPER not found" >&2; exit 1; }

MAKER_PRICE="${MAKER_PRICE:-220}"
MAKER_SPREAD="${MAKER_SPREAD:-2}"
MAKER_AMOUNT="${MAKER_AMOUNT:-10}"

ARGS="-Dorder.maker=true -Dorder.makerPrice=$MAKER_PRICE -Dorder.makerSpread=$MAKER_SPREAD -Dorder.makerAmount=$MAKER_AMOUNT"

echo "=== prod maker book: Nvidia/USDT ==="
echo "sell:   $MAKER_AMOUNT Nvidia @ $MAKER_PRICE USDT"
echo "buy:    $MAKER_AMOUNT Nvidia @ $(python3 -c "print(max(0.01, $MAKER_PRICE - $MAKER_SPREAD))") USDT"
echo "extra:  $ARGS"
echo ""

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "(dry run) ORDER_TOKEN_NAME=USDT ORDER_QUOTE_SEED=12 ORDER_PAIR_TOKENS=Nvidia LOOP_ITERS=1 EXTRA_ARGS='$ARGS' $HELPER net.bigtangle.server.remote.RemoteOrderIT#testMakerOrders"
  exit 0
fi

exec env \
  ORDER_TOKEN_NAME=USDT \
  ORDER_QUOTE_SEED=12 \
  ORDER_PAIR_TOKENS=Nvidia \
  LOOP_ITERS=1 \
  PAUSE_SEC=0 \
  MAX_FAILS=1 \
  EXTRA_ARGS="$ARGS" \
  PROD_URL="${PROD_URL:-https://eu1.bigtangle.org/}" \
  PROD_L1_URL="${PROD_L1_URL:-https://ordereu1.bigtangle.org/}" \
  NET_PARAMS="${NET_PARAMS:-main}" \
  "$HELPER" net.bigtangle.server.remote.RemoteOrderIT#testMakerOrders
