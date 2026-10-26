#!/usr/bin/env bash
# prod-bridge-smoke.sh — REAL L0 -> L1 peg-in against the deployed prod stack.
#
# Locks a small BIG UTXO in the L0 bridge vault for chainId ordermatch, submits
# `processPegIn`, and waits for the L1-order node's PegInWatcher to mint the
# wrapped amount to the same beneficiary. This is an OPT-IN WRITE test: the
# amount stays locked in the vault (no peg-out).
#
#   ./e2e/prod-bridge-smoke.sh
#   BRIDGE_AMOUNT_BIG=0.05 BRIDGE_CHAIN_ID=ordermatch ./e2e/prod-bridge-smoke.sh
#   DRY_RUN=1 ./e2e/prod-bridge-smoke.sh       # print the command only
#
#   # fund the SHARED test wallet (ML-DSA seed 0x01) on another chain instead of
#   # a throwaway key — the prerequisite for a Remote*IT run there:
#   BRIDGE_CHAIN_ID=prediction BRIDGE_AMOUNT_BIG=1 \
#     BRIDGE_BENEFICIARY_SEED=0101…01 PROD_L1_URL=https://predicteu1.bigtangle.org/ \
#     ./e2e/prod-bridge-smoke.sh
#
# Prerequisites (one-time):
#   - L0 test wallet funded:
#       FUND_L0=1 FUND_L1=0 FUND_UTXOS=8 \
#         bash ../blockchain/helper/prod/fund-test-wallets.sh
#   - the target L1 node runs the PegInWatcher with the matching bridge
#     issuance key and ANCHOR_L0_URL (prod-order.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$ROOT/../blockchain/helper/prod/prodtest.sh"
[[ -x "$HELPER" ]] || { echo "ERROR: $HELPER not found (wallet repo must sit next to ../blockchain)" >&2; exit 1; }

BRIDGE_AMOUNT_BIG="${BRIDGE_AMOUNT_BIG:-0.1}"
BRIDGE_CHAIN_ID="${BRIDGE_CHAIN_ID:-ordermatch}"
# Optional: pin the beneficiary to a seed (32-byte ML-DSA seed hex) instead of a
# throwaway key, e.g. the shared test wallet 0101…01 — then a Remote*IT on that
# chain has BIG. Default empty = throwaway key (plain mint-path smoke).
BRIDGE_BENEFICIARY_SEED="${BRIDGE_BENEFICIARY_SEED:-}"
PROD_URL="${PROD_URL:-https://eu1.bigtangle.org/}"
PROD_L1_URL="${PROD_L1_URL:-https://ordereu1.bigtangle.org/}"
NET_PARAMS="${NET_PARAMS:-main}"

# 1 BIG = 10^6 sat on this network.
AMOUNT_SAT="$(python3 -c "print(int(float('$BRIDGE_AMOUNT_BIG') * 10**6))")"
EXTRA_ARGS="-Dbridge.prod=true -Dbridge.amountSat=$AMOUNT_SAT -Dbridge.chainId=$BRIDGE_CHAIN_ID"
[ -n "$BRIDGE_BENEFICIARY_SEED" ] && EXTRA_ARGS="$EXTRA_ARGS -Dbridge.beneficiarySeed=$BRIDGE_BENEFICIARY_SEED"

echo "=== prod bridge smoke (L0 -> L1) ==="
echo "L0:          $PROD_URL"
echo "L1:          $PROD_L1_URL"
echo "chainId:     $BRIDGE_CHAIN_ID"
echo "amount:      $BRIDGE_AMOUNT_BIG BIG ($AMOUNT_SAT sat)"
echo "beneficiary: ${BRIDGE_BENEFICIARY_SEED:+pinned to the BRIDGE_BENEFICIARY_SEED key}${BRIDGE_BENEFICIARY_SEED:-fresh throwaway key}"
echo "extra args:  $EXTRA_ARGS"
echo ""

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "(dry run) PROD_URL=$PROD_URL PROD_L1_URL=$PROD_L1_URL NET_PARAMS=$NET_PARAMS EXTRA_ARGS='$EXTRA_ARGS' $HELPER net.bigtangle.server.remote.RemoteBridgeIT"
  exit 0
fi

exec env PROD_URL="$PROD_URL" PROD_L1_URL="$PROD_L1_URL" NET_PARAMS="$NET_PARAMS" \
  EXTRA_ARGS="$EXTRA_ARGS" "$HELPER" net.bigtangle.server.remote.RemoteBridgeIT
