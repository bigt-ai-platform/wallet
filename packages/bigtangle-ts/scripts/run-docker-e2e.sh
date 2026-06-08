#!/usr/bin/env bash
set -euo pipefail

compose_file="${DOCKER_E2E_COMPOSE_FILE:-test/docker-e2e/docker-compose-bigtangle.yml}"
keep_systems="${DOCKER_E2E_KEEP_SYSTEMS:-0}"

cleanup() {
  if [[ "$keep_systems" == "0" ]]; then
    docker compose -f "$compose_file" down
  fi
}

npm run build
rm -rf .tmp/docker-e2e
mkdir -p .tmp/docker-e2e
package_name="$(npm pack --pack-destination .tmp/docker-e2e | tail -n 1)"
export PACKAGE_TGZ=".tmp/docker-e2e/$package_name"

trap cleanup EXIT
docker compose -f "$compose_file" up --build --abort-on-container-exit --exit-code-from bigtangle-ts-e2e
