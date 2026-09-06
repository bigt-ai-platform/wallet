#!/usr/bin/env bash
# deploy/deploy.sh — release train: bump the patch tag → build+push the shared
# bapp-web image (deploy/tag.sh) → deploy every region (deploy/region.sh
# deploy <r>) pinned to the exact vX.Y.Z image so each VM pulls what was just
# built. Analog ../dai/deploy/deploy.sh.
#
#   ./deploy/deploy.sh                # bump patch of the latest vX.Y.Z tag
#   ./deploy/deploy.sh 0.3.1          # explicit version
#   ./deploy/deploy.sh --commit       # commit the dirty tree first
#   ./deploy/deploy.sh --yes          # skip the confirmation prompt
#   ./deploy/deploy.sh --dry-run      # print the plan, do nothing
#   ./deploy/deploy.sh --deploy-only  # no tag/build — deploy existing :latest
#
# Env passthrough to tag.sh/region.sh: IMAGE (or APP_IMAGE), DOCKER_USER,
# DOCKER_PAT. To restrict the fleet:
#   DEPLOY_REGIONS="europa asia" ./deploy/deploy.sh
#
# The release train is MAINNET only: deploy.sh (and tag.sh) run
# deploy/network.sh's assert_mainnet_default before tagging/building and abort
# if the checked-in source no longer pins the mainnet defaults.
#
# Requires: docker (tag.sh builds/pushes), git, SSH access to each region VM
# (region.sh) and, if the registry image is private, a prior `docker login`.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SCRIPT_DIR="$ROOT/deploy"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/region.conf"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/network.sh"
ALL_REGIONS=("${REGIONS[@]}")

COMMIT=0; YES=0; DRY=0; DEPLOY_ONLY=0; VERSION=""
for a in "$@"; do
  case "$a" in
    --commit)    COMMIT=1 ;;
    --yes|-y)    YES=1 ;;
    --dry-run)   DRY=1 ;;
    --deploy-only) DEPLOY_ONLY=1 ;;
    v[0-9]* | [0-9]*) VERSION="${a#v}" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo -e "${RED}unknown arg: $a${NC}"; exit 1 ;;
  esac
done

if [ "$DEPLOY_ONLY" = 1 ]; then
  VERSION="${VERSION:-latest}"
else
  if [ -z "$VERSION" ]; then
    CUR="$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' | sed 's/^v//' | sort -V | tail -1 || true)"
    if [ -z "$CUR" ]; then
      CUR="$(node -p "require('./expo-app/package.json').version" 2>/dev/null || echo 0.0.0)"
    fi
    VERSION="$(echo "$CUR" | awk -F. '{printf "%d.%d.%d", $1, $2, $3+1}')"
  fi
  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo -e "${RED}tag v$VERSION already exists — pass a higher version${NC}"; exit 1
  fi
fi

# Single shared image (analog dai IMAGE=aifeeds-app). APP_IMAGE env is honoured
# as an alias so `APP_IMAGE=... ./deploy/deploy.sh` also works. Any :tag suffix
# (region.conf defaults APP_IMAGE to :latest) is stripped — the release train
# always pins :vX.Y.Z / :latest itself.
IMAGE="${IMAGE:-${APP_IMAGE:-ghcr.io/bigt-ai-platform/bapp-web}}"
if [[ "${IMAGE##*/}" == *:* ]]; then IMAGE="${IMAGE%:*}"; fi
[ "$DEPLOY_ONLY" = 1 ] && TAGGED="$IMAGE:latest" || TAGGED="$IMAGE:v$VERSION"

if [ -z "${DEPLOY_REGIONS:-}" ]; then
  DEPLOY_REGIONS_ARR=("${ALL_REGIONS[@]}")
else
  read -r -a DEPLOY_REGIONS_ARR <<< "$DEPLOY_REGIONS"
  for r in "${DEPLOY_REGIONS_ARR[@]}"; do
    valid=0; for x in "${ALL_REGIONS[@]}"; do [ "$x" = "$r" ] && valid=1; done
    [ "$valid" = 1 ] || { echo -e "${RED}invalid region '$r'. Valid: ${ALL_REGIONS[*]}${NC}"; exit 1; }
  done
