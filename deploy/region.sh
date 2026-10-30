#!/bin/bash
# deploy/region.sh — provision a full wallet web region VM.
#
# Model (deploy/README.md): the wallet is a STATIC web export served by an
# nginx container (deploy/compose.prod.yml). It talks to the EXISTING prod chain
# from the browser (mainnet L0/L1 same-origin /l0/* + /l1/* via this script's
# Caddy vhost → $L0_API/$L1_API), so no chain/DB containers exist here.
# Caddy stays on the host: it is the shared TLS
# gateway for every tenant on these VMs and reverse-proxies the region domain to
# the container's 127.0.0.1 host port.
#
# The image is built on a dev/CI host by deploy/tag.sh (needs the node
# toolchain) and either pushed to $APP_IMAGE or saved to deploy/.image/. The VM
# never compiles — region.sh just transfers/loads the image and runs compose.
#
#   ./deploy/region.sh deploy europa      # full provision (idempotent)
#   ./deploy/region.sh caddy europa       # rewrite Caddy vhosts only
#   ./deploy/region.sh status europa      # container + ports
#   ./deploy/region.sh health europa      # local container + public https
#   ./deploy/region.sh logs europa        # recent container logs
#   ./deploy/region.sh env europa         # resolved config for the region
#   ./deploy/region.sh prune europa       # drop superseded wallet image tags
#   ./deploy/region.sh destroy europa     # stop stack (remove Caddy vhost)
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

source "${SCRIPT_DIR}/region.conf"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o IdentitiesOnly=yes"

usage() {
  cat <<EOF
Usage: $(basename "$0") <action> <region>

Regions: ${REGIONS[*]}

Actions:
  deploy   Full provision: image (registry pull or docker-load tar) ->
           repo sync -> compose up -> Caddy vhost. Idempotent.
  p2p      P2P settlement engine: image -> secrets -> compose up ->
           /healthz -> Caddy /p2p/* route. Idempotent.
  caddy    (Re)write the Caddy vhost for the region only.
  status   Container (compose ps) + listening ports.
  health   Container health + public https.
  logs     Recent container logs.
  env      Show the resolved config for the region.
  prune    Remove superseded wallet-web / wallet-p2p-engine image tags on the
           region (keeps the tag a running container uses; never touches other
           tenants' images). Called by deploy.sh after each successful deploy.
  destroy  Stop the containers, remove the Caddy vhost (nothing to wipe — no data).
EOF
  exit 1
}

valid_region() { local r; for r in "${REGIONS[@]}"; do [ "$r" = "$1" ] && return 0; done; return 1; }
require_region() { valid_region "$1" || { echo -e "${RED}invalid region '$1'. Valid: ${REGIONS[*]}${NC}"; exit 1; }; }
vm_ip()   { echo "${REGION_VM[$1]}"; }
vm_user() { echo "${REGION_SSH_USER[$1]}"; }
vm_key()  { echo "${REGION_SSH_KEY[$1]}"; }
domain()  { echo "${REGION_DOMAIN[$1]}"; }

# The single shared P2P engine runs on P2P_REGION (region.conf); every other
# region's /p2p/* proxies to its domain. Resolved once here.
P2P_DOMAIN="${P2P_DOMAIN:-$(domain "$P2P_REGION")}"

# Resolve the VM working dir per SSH user when REMOTE_REPO was left empty:
# root regions keep the stack at /srv/wallet, ubuntu regions at /home/<user>/wallet.
default_repo() {
  local u; u="$(vm_user "$1")"
  [ "$u" = "root" ] && echo "/srv/wallet" || echo "/home/$u/wallet"
}

ssh_run() { local r="$1"; shift; ssh ${SSH_OPTS} -i "$(vm_key "$r")" "$(vm_user "$r")@$(vm_ip "$r")" "$@"; }

sudo_cmd() { local r="$1"; [ "$(vm_user "$r")" = "root" ] && echo "" || echo "sudo"; }

preflight() {
  local r="$1" key; key="$(vm_key "$r")"
  [ -f "$key" ] || { echo -e "${RED}SSH key not found: $key${NC}"; exit 1; }
  [ "$(vm_ip "$r")" = "CHANGE_ME" ] && { echo -e "${RED}region.conf not configured for '$r' (VM IP is still CHANGE_ME)${NC}"; exit 1; }
  case "$(domain "$r")" in *CHANGE_ME*) echo -e "${RED}region.conf domain still CHANGE_ME for '$r'${NC}"; exit 1;; esac
  echo -n "  SSH $(vm_user "$r")@$(vm_ip "$r") ... "
  ssh_run "$r" "echo OK" 2>/dev/null | grep -q OK && echo -e "${GREEN}OK${NC}" || { echo -e "${RED}FAILED${NC}"; exit 1; }
  # refuse to serve a port another process already owns (bapp- = legacy name,
  # still recognized so an un-migrated VM passes its own preflight)
  local busy; busy=$(ssh_run "$r" "PORT=$WEB_PORT bash -s" <<'EOF' 2>/dev/null
if ss -tln 2>/dev/null | grep -qE ":$PORT\s" && \
   ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qE "^(bapp|wallet)-.*-web$"; then
  echo BUSY
fi
EOF
)
  [ -z "$busy" ] || { echo -e "${RED}  port :$WEB_PORT is held by a foreign process/container on the VM${NC}"; exit 1; }
}

sync_repo() {
  local r="$1"
  echo -e "${GREEN}--- Syncing repo → $(vm_ip "$r"):$REMOTE_REPO ---${NC}"
  ssh_run "$r" "mkdir -p $REMOTE_REPO"
  rsync -az --delete --no-owner --no-group \
    -e "ssh ${SSH_OPTS} -i $(vm_key "$r")" \
    --exclude node_modules --exclude '**/node_modules' --exclude .git \
    --exclude web-build --exclude 'e2e/web-build' --exclude 'e2e/demo-output' \
    --exclude 'expo-app/.expo' --exclude deploy/.image --exclude '*.log' \
    --exclude test-results --exclude playwright-report --exclude logs \
    --exclude '.env' --exclude 'deploy/env' \
    --exclude out --exclude 'expo-app/dist' --exclude 'expo-app/android' \
    --exclude 'expo-app/ios' --exclude 'webapp/android' --exclude 'webapp/dist' \
    --exclude '*.apk' --exclude '*.aab' --exclude '.gradle' \
    "${PROJECT_DIR}/" "$(vm_user "$r")@$(vm_ip "$r"):$REMOTE_REPO/"
  # legacy rename /srv/bapp (or /home/<user>/bapp) → the resolved REMOTE_REPO:
  # drop the old default dir only after the new one has the tree, and never
  # when REMOTE_REPO was overridden to stay where it is
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO bash -s" <<'EOF'
set -e
u="$(id -un)"
legacy=$([ "$u" = "root" ] && echo "/srv/bapp" || echo "/home/$u/bapp")
if [ "$legacy" != "$REMOTE_REPO" ] && [ -d "$legacy" ]; then
  rm -rf "$legacy"
  echo "removed legacy repo dir $legacy"
fi
EOF
}

