#!/usr/bin/env bash
# prod-soak.sh — convenience wrapper for e2e/prod-soak.mjs.
#
#   ./e2e/prod-soak.sh --duration 30                 # smoke (read-only, P2P)
#   ./e2e/prod-soak.sh --duration 3600 --target all  # one-hour soak
#   ./e2e/prod-soak.sh --duration 0 --target all     # run until Ctrl-C
#
# See e2e/prod-soak.mjs for every knob (concurrency, thresholds, --write,
# Nvidia/USDT market discovery, JSONL samples, ...).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/e2e/prod-soak.mjs" "$@"
