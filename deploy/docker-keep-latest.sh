#!/bin/bash
# deploy/docker-keep-latest.sh — keep only the :latest tag for local builds.
#
# Local `deploy/tag.sh` runs build the wallet-web and wallet-p2p-engine images
# on every release, and each build leaves the previous version tags behind
# (wallet-web:v1.0.155, ghcr.io/…/wallet-web:v1.0.155, …). A dev host that
# releases several times a day accumulates dozens of ~54 MB / ~206 MB images,
# which fills the docker data root. Published versions live in the registry, so
# the local copies are disposable.
#
#   ./deploy/docker-keep-latest.sh                     # wallet-web + wallet-p2p-engine
#   ./deploy/docker-keep-latest.sh wallet-web          # only that image family
#   ./deploy/docker-keep-latest.sh --keep latest,v1.0.155 wallet-web
#   ./deploy/docker-keep-latest.sh --prune             # also drop dangling images
#   ./deploy/docker-keep-latest.sh --dry-run           # print what would go
#
# Repositories are matched by their LAST path component, so
# `wallet-web`, `ghcr.io/bigt-ai-platform/wallet-web` and any other registry
# prefix are handled by naming the family once. An image used by an existing
# (even stopped) container is kept and reported — removing its tag would break
# that container's restart.
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

KEEP_TAGS="${KEEP_TAGS:-latest}"
PRUNE=0
DRY_RUN=0
REPOS=()

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keep)    KEEP_TAGS="${2:?--keep needs a comma-separated tag list}"; shift 2 ;;
    --prune)   PRUNE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo -e "${RED}unknown option: $1${NC}" >&2; usage >&2; exit 2 ;;
    *)  REPOS+=("$1"); shift ;;
  esac
done

[ ${#REPOS[@]} -eq 0 ] && REPOS=(wallet-web wallet-p2p-engine)

command -v docker >/dev/null 2>&1 || { echo -e "${RED}docker not found${NC}" >&2; exit 1; }

# Image IDs referenced by any container (running or exited) must survive.
in_use() { [ -n "$(docker ps -aq --filter "ancestor=$1" 2>/dev/null)" ]; }

is_kept() {
  local tag="$1" keep
  for keep in ${KEEP_TAGS//,/ }; do
    [ "$tag" = "$keep" ] && return 0
  done
  return 1
}

removed=0
kept_names=0
skipped=0

while IFS=$'\t' read -r repo tag id; do
  [ -z "$repo" ] || [ "$repo" = "<none>" ] && continue
  [ "$tag" = "<none>" ] && continue

  base="${repo##*/}"
  match=0
  for r in "${REPOS[@]}"; do [ "$r" = "$base" ] && match=1 && break; done
  [ "$match" -eq 1 ] || continue

  if is_kept "$tag"; then
    echo -e "${GREEN}keep${NC}    ${repo}:${tag}"
    kept_names=$((kept_names + 1))
    continue
  fi

  if in_use "$id"; then
    echo -e "${YELLOW}in use${NC}  ${repo}:${tag} (container references ${id:0:12}, not removed)"
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "would rm ${repo}:${tag} (${id:0:12})"
    removed=$((removed + 1))
    continue
  fi

  if docker rmi "${repo}:${tag}" >/dev/null 2>&1; then
    echo -e "${RED}rm${NC}      ${repo}:${tag} (${id:0:12})"
    removed=$((removed + 1))
  else
    echo -e "${YELLOW}failed${NC}  ${repo}:${tag} (${id:0:12})"
    skipped=$((skipped + 1))
  fi
done < <(docker images --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}' --no-trunc)

if [ "$PRUNE" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo -e "${GREEN}--- docker image prune (dangling) ---${NC}"
  docker image prune -f
fi

verb=removed
[ "$DRY_RUN" -eq 1 ] && verb=would-remove
echo -e "${GREEN}=== ${verb} ${removed} tag(s); kept ${kept_names}; skipped ${skipped} ===${NC}"