ensure_image() {
  local r="$1"
  echo -e "${GREEN}--- Image for $(vm_ip "$r") ---${NC}"
  if [ -n "$APP_IMAGE" ]; then
    ssh_run "$r" "docker pull $APP_IMAGE"
  else
    local tar="${SCRIPT_DIR}/.image/wallet-web.latest.tar"
    if [ ! -f "$tar" ]; then
      echo -e "${RED}deploy/.image/wallet-web.latest.tar not found and APP_IMAGE is empty — run ./deploy/tag.sh first (or export APP_IMAGE)${NC}"
      exit 1
    fi
    ssh_run "$r" "mkdir -p $REMOTE_REPO/.image"
    scp ${SSH_OPTS} -i "$(vm_key "$r")" "$tar" "$(vm_user "$r")@$(vm_ip "$r"):$REMOTE_REPO/.image/wallet-web.latest.tar"
    ssh_run "$r" "docker load -i $REMOTE_REPO/.image/wallet-web.latest.tar"
  fi
}

infra_up() {
  local r="$1"
  echo -e "${GREEN}--- Container up (compose.prod.yml) on $(vm_ip "$r") ---${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r WEB_PORT=$WEB_PORT APP_IMAGE=$APP_IMAGE bash -s" <<'EOF'
set -e
cd "$REMOTE_REPO"
# legacy rename bapp-<region>-web → wallet-<region>-web: the old container
# still owns the published port, so drop it before the new project comes up
if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "bapp-$REGION-web"; then
  docker rm -f "bapp-$REGION-web" >/dev/null 2>&1 || true
  docker network rm "bapp-${REGION}_default" >/dev/null 2>&1 || true
  echo "removed legacy container bapp-$REGION-web"
fi
docker compose -f deploy/compose.prod.yml up -d
echo "container up"
EOF
}

