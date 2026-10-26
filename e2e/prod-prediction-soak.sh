#!/usr/bin/env bash
# prod-prediction-soak.sh — long-run simulation against the DEPLOYED prediction
# chain (L1-prediction: predicteu1/2, predicthk1). This is the WRITE/load
# companion to e2e/prod-soak.mjs, for the prediction chain the read soak does
# not touch.
#
# Each iteration runs the remote suite RemotePredictionIT against the live node
# (one `mvn test` per iteration ⇒ one log per iteration):
#   testCreateSplitMergeLifecycle   YES+NO mint → contract → create → split → merge
#   testStakedMarketCreateSplit     staked-optimistic market create → split
#   testMultiOutcomeCreateSplitMerge 3-outcome contract create → split → merge
# Every test mints a FRESH market (random token ids), so a run accumulates real
# markets, exercises the contract-event mempool path, the engine execution and
# the coinbase payout on the deployed chain — the long-run "does the prediction
# chain still work under write load" simulation.
#
# On top of the assertions inside the suite it checks, per iteration:
#   - the chain head advanced by >= PREDICTION_MIN_CHAIN_ADVANCE blocks
#     (a soaking chain that stops producing is a failure, not a slow run), and
#   - searchContractTokens grew by >= PREDICTION_MIN_NEW_MARKETS markets (the
#     read endpoint the wallet Predict page uses, so the markets are visible
#     where users look — not just accepted by the mempool).
#
#   ./e2e/prod-prediction-soak.sh                     # 10 iterations (~30 min)
#   ./e2e/prod-prediction-soak.sh 5                   # 5 iterations
#   PREDICTION_SOAK_SECONDS=14400 ./e2e/prod-prediction-soak.sh   # 4h budget
#   PREDICTION_TESTS=net.bigtangle.server.remote.RemotePredictionIT#testCreateSplitMergeLifecycle \
#     ./e2e/prod-prediction-soak.sh                   # one scenario only
#   DRY_RUN=1 ./e2e/prod-prediction-soak.sh           # plan + read-only preflight
#
# Funding gate: every prediction write pays BIG fees (FEE_DEFAULT) and a split
# locks SPLIT_AMOUNT collateral, and the chain mints no BIG at genesis — funds
# arrive ONLY as a bridge peg-in from L0. The suite's wallet is the shared test
# key (ML-DSA seed 0x01). When it has no BIG on the prediction chain the run
# aborts with the exact funding command; pass PREDICTION_FUND=1 to run that
# peg-in automatically (default 1 BIG, locked in the L0 vault like every
# peg-in — see e2e/prod-bridge-smoke.sh).
#
# Env:
#   PREDICTION_URL            prediction API   (default https://predicteu1.bigtangle.org/)
#   PROD_URL                  L0 API           (default https://eu1.bigtangle.org/)
#   PROD_L1_URL               L1-order API     (default https://ordereu1.bigtangle.org/)
#   NET_PARAMS                default main
#   PREDICTION_TESTS          test class/method(s) (default the whole IT)
#   PREDICTION_SOAK_ITERS     iterations (default 10; positional arg wins)
#   PREDICTION_SOAK_SECONDS   optional wall-clock budget (default 0 = none)
#   PREDICTION_MIN_CHAIN_ADVANCE  blocks per iteration (default 1, 0 = off)
#   PREDICTION_MIN_NEW_MARKETS    markets per iteration (default 1, 0 = off)
#   PREDICTION_PREFLIGHT_SEC  chain-advance probe window (default 15)
#   PREDICTION_FUND           1 = peg-in automatically when the wallet is dry
#   PREDICTION_FUND_WAIT_SEC  wait for the minted BIG to be spendable (default 900)
#   PREDICTION_FUND_BIG       peg-in amount in BIG (default 1)
#   PREDICTION_FUND_SEED      beneficiary seed hex (default the test wallet 01…01)
#   MAX_FAILS                 abort after N failed iterations (default 2)
#   LOG_DIR                   per-iteration logs (default e2e/test-results/…)
#   DRY_RUN                   1 = print the plan + preflight, run nothing
#
# Exit: 0 only when every iteration passed and the chain advanced.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRODTEST="$ROOT/../blockchain/helper/prod/prodtest.sh"
BRIDGE="$ROOT/e2e/prod-bridge-smoke.sh"
[[ -x "$PRODTEST" ]] || { echo "ERROR: $PRODTEST not found (the wallet repo must sit next to ../blockchain)" >&2; exit 1; }
[[ -x "$BRIDGE" ]] || { echo "ERROR: $BRIDGE not found" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 required" >&2; exit 1; }

PREDICTION_URL="${PREDICTION_URL:-https://predicteu1.bigtangle.org/}"
PROD_URL="${PROD_URL:-https://eu1.bigtangle.org/}"
PROD_L1_URL="${PROD_L1_URL:-https://ordereu1.bigtangle.org/}"
NET_PARAMS="${NET_PARAMS:-main}"
PREDICTION_TESTS="${PREDICTION_TESTS:-net.bigtangle.server.remote.RemotePredictionIT}"
PREDICTION_SOAK_ITERS="${PREDICTION_SOAK_ITERS:-10}"
PREDICTION_SOAK_SECONDS="${PREDICTION_SOAK_SECONDS:-0}"
PREDICTION_MIN_CHAIN_ADVANCE="${PREDICTION_MIN_CHAIN_ADVANCE:-1}"
PREDICTION_MIN_NEW_MARKETS="${PREDICTION_MIN_NEW_MARKETS:-1}"
PREDICTION_PREFLIGHT_SEC="${PREDICTION_PREFLIGHT_SEC:-15}"
PREDICTION_FUND="${PREDICTION_FUND:-0}"
PREDICTION_FUND_BIG="${PREDICTION_FUND_BIG:-1}"
PREDICTION_FUND_WAIT_SEC="${PREDICTION_FUND_WAIT_SEC:-900}"
PREDICTION_FUND_SEED="${PREDICTION_FUND_SEED:-$(printf '01%.0s' {1..32})}"
MAX_FAILS="${MAX_FAILS:-2}"
LOG_DIR="${LOG_DIR:-$ROOT/e2e/test-results/prediction-soak-$(date +%Y%m%d-%H%M%S)}"
DRY_RUN="${DRY_RUN:-0}"
PREFLIGHT_LEN=0

[[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]] && PREDICTION_SOAK_ITERS="$1" && shift
[[ $# -gt 0 ]] && PREDICTION_TESTS="$1" && shift
[[ "$PREDICTION_SOAK_ITERS" =~ ^[0-9]+$ ]] && [ "$PREDICTION_SOAK_ITERS" -gt 0 ] \
    || { echo "ERROR: PREDICTION_SOAK_ITERS must be a positive integer" >&2; exit 2; }

PREDICTION_BASE="${PREDICTION_URL%/}"
pred_post() { # $1=cmd $2=json body
    curl -fsS -m 20 -X POST -H 'Content-Type: application/json' -d "${2:-{\}}" "$PREDICTION_BASE/$1"
}
# "chainLength justifiedEpoch finalizedEpoch" of the live prediction chain.
chain_state() {
    pred_post getChainNumber | python3 -c '
import json, sys
d = json.load(sys.stdin)
r = d.get("txReward") or {}
print(int(r.get("chainLength") or 0), int(d.get("justifiedEpoch") or 0), int(d.get("finalizedEpoch") or 0))
'
}
# Same, but never fails a run: falls back to the last known length.
chain_len() { # $1 = fallback length
    local state len
    if state="$(chain_state 2>/dev/null)"; then
        read -r len _ _ <<< "$state"
        printf '%s' "${len:-$1}"
    else
        printf '%s' "$1"
    fi
}
# Markets the wallet Predict page lists (contract-type tokens on the chain).
market_count() {
    pred_post searchContractTokens | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(len(d.get("tokens") or d.get("contractTokens") or []))
'
}

preflight() {
    echo "=== prod prediction soak ==="
    echo "prediction:  $PREDICTION_BASE"
    echo "L0 / L1:     $PROD_URL / $PROD_L1_URL"
    echo "tests:       $PREDICTION_TESTS"
    echo "iterations:  $PREDICTION_SOAK_ITERS${PREDICTION_SOAK_SECONDS:+ (budget ${PREDICTION_SOAK_SECONDS}s)}"
    echo "per-iter:    head +$PREDICTION_MIN_CHAIN_ADVANCE block(s), markets +$PREDICTION_MIN_NEW_MARKETS"
    echo "funding:     ${PREDICTION_FUND} (${PREDICTION_FUND_BIG} BIG via chainId prediction when dry)"
    echo "logs:        $LOG_DIR"
    echo ""
    local before after markets
    before="$(chain_state)" || { echo "ERROR: prediction chain unreachable at $PREDICTION_BASE" >&2; exit 1; }
    markets="$(market_count)" || markets="?"
    read -r len1 just1 fin1 <<< "$before"
    [ "$len1" -gt 0 ] || { echo "ERROR: prediction chain reports chainLength=$len1" >&2; exit 1; }
    echo "chain now:   length=$len1 justifiedEpoch=$just1 finalizedEpoch=$fin1 markets=$markets"
    if [ "$PREDICTION_PREFLIGHT_SEC" -gt 0 ]; then
        sleep "$PREDICTION_PREFLIGHT_SEC"
        after="$(chain_state)" || { echo "ERROR: prediction chain unreachable after ${PREDICTION_PREFLIGHT_SEC}s" >&2; exit 1; }
        read -r len2 just2 fin2 <<< "$after"
        echo "chain +${PREDICTION_PREFLIGHT_SEC}s: length=$len2 justifiedEpoch=$just2 finalizedEpoch=$fin2"
        [ "$len2" -gt "$len1" ] || {
            echo "ERROR: chain did not advance in ${PREDICTION_PREFLIGHT_SEC}s ($len1 -> $len2) — a write soak on a stalled chain proves nothing" >&2
            exit 1
        }
        [ "$fin2" -gt 0 ] || { echo "ERROR: chain has no finalized epoch (finality is not running)" >&2; exit 1; }
        PREFLIGHT_LEN="$len2"
    else
        PREFLIGHT_LEN="$len1"
    fi
    echo ""
}

# The suite needs BIG on the PREDICTION chain for token/contract fees and the
# split collateral; the chain mints none at genesis, so it can only come from
# an L0 vault peg-in. The peg-in finalises on L0 and is minted by the
# prediction node's PegInWatcher a few minutes later, so the smoke's own wait
# can return before the wrapped BIG is confirmed AND spendable — poll getOutputs
# (the endpoint the wallet's spend path uses) before handing over to the suite.
fund_prediction() {
    echo "--- funding the test wallet on prediction (peg-in ${PREDICTION_FUND_BIG} BIG) ---"
    BRIDGE_AMOUNT_BIG="$PREDICTION_FUND_BIG" \
    BRIDGE_CHAIN_ID=prediction \
    BRIDGE_BENEFICIARY_SEED="$PREDICTION_FUND_SEED" \
    PROD_URL="$PROD_URL" \
    PROD_L1_URL="$PREDICTION_URL" \
    NET_PARAMS="$NET_PARAMS" \
        "$BRIDGE" >"$LOG_DIR/funding.log" 2>&1 || {
            echo "FAIL: peg-in to prediction failed — log=$LOG_DIR/funding.log" >&2
            tail -n 20 "$LOG_DIR/funding.log" | sed 's/^/    | /' >&2
            return 1
        }
    local h160
    h160="$(sed -n 's/.*beneficiary pinned to the bridge\.beneficiarySeed key (\([0-9a-f]\{40\}\)).*/\1/p' \
        "$LOG_DIR/funding.log" | head -1)"
    if [ -z "$h160" ]; then
        echo "WARN: no pinned-beneficiary line in the funding log; relying on the smoke's own mint wait"
        return 0
    fi
    echo "waiting for a confirmed, spendable BIG output at $h160 (up to ${PREDICTION_FUND_WAIT_SEC}s)"
    local waited=0
    while [ "$waited" -lt "$PREDICTION_FUND_WAIT_SEC" ]; do
        if pred_post getOutputs "[\"$h160\"]" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for o in d.get("outputs") or []:
    v = o.get("value") or {}
    if (v.get("tokenHex") == "bc" or v.get("big")) and int(v.get("value") or 0) > 0 and not o.get("spent"):
        sys.exit(0)
sys.exit(1)
'; then
            echo "PASS: spendable BIG confirmed on prediction after ${waited}s"
            return 0
        fi
        sleep 10
        waited=$((waited + 10))
        [ $((waited % 60)) -eq 0 ] && echo "  … still waiting for the mint (${waited}s)"
    done
    echo "FAIL: no spendable BIG at $h160 after ${PREDICTION_FUND_WAIT_SEC}s — the peg-in is not finalized/minted yet." >&2
    echo "      A prediction node that never mints is missing the bridge config (BRIDGE_VAULT_PUBKEY," >&2
    echo "      BRIDGE_ISSUANCE_PUBKEY/PRIIKEY, ANCHOR_L0_URL) — see ../blockchain/helper/prod/prod-prediction.sh." >&2
    return 1
}

run_iteration() { # $1=log path
    PROD_URL="$PROD_URL" PROD_L1_URL="$PROD_L1_URL" NET_PARAMS="$NET_PARAMS" \
        EXTRA_ARGS="-Dl1p.url=$PREDICTION_URL" \
        "$PRODTEST" "$PREDICTION_TESTS" >"$1" 2>&1
}

unfunded() { # $1=log path → 0 when the suite could not pay a fee
    grep -q 'InsufficientMoney' "$1" 2>/dev/null
}

main() {
    preflight
    if [ "$DRY_RUN" = "1" ]; then
        echo "(dry run) per iteration:"
        echo "  PROD_URL=$PROD_URL PROD_L1_URL=$PROD_L1_URL NET_PARAMS=$NET_PARAMS \\"
        echo "    EXTRA_ARGS='-Dl1p.url=$PREDICTION_URL' $PRODTEST $PREDICTION_TESTS"
        [ "$PREDICTION_FUND" = "1" ] && echo "  (funding on demand: BRIDGE_CHAIN_ID=prediction BRIDGE_AMOUNT_BIG=$PREDICTION_FUND_BIG $BRIDGE)"
        echo "nothing executed"
        return 0
    fi

    mkdir -p "$LOG_DIR"
    local started=$SECONDS passed=0 failed=0 funded=0 i log rc before after markets_before markets_after
    local -a RESULTS=()

    for i in $(seq 1 "$PREDICTION_SOAK_ITERS"); do
        if [ "$PREDICTION_SOAK_SECONDS" -gt 0 ] && [ $(( SECONDS - started )) -ge "$PREDICTION_SOAK_SECONDS" ]; then
            echo "--- budget reached (${PREDICTION_SOAK_SECONDS}s) after $((i - 1)) iteration(s) ---"
            break
        fi
        log="$LOG_DIR/iter-$(printf '%02d' "$i").log"
        echo "--- iteration $i/$PREDICTION_SOAK_ITERS ---"
        before="$(chain_len "$PREFLIGHT_LEN")"
        markets_before="$(market_count 2>/dev/null)" || markets_before="${markets_before:-0}"

        start=$(date +%s)
        if run_iteration "$log"; then rc=0; else rc=$?; fi
        if [ "$rc" -ne 0 ] && unfunded "$log" && [ "$PREDICTION_FUND" = "1" ] && [ "$funded" = "0" ]; then
            echo "    test wallet has no BIG on prediction — funding via L0 peg-in"
            if fund_prediction; then funded=1; if run_iteration "$log"; then rc=0; else rc=$?; fi; fi
        fi
        dur=$(( $(date +%s) - start ))

        after="$(chain_len "$before")"
        markets_after="$(market_count 2>/dev/null)" || markets_after="$markets_before"
        local advanced=$(( after - before )) newmarkets=$(( markets_after - markets_before ))

        if [ "$rc" -eq 0 ] && [ "$advanced" -lt "$PREDICTION_MIN_CHAIN_ADVANCE" ]; then
            rc=1
            echo "FAIL  chain did not advance: length $before -> $after (< +$PREDICTION_MIN_CHAIN_ADVANCE)"
        fi
        if [ "$rc" -eq 0 ] && [ "$newmarkets" -lt "$PREDICTION_MIN_NEW_MARKETS" ]; then
            rc=1
            echo "FAIL  markets not visible on the chain: $markets_before -> $markets_after (< +$PREDICTION_MIN_NEW_MARKETS)"
        fi

        if [ "$rc" -eq 0 ]; then
            passed=$((passed + 1))
            RESULTS+=("PASS  iter $i  ${dur}s  head $before->$after  markets $markets_before->$markets_after")
            echo "PASS  iter $i  (${dur}s, head +$advanced, markets +$newmarkets)"
        else
            failed=$((failed + 1))
            RESULTS+=("FAIL  iter $i  ${dur}s  rc=$rc  head $before->$after  markets $markets_before->$markets_after  log=$log")
            echo "FAIL  iter $i  (${dur}s, rc=$rc)  log=$log"
            tail -n 25 "$log" | sed 's/^/    | /'
            if unfunded "$log"; then
                echo "    the suite could not pay a prediction-chain fee (no BIG on $PREDICTION_BASE)." >&2
                echo "    fund the shared test wallet once:" >&2
                echo "      BRIDGE_CHAIN_ID=prediction BRIDGE_AMOUNT_BIG=$PREDICTION_FUND_BIG \\" >&2
                echo "      BRIDGE_BENEFICIARY_SEED=$PREDICTION_FUND_SEED \\" >&2
                echo "      PROD_L1_URL=$PREDICTION_URL ./e2e/prod-bridge-smoke.sh" >&2
                echo "    (or re-run with PREDICTION_FUND=1 to do that automatically)" >&2
            fi
            if [ "$failed" -ge "$MAX_FAILS" ]; then
                echo "aborting: $failed failed iteration(s) (MAX_FAILS=$MAX_FAILS)"
                break
            fi
        fi
        echo ""
    done

    echo "=== Summary: $passed passed, $failed failed (of $((passed + failed)) run) ==="
    for line in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "  $line"; done
    echo "logs: $LOG_DIR"
    [ "$failed" -eq 0 ] && [ "$passed" -gt 0 ]
}

main
