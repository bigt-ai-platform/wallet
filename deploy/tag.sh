#!/bin/bash
# deploy/tag.sh — build the wallet web image on the HOST and publish it.
#
# The prod bundle is a static expo export. Building it needs the node toolchain
# (node + yarn + the workspace deps), which only lives on a dev/CI host — never
# on the region VMs. This script:
#
#   1. runs `expo export` for web into <repo-root>/web-build (host compile),
#   2. bakes it into an nginx image via deploy/Dockerfile.app,
#   3. either pushes to a registry image ($APP_IMAGE) or saves a docker tar that
#      deploy/region.sh loads onto the VM (no registry needed).
#
#   ./deploy/tag.sh                  # build wallet-web:latest, save to deploy/.image/
#   ./deploy/tag.sh 1.2.0            # also tag wallet-web:v1.2.0
#   APP_IMAGE=ghcr.io/you/wallet-web:latest ./deploy/tag.sh   # push to registry
#
# The release train is MAINNET only: before the export, deploy/network.sh
# (assert_mainnet_default) verifies expo-app/sources still pins the mainnet
# defaults and aborts otherwise, so a testnet-flipped tree can never be baked
# into the image.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
cd "$ROOT"

# shellcheck disable=SC1091
source "$SCRIPT_DIR/network.sh"

VERSION="${1:-}"
# Bake the release version into the web bundle (shown in Settings/About).
export EXPO_PUBLIC_APP_VERSION="${VERSION:-$(node -p "require('./expo-app/package.json').version" 2>/dev/null || echo 0.0.0)}"
# The P2P engine is same-origin behind this vhost's /p2p/* proxy (region.sh), so
# the bundle bakes the RELATIVE path — same model as /l0, /l1. p2pConfigured()
# only checks non-empty (services/p2p.ts); the SPA route /p2p is served by
# nginx while /p2p/<api> goes to the engine. e2e overrides this with its local
# engine URL (e2e/e2etest.sh), so the export there is unaffected.
export EXPO_PUBLIC_P2P_ENGINE_URL="${P2P_ENGINE_URL:-/p2p}"
IMAGE_BASE="${IMAGE_BASE:-wallet-web}"
APP_IMAGE="${APP_IMAGE:-}"
TAR_DIR="${SCRIPT_DIR}/.image"
TAR="${TAR_DIR}/wallet-web.latest.tar"

[ -f package.json ] || { echo -e "${RED}run from the wallet repo root${NC}"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then echo -e "${RED}docker not found${NC}"; exit 1; fi

# 1. Host web export (Metro). expo-app/node_modules must be present; bootstrap
#    the workspace once if it is missing.
if [ ! -d expo-app/node_modules ]; then
  echo -e "${YELLOW}expo-app/node_modules missing — running yarn install (workspace)…${NC}"
  yarn install --frozen-lockfile
fi

echo -e "${GREEN}--- network guard: pin mainnet defaults ---${NC}"
assert_mainnet_default

# The app imports the `chain-discovery` workspace package, whose runtime entry
# is its compiled dist/ (gitignored, like bigtangle-ts). Build it here so the
# Metro export below resolves it.
echo -e "${GREEN}--- build chain-discovery ---${NC}"
( cd packages/chain-discovery && yarn build )

echo -e "${GREEN}--- expo web export (host) ---${NC}"
rm -rf web-build
(
  cd expo-app
  # --clear: EXPO_PUBLIC_APP_VERSION is inlined by the babel transform, but
  # Metro's cache key ignores env values, so without it the bundle keeps the
  # APP_VERSION baked the first time (Settings/About showed 1.0.37 forever).
  npx expo export --platform web --output-dir ../web-build --clear
)
[ -f web-build/index.html ] || { echo -e "${RED}web-build/index.html missing — export failed${NC}"; exit 1; }

# 2. Image
TAGS=(-t "${IMAGE_BASE}:latest")
[ -n "$VERSION" ] && TAGS+=(-t "${IMAGE_BASE}:v${VERSION}")
echo -e "${GREEN}--- docker build ${IMAGE_BASE}:latest ---${NC}"
docker build -f deploy/Dockerfile.app "${TAGS[@]}" .

# 2b. P2P settlement engine image (the /p2p/* upstream). Host-built like the
#     web image; published the same way — registry push when P2P_IMAGE is set,
#     docker-save tar otherwise (deploy/region.sh p2p loads it onto the VM).
echo -e "${GREEN}--- docker build wallet-p2p-engine:latest ---${NC}"
docker build -f deploy/Dockerfile.p2p-engine -t wallet-p2p-engine:latest .
if [ -n "${P2P_IMAGE:-}" ]; then
  docker tag wallet-p2p-engine:latest "$P2P_IMAGE"
  docker push "$P2P_IMAGE"
  [ -n "$VERSION" ] && { docker tag wallet-p2p-engine:latest "${P2P_IMAGE%:*}:v${VERSION}"; docker push "${P2P_IMAGE%:*}:v${VERSION}"; } || true
else
  mkdir -p "$TAR_DIR"
  echo -e "${GREEN}--- docker save wallet-p2p-engine → $TAR_DIR (no registry) ---${NC}"
  docker save wallet-p2p-engine:latest -o "$TAR_DIR/wallet-p2p-engine.latest.tar"
fi

# 3. Publish: registry push or docker-save tar
if [ -n "$APP_IMAGE" ]; then
  echo -e "${GREEN}--- docker push $APP_IMAGE ---${NC}"
  docker tag "${IMAGE_BASE}:latest" "$APP_IMAGE"
  docker push "$APP_IMAGE"
  [ -n "$VERSION" ] && { docker tag "${IMAGE_BASE}:v${VERSION}" "${APP_IMAGE%:*}:v${VERSION}" 2>/dev/null || true; }
else
  mkdir -p "$TAR_DIR"
  echo -e "${GREEN}--- docker save → $TAR (no registry) ---${NC}"
  docker save "${IMAGE_BASE}:latest" -o "$TAR"
  du -h "$TAR"
fi

echo -e "${GREEN}=== done. Deploy with: ./deploy/region.sh deploy prod ===${NC}"