wait_health() {
  local r="$1"
  echo -e "${GREEN}--- Waiting for web on :$WEB_PORT ---${NC}"
  ssh_run "$r" "PORT=$WEB_PORT bash -s" <<'EOF'
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then echo "web ok"; exit 0; fi
  sleep 2
done
echo "web NOT responding on :$PORT"
exit 1
EOF
}

# ─── P2P settlement engine (services/p2p-engine) ───
# Provisioned separately from the static web stack: the engine holds its
# store (default: an encrypted blob store, no database) + engine identity
# secrets that a client app must never see. Secrets live on the RELEASE
# HOST in the gitignored deploy/env/.env.p2p.<region> (region.sh rsyncs exclude
# deploy/env, so each run scps them again) and are passed to compose as an
# --env-file (interpolation only — compose whitelist-maps the container env).
p2p_up() {
  local r="$1"; require_region "$r"
  # The engine is a SHARED singleton: one key + one store for every region, so
  # exactly one VM runs it (region.conf P2P_REGION). A second one would carry a
  # different SETTLEMENT_ENGINE_KEY and derive different escrow vaults.
  if [ "$r" != "$P2P_REGION" ]; then
    echo -e "${RED}P2P is one shared engine (region.conf P2P_REGION=$P2P_REGION); refusing to run a second one on '$r'.${NC}" >&2
    echo -e "${YELLOW}Run: ./deploy/region.sh p2p $P2P_REGION   (or set P2P_REGION=$r to move the shared engine)${NC}" >&2
    exit 1
  fi
  local env_file="${SCRIPT_DIR}/env/.env.p2p.${r}"
  local tar="${SCRIPT_DIR}/.image/wallet-p2p-engine.latest.tar"
  [ -f "$env_file" ] || { echo -e "${RED}secrets missing: $env_file — create it first (scripts/p2p-engine-key.mjs + docs/p2p.md)${NC}"; exit 1; }
  preflight "$r" || { echo -e "${RED}preflight failed${NC}"; exit 1; }
  sync_repo "$r" || { echo -e "${RED}sync failed — p2p aborted${NC}"; exit 1; }

  echo -e "${GREEN}--- P2P secrets → $(vm_ip "$r"):$REMOTE_REPO/deploy/env ---${NC}"
  ssh_run "$r" "mkdir -p $REMOTE_REPO/deploy/env"
  scp ${SSH_OPTS} -i "$(vm_key "$r")" "$env_file" \
    "$(vm_user "$r")@$(vm_ip "$r"):$REMOTE_REPO/deploy/env/.env.p2p.${r}"
  # image tar (no-registry path): transfer when tag.sh saved one
  if [ -f "$tar" ]; then
    ssh_run "$r" "mkdir -p $REMOTE_REPO/.image"
    scp ${SSH_OPTS} -i "$(vm_key "$r")" "$tar" \
      "$(vm_user "$r")@$(vm_ip "$r"):$REMOTE_REPO/.image/wallet-p2p-engine.latest.tar"
  fi

  echo -e "${GREEN}--- P2P engine up on $(vm_ip "$r") (:$P2P_PORT) ---${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r P2P_PORT=$P2P_PORT P2P_IMAGE=$P2P_IMAGE P2P_COMPOSE=${P2P_COMPOSE:-deploy/compose.p2p-engine.blob.yml} bash -s" <<'EOF'
set -e
cd "$REMOTE_REPO"
COMPOSE="docker compose --env-file deploy/env/.env.p2p.$REGION -f ${P2P_COMPOSE:-deploy/compose.p2p-engine.blob.yml}"
# image: registry pull, else the docker-save tar tag.sh built — never build on the VM
if [ -n "$P2P_IMAGE" ] && docker pull "$P2P_IMAGE" >/dev/null 2>&1; then
  echo "image: $P2P_IMAGE (registry pull)"
elif [ -f .image/wallet-p2p-engine.latest.tar ]; then
  docker load -i .image/wallet-p2p-engine.latest.tar >/dev/null
  [ -n "$P2P_IMAGE" ] && docker tag wallet-p2p-engine:latest "$P2P_IMAGE"
  echo "image: wallet-p2p-engine:latest (tar)"
else
  echo "p2p engine image unavailable: pull of '$P2P_IMAGE' failed and no .image/wallet-p2p-engine.latest.tar" >&2
  exit 1
fi
$COMPOSE up -d --no-build
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$P2P_PORT/healthz" 2>/dev/null; then
    echo "p2p engine ok"
    exit 0
  fi
  sleep 2
done
echo "p2p engine NOT responding on :$P2P_PORT" >&2
$COMPOSE logs --tail=40 --no-color 2>/dev/null | tail -40
exit 1
EOF
  # route /p2p/* to the engine (idempotent vhost rewrite + reload)
  config_caddy "$r" || { echo -e "${RED}config_caddy failed${NC}"; exit 1; }
  echo -e "${GREEN}=== p2p engine ready: https://$(domain "$r")/p2p/healthz ===${NC}"
}

