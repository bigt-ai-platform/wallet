#!/usr/bin/env bash
# e2e/eth-integration.sh — real-EVM integration test for the Ethereum signer.
#
# Starts anvil (foundry, docker) on a loopback port, runs the vitest integration
# suite against it and stops the node. No chain, provider key or funds needed.
#
#   ./e2e/eth-integration.sh            # docker anvil on 18545
#   ETH_RPC=http://127.0.0.1:8545 ./e2e/eth-integration.sh   # reuse a node
#
# The test funds itself with anvil_setBalance, so the host must not be a
# public network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${ETH_PORT:-18545}"
NAME="wallet-eth-integration"
IMAGE="${FOUNDRY_IMAGE:-ghcr.io/foundry-rs/foundry:latest}"
RPC="${ETH_RPC:-http://127.0.0.1:$PORT}"

started=0
cleanup() {
  if [ "$started" = 1 ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "anvil stopped"
  fi
}
trap cleanup EXIT

if [ -z "${ETH_RPC:-}" ]; then
  command -v docker >/dev/null || { echo "docker is required to start anvil (or set ETH_RPC)" >&2; exit 1; }
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  echo "starting anvil ($IMAGE) on :$PORT"
  # `--entrypoint anvil`: the image's entrypoint is `/bin/sh -c`, and passing
  # `anvil` as an argument makes it ignore --host (it then listens on
  # 127.0.0.1 inside the container only).
  docker run -d --rm --name "$NAME" --entrypoint anvil -p "$PORT:8545" "$IMAGE" \
    --host 0.0.0.0 --port 8545 >/dev/null
  started=1
fi

echo "waiting for $RPC"
for _ in $(seq 1 60); do
  if curl -sf -m 2 -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -sf -m 2 -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null \
  || { echo "anvil did not come up on $RPC" >&2; exit 1; }

cd "$ROOT/expo-app"
ETH_INTEGRATION_RPC="$RPC" npx vitest run sources/lib/eth/__tests__/integration.test.ts "$@"
