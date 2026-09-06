#!/bin/bash
# deploy/tag.sh — build the bapp web image on the HOST and publish it.
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
#   ./deploy/tag.sh                  # build bapp-web:latest, save to deploy/.image/
#   ./deploy/tag.sh 1.2.0            # also tag bapp-web:v1.2.0
#   APP_IMAGE=ghcr.io/you/bapp-web:latest ./deploy/tag.sh   # push to registry
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
IMAGE_BASE="${IMAGE_BASE:-bapp-web}"
APP_IMAGE="${APP_IMAGE:-}"
TAR_DIR="${SCRIPT_DIR}/.image"
TAR="${TAR_DIR}/bapp-web.latest.tar"

[ -f package.json ] || { echo -e "${RED}run from the bapp repo root${NC}"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then echo -e "${RED}docker not found${NC}"; exit 1; fi

# 1. Host web export (Metro). expo-app/node_modules must be present; bootstrap
#    the workspace once if it is missing.
if [ ! -d expo-app/node_modules ]; then
  echo -e "${YELLOW}expo-app/node_modules missing — running yarn install (workspace)…${NC}"
  yarn install --frozen-lockfile
fi

echo -e "${GREEN}--- network guard: pin mainnet defaults ---${NC}"
assert_mainnet_default

echo -e "${GREEN}--- expo web export (host) ---${NC}"
rm -rf web-build
(
  cd expo-app
  npx expo export --platform web --output-dir ../web-build
)
[ -f web-build/index.html ] || { echo -e "${RED}web-build/index.html missing — export failed${NC}"; exit 1; }

# 2. Image
TAGS=(-t "${IMAGE_BASE}:latest")
[ -n "$VERSION" ] && TAGS+=(-t "${IMAGE_BASE}:v${VERSION}")
echo -e "${GREEN}--- docker build ${IMAGE_BASE}:latest ---${NC}"
docker build -f deploy/Dockerfile.app "${TAGS[@]}" .

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