config_caddy() {
  local r="$1" dom; dom="$(domain "$r")"
  local sudo; sudo="$(sudo_cmd "$r")"
  local apex="${APEX_DOMAIN:-wallet.bigt.ai}"
  # ONE shared engine (region.conf P2P_REGION): the host region proxies to its
  # local container and strips /p2p (the engine serves /orders…, not /p2p/…);
  # every other region preserves the full /p2p/… path and forwards it to the
  # host region's vhost, which strips it. Same-origin either way — the bundle
  # bakes EXPO_PUBLIC_P2P_ENGINE_URL=/p2p (deploy/tag.sh).
  local p2p_verb p2p_upstream
  if [ "$r" = "$P2P_REGION" ]; then
    p2p_verb="handle_path"; p2p_upstream="127.0.0.1:${P2P_PORT}"
  else
    p2p_verb="handle"; p2p_upstream="https://${P2P_DOMAIN}"
  fi
  echo -e "${GREEN}--- Caddy vhosts for $dom on $(vm_ip "$r") ---${NC}"
  ssh ${SSH_OPTS} -i "$(vm_key "$r")" "$(vm_user "$r")@$(vm_ip "$r")" \
    "${sudo} tee /etc/caddy/Caddyfile.d/wallet-${r}.caddy > /dev/null" <<CADDYEOF
# wallet $r — wallet web app (static nginx container on 127.0.0.1:${WEB_PORT})
${dom}, www.${dom} {
    encode gzip
    # Same-origin chain APIs: the browser bundle calls the relative /l0/* and
    # /l1/* paths (an HTTPS page cannot call the plain-http MainNetParams
    # seeds, and the chain nodes have CORS disabled). The default /l0/, /l1/
    # map to the primary node; the per-node paths (/l0/eu1|eu2|hk1,
    # /l1/ordereu1|ordereu2|orderhk1) let the Chains page probe every node.
    # Keep in sync with MAINNET_NODES in expo-app/sources/lib/chainstatus.ts
    # and with the location blocks in nginx.conf.
    handle_path /l0/eu1/* {
        reverse_proxy ${L0_API}
    }
    handle_path /l0/eu2/* {
        reverse_proxy https://eu2.bigtangle.org
    }
    handle_path /l0/hk1/* {
        reverse_proxy https://hk1.bigtangle.org
    }
    handle_path /l0/* {
        reverse_proxy ${L0_API}
    }
    handle_path /l1/ordereu1/* {
        reverse_proxy ${L1_API}
    }
    handle_path /l1/ordereu2/* {
        reverse_proxy https://ordereu2.bigtangle.org
    }
    handle_path /l1/orderhk1/* {
        reverse_proxy https://orderhk1.bigtangle.org
    }
    handle_path /l1p/* {
        reverse_proxy https://predicteu1.bigtangle.org
    }
    handle_path /l1/* {
        reverse_proxy ${L1_API}
    }
    # P2P settlement engine (services/p2p-engine) — ONE shared engine for every
    # region (region.conf P2P_REGION). The host region proxies to its local
    # container and strips /p2p (the engine serves /orders…); other regions
    # forward the full /p2p/… path to the host region's vhost, which strips it.
    # Same-origin either way (EXPO_PUBLIC_P2P_ENGINE_URL=/p2p, deploy/tag.sh).
    # The bare /p2p SPA route is exactly /p2p (no trailing slash) and must be
    # served by the web container, not the engine; keep in sync with
    # nginx.conf (location = /p2p + location /p2p/).
    handle /p2p/ {
        reverse_proxy 127.0.0.1:${WEB_PORT}
    }
    ${p2p_verb} /p2p/* {
        reverse_proxy ${p2p_upstream}
    }
    handle {
        reverse_proxy 127.0.0.1:${WEB_PORT}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/wallet-${r}-access.log
    }
}

http://${dom}, http://www.${dom} {
    redir https://${dom}{uri} permanent
}
CADDYEOF
  # apex (wallet.bigt.ai / www.wallet.bigt.ai) is served from one region
  # (region.conf APEX_REGION, analog ../dai bigt.ai); other regions only handle
  # their own <region>.wallet.bigt.ai domain.
  if [ "$r" = "${APEX_REGION:-}" ]; then
    ssh ${SSH_OPTS} -i "$(vm_key "$r")" "$(vm_user "$r")@$(vm_ip "$r")" \
      "${sudo} tee -a /etc/caddy/Caddyfile.d/wallet-${r}.caddy > /dev/null" <<APEXEOF

# wallet apex (${APEX_REGION}) — ${apex} / www.${apex} → web
${apex}, www.${apex} {
    encode gzip
    # Per-node same-origin proxies for the Chains page (see the region vhost).
    handle_path /l0/eu1/* {
        reverse_proxy ${L0_API}
    }
    handle_path /l0/eu2/* {
        reverse_proxy https://eu2.bigtangle.org
    }
    handle_path /l0/hk1/* {
        reverse_proxy https://hk1.bigtangle.org
    }
    handle_path /l0/* {
        reverse_proxy ${L0_API}
    }
    handle_path /l1/ordereu1/* {
        reverse_proxy ${L1_API}
    }
    handle_path /l1/ordereu2/* {
        reverse_proxy https://ordereu2.bigtangle.org
    }
    handle_path /l1/orderhk1/* {
        reverse_proxy https://orderhk1.bigtangle.org
    }
    handle_path /l1p/* {
        reverse_proxy https://predicteu1.bigtangle.org
    }
    handle_path /l1/* {
        reverse_proxy ${L1_API}
    }
    # P2P settlement engine (services/p2p-engine) — ONE shared engine for every
    # region (region.conf P2P_REGION). The host region proxies to its local
    # container and strips /p2p (the engine serves /orders…); other regions
    # forward the full /p2p/… path to the host region's vhost, which strips it.
    # Same-origin either way (EXPO_PUBLIC_P2P_ENGINE_URL=/p2p, deploy/tag.sh).
    # The bare /p2p SPA route is exactly /p2p (no trailing slash) and must be
    # served by the web container, not the engine; keep in sync with
    # nginx.conf (location = /p2p + location /p2p/).
    handle /p2p/ {
        reverse_proxy 127.0.0.1:${WEB_PORT}
    }
    ${p2p_verb} /p2p/* {
        reverse_proxy ${p2p_upstream}
    }
    handle {
        reverse_proxy 127.0.0.1:${WEB_PORT}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/wallet-${r}-apex-access.log
    }
}

http://${apex}, http://www.${apex} {
    redir https://${apex}{uri} permanent
}
APEXEOF
  fi
  # legacy rename bapp-<r>.caddy → wallet-<r>.caddy: drop the old vhost file
  # before the reload — two site blocks for the same domain would fail it
  ssh_run "$r" "${sudo} rm -f /etc/caddy/Caddyfile.d/bapp-${r}.caddy"
  ssh_run "$r" "${sudo} systemctl reload caddy 2>/dev/null || ${sudo} caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true"
  echo -e "${GREEN}    Caddy configured for $dom${NC}"
  if [ "$r" = "${APEX_REGION:-}" ]; then
    echo -e "${GREEN}    Caddy apex configured for $apex${NC}"
  fi
}

# ─── Actions ───

deploy_region() {
  local r="$1"
  echo -e "\n${GREEN}=== Deploy wallet → $r ===${NC}"
  require_region "$r"
  preflight "$r" || { echo -e "${RED}preflight failed${NC}"; exit 1; }
  ensure_image "$r" || { echo -e "${RED}image failed — deploy aborted${NC}"; exit 1; }
  sync_repo "$r" || { echo -e "${RED}sync failed — deploy aborted${NC}"; exit 1; }
  infra_up "$r" || { echo -e "${RED}infra_up failed — deploy aborted${NC}"; exit 1; }
  wait_health "$r" || { echo -e "${RED}web did not come up${NC}"; exit 1; }
  config_caddy "$r" || { echo -e "${RED}config_caddy failed${NC}"; exit 1; }
  echo -e "${GREEN}=== $r complete — https://$(domain "$r") ===${NC}"
}

status_region() {
  local r="$1"; require_region "$r"
  echo -e "\n${GREEN}=== Status: $r ($(vm_ip "$r")) ===${NC}"
  ssh_run "$r" "REGION=$r bash -s" <<'EOF'
echo "--- wallet container ---"
docker ps --filter "name=wallet-$REGION-web" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo "--- web image ---"
docker images --format "{{.Repository}}:{{.Tag}}" | grep -E 'wallet-web|^REPOSITORY' | head -5 || true
echo "--- p2p engine ---"
docker ps --filter "name=wallet-p2p-$REGION" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || true
EOF
  echo "  container port :$WEB_PORT → $(ssh_run "$r" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$WEB_PORT/ 2>/dev/null || echo 000")"
  echo "  p2p engine     :$P2P_PORT → $(ssh_run "$r" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$P2P_PORT/healthz 2>/dev/null || echo 000")"
}

health_region() {
  local r="$1" dom; dom="$(domain "$r")"
  require_region "$r"
  echo -e "\n${GREEN}=== Health: $r ===${NC}"
  ssh_run "$r" "PORT=$WEB_PORT bash -s" <<'EOF'
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null)
echo "  http://127.0.0.1:$PORT/ → ${code:-000}"
EOF
  echo "  https://$dom/ → $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$dom/" 2>/dev/null || echo 000)"
  echo "  https://$dom/p2p/healthz → $(curl -s --max-time 10 "https://$dom/p2p/healthz" 2>/dev/null || echo 000)"
}

logs_region() {
  local r="$1"; require_region "$r"
  echo -e "\n${GREEN}=== Logs: $r ===${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r P2P_COMPOSE=$P2P_COMPOSE bash -s" <<'EOF'
cd "$REMOTE_REPO"
docker compose -f deploy/compose.prod.yml logs --tail=80 --no-color 2>/dev/null | tail -120 || true
if [ -f "deploy/env/.env.p2p.$REGION" ]; then
  echo "--- p2p engine ---"
  docker compose --env-file "deploy/env/.env.p2p.$REGION" -f ${P2P_COMPOSE:-deploy/compose.p2p-engine.blob.yml} logs --tail=40 --no-color 2>/dev/null | tail -60 || true
fi
EOF
}

env_region() {
  local r="$1"; require_region "$r"
  echo "  region      : $r"
  echo "  domain      : $(domain "$r")"
  echo "  vm          : $(vm_user "$r")@$(vm_ip "$r") (key: $(vm_key "$r"))"
  echo "  remote repo : $REMOTE_REPO"
  echo "  web port    : $WEB_PORT"
  echo "  p2p port    : $P2P_PORT (engine image: ${P2P_IMAGE:-docker-save tar})"
  echo "  p2p stack   : ${P2P_COMPOSE:-deploy/compose.p2p-engine.blob.yml}"
  [ -f "${SCRIPT_DIR}/env/.env.p2p.${r}" ] && echo "  p2p secrets : deploy/env/.env.p2p.${r} (present)" \
      || echo "  p2p secrets : deploy/env/.env.p2p.${r} (MISSING — run ./deploy/region.sh p2p $r after creating it)"
  if [ "$r" = "${APEX_REGION:-}" ]; then
    echo "  apex        : ${APEX_DOMAIN:-wallet.bigt.ai} (served from $r)"
  fi
  [ -n "$APP_IMAGE" ] && echo "  app image   : $APP_IMAGE (registry pull)" \
                      || echo "  app image   : deploy/.image/wallet-web.latest.tar (docker load)"
}

destroy_region() {
  local r="$1"; require_region "$r"
  local sudo; sudo="$(sudo_cmd "$r")"
  echo -e "${RED}=== Destroy wallet on $r ($(vm_ip "$r")) ===${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r P2P_COMPOSE=$P2P_COMPOSE bash -s" <<'EOF'
cd "$REMOTE_REPO" 2>/dev/null || exit 0
docker compose -f deploy/compose.prod.yml down 2>/dev/null || true
if [ -f "deploy/env/.env.p2p.$REGION" ]; then
  docker compose --env-file "deploy/env/.env.p2p.$REGION" -f ${P2P_COMPOSE:-deploy/compose.p2p-engine.blob.yml} down 2>/dev/null || true
fi
docker rm -f "wallet-p2p-$REGION-engine" "wallet-p2p-$REGION-db" >/dev/null 2>&1 || true
docker rm -f "bapp-$REGION-web" >/dev/null 2>&1 || true
EOF
  ssh_run "$r" "${sudo} rm -f /etc/caddy/Caddyfile.d/wallet-${r}.caddy /etc/caddy/Caddyfile.d/bapp-${r}.caddy"
  ssh_run "$r" "${sudo} systemctl reload caddy 2>/dev/null || ${sudo} caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true"
  echo -e "${GREEN}=== $r destroyed ===${NC}"
}

# Remove superseded wallet image tags on one region, keeping the tag a running
# container was started with. Every release pulls a new wallet-web tag and
# compose never drops the old ones, so a VM's root fills after a dozen deploys
# (us1001 carried v1.0.96…v1.0.101 next to the running v1.0.102 — 300+ MB, on a
# host that was already at 83%). Runs after a successful deploy in deploy.sh and
# is safe any time.
#
# Deliberately scoped: only the repos this train owns are considered, and
# `docker image prune -a` is NEVER used — these VMs are shared with dai, minio,
# router and postgres, whose images must survive a wallet deploy.
prune_region() {
  local r="$1"; require_region "$r"
  echo -e "${GREEN}--- Prune old wallet images on $(vm_ip "$r") ---${NC}"
  ssh_run "$r" "APP_IMAGE=${APP_IMAGE:-} P2P_IMAGE=${P2P_IMAGE:-} bash -s" <<'EOF'
set -e
# Repo of an image ref with any :tag stripped — a registry :port is kept
# (ghcr.io:5000/x:v1 → ghcr.io:5000/x, ghcr.io/x/y:v1 → ghcr.io/x/y).
repo_of() { local img="$1"; case "${img##*/}" in *:*) img="${img%:*}";; esac; echo "$img"; }
repos=""
add_repo() {
  [ -n "$1" ] || return 0
  case " $repos " in *" $1 "*) return 0;; esac
  repos="$repos $1"
}
[ -n "${APP_IMAGE:-}" ] && add_repo "$(repo_of "$APP_IMAGE")"
[ -n "${P2P_IMAGE:-}" ] && add_repo "$(repo_of "$P2P_IMAGE")"
add_repo ghcr.io/bigt-ai-platform/wallet-web
add_repo ghcr.io/bigt-ai-platform/wallet-p2p-engine
add_repo ghcr.io/bigt-ai-platform/bapp-web
removed=0
for repo in $repos; do
  # Whatever a running container was started with is kept: the container pins
  # its image by ID, but the tag is what compose and a rollback reference.
  running="$(docker ps --format '{{.Image}}' 2>/dev/null | grep -F "$repo:" | sort -u || true)"
  for rt in $(docker images "$repo" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null); do
    echo "$running" | grep -qx "$rt" && continue
    if docker rmi "$rt" >/dev/null 2>&1; then
      echo "  removed $rt"; removed=$((removed + 1))
    fi
  done