fi

echo -e "${GREEN}=== bapp-web release ${VERSION:+v$VERSION} → $TAGGED${NC}"
echo "    regions: ${DEPLOY_REGIONS_ARR[*]}"
echo "    apex: ${APEX_DOMAIN:-wallet.bigt.ai} (via ${APEX_REGION:-europa})"
echo "    build+push: $([ "$DEPLOY_ONLY" = 1 ] && echo 'no (deploy-only)' || echo 'yes (deploy/tag.sh)')"

if [ "$DRY" = 1 ]; then
  echo -e "${YELLOW}[dry-run] nothing executed${NC}"
  exit 0
fi

[ "$YES" = 1 ] || {
  read -r -p "Continue? [y/N] " ans
  case "$ans" in y|Y) ;; *) echo -e "${RED}aborted${NC}"; exit 1 ;; esac
}

# 1. tag + build + push the shared image (creates git tag vX.Y.Z, pushes :v + :latest)
# NOTE: deploy/tag.sh builds the expo export + nginx image and pushes $APP_IMAGE
# but does not manage git tags itself (unlike dai's ./tag.sh), so deploy.sh owns
# the git tag here.
if [ "$DEPLOY_ONLY" != 1 ]; then
  echo -e "\n${GREEN}--- network guard: source must pin mainnet defaults ---${NC}"
  assert_mainnet_default

  if [ -n "$(git status --porcelain)" ]; then
    if [ "$COMMIT" = 1 ]; then
      echo "committing working tree…"
      git add -A && git commit -q -m "release $VERSION"
    else
      echo -e "${YELLOW}dirty tree — run with --commit to auto-commit, or commit manually (continuing)${NC}"
    fi
  fi
  echo -e "\n${GREEN}--- git tag v$VERSION ---${NC}"
  git tag -a "v$VERSION" -m "bapp-web $VERSION"

  echo -e "\n${GREEN}--- deploy/tag.sh $VERSION ($TAGGED) ---${NC}"
  APP_IMAGE="$TAGGED" ./deploy/tag.sh "$VERSION"

  # tag.sh pushes $TAGGED (:v); also refresh :latest so fresh checkouts and the
  # region.conf default stay on the newest release (analog dai tag.sh).
  echo -e "\n${GREEN}--- push $IMAGE:latest ---${NC}"
  docker tag "$TAGGED" "$IMAGE:latest"
  docker push "$IMAGE:latest"

  echo -e "\n${GREEN}--- git push tag v$VERSION ---${NC}"
  git push origin "v$VERSION"
fi

# 2. deploy every region pinned to this image (apex region first if in the set)
ordered=()
for x in "${APEX_REGION:-}" "${DEPLOY_REGIONS_ARR[@]}"; do
  for r in "${DEPLOY_REGIONS_ARR[@]}"; do
    [ "$x" = "$r" ] || continue
    skip=0; for y in "${ordered[@]}"; do [ "$y" = "$r" ] && skip=1; done
    [ "$skip" = 0 ] && ordered+=("$r")
  done
done
for r in "${ordered[@]}"; do
  echo -e "\n${GREEN}=== deploy → $r ($TAGGED) ===${NC}"
  # region.sh resolves the per-user working dir (/srv/bapp for root,
  # /home/<user>/bapp for ubuntu) from REMOTE_REPO being empty.
  APP_IMAGE="$TAGGED" ./deploy/region.sh deploy "$r"
done

echo -e "\n${GREEN}=== release v${VERSION} deployed to ${ordered[*]} ===${NC}"
echo -e "${YELLOW}verify with: ./deploy/region.sh health ${APEX_REGION:-europa} (then https://${APEX_DOMAIN:-wallet.bigt.ai}/)${NC}"