done
# Untagged leftovers of the tags just replaced (dangling only — tagged images
# of other tenants are never touched).
docker image prune -f >/dev/null 2>&1 || true
echo "  pruned $removed old wallet image tag(s)"
EOF
}

main() {
  local ACTION="${1:-}"; shift || true
  local REGION="${1:-}"
  [ -n "$REGION" ] && valid_region "$REGION" && [ -z "$REMOTE_REPO" ] && REMOTE_REPO="$(default_repo "$REGION")"
  case "${ACTION}" in
    deploy)  [ -n "$REGION" ] && deploy_region "$REGION" || usage ;;
    p2p)     [ -n "$REGION" ] && p2p_up "$REGION" || usage ;;
    caddy)   [ -n "$REGION" ] && { require_region "$REGION"; config_caddy "$REGION"; } || usage ;;
    status)  [ -n "$REGION" ] && status_region "$REGION" || usage ;;
    health)  [ -n "$REGION" ] && health_region "$REGION" || usage ;;
    logs)    [ -n "$REGION" ] && logs_region "$REGION" || usage ;;
    env)     [ -n "$REGION" ] && env_region "$REGION" || usage ;;
    prune)   [ -n "$REGION" ] && prune_region "$REGION" || usage ;;
    destroy) [ -n "$REGION" ] && destroy_region "$REGION" || usage ;;
    *) usage ;;
  esac
}

main "$@"
