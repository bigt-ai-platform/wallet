#!/bin/bash
# deploy/region.sh — provision a full bapp web region VM.
#
# Model (deploy/README.md): the bapp wallet is a STATIC web export served by an
# nginx container (deploy/compose.prod.yml). It talks to the EXISTING prod chain
# from the browser (mainnet L1 https://m.bigtangle.org / L0 from seeds), so no
# chain/DB containers exist here. Caddy stays on the host: it is the shared TLS
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
  caddy    (Re)write the Caddy vhost for the region only.
  status   Container (compose ps) + listening ports.
  health   Container health + public https.
  logs     Recent container logs.
  env      Show the resolved config for the region.
  destroy  Stop the container, remove the Caddy vhost (nothing to wipe — no data).
EOF
  exit 1
}

valid_region() { local r; for r in "${REGIONS[@]}"; do [ "$r" = "$1" ] && return 0; done; return 1; }
require_region() { valid_region "$1" || { echo -e "${RED}invalid region '$1'. Valid: ${REGIONS[*]}${NC}"; exit 1; }; }
vm_ip()   { echo "${REGION_VM[$1]}"; }
vm_user() { echo "${REGION_SSH_USER[$1]}"; }
vm_key()  { echo "${REGION_SSH_KEY[$1]}"; }
domain()  { echo "${REGION_DOMAIN[$1]}"; }

ssh_run() { local r="$1"; shift; ssh ${SSH_OPTS} -i "$(vm_key "$r")" "$(vm_user "$r")@$(vm_ip "$r")" "$@"; }

sudo_cmd() { local r="$1"; [ "$(vm_user "$r")" = "root" ] && echo "" || echo "sudo"; }

preflight() {
  local r="$1" key; key="$(vm_key "$r")"
  [ -f "$key" ] || { echo -e "${RED}SSH key not found: $key${NC}"; exit 1; }
  [ "$(vm_ip "$r")" = "CHANGE_ME" ] && { echo -e "${RED}region.conf not configured for '$r' (VM IP is still CHANGE_ME)${NC}"; exit 1; }
  case "$(domain "$r")" in *CHANGE_ME*) echo -e "${RED}region.conf domain still CHANGE_ME for '$r'${NC}"; exit 1;; esac
  echo -n "  SSH $(vm_user "$r")@$(vm_ip "$r") ... "
  ssh_run "$r" "echo OK" 2>/dev/null | grep -q OK && echo -e "${GREEN}OK${NC}" || { echo -e "${RED}FAILED${NC}"; exit 1; }
  # refuse to serve a port another process already owns
  local busy; busy=$(ssh_run "$r" "PORT=$WEB_PORT bash -s" <<'EOF' 2>/dev/null
if ss -tln 2>/dev/null | grep -qE ":$PORT\s" && \
   ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^bapp-.*-web$"; then
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
    "${PROJECT_DIR}/" "$(vm_user "$r")@$(vm_ip "$r"):$REMOTE_REPO/"
}

ensure_image() {
  local r="$1"
  echo -e "${GREEN}--- Image for $(vm_ip "$r") ---${NC}"
  if [ -n "$APP_IMAGE" ]; then
    ssh_run "$r" "docker pull $APP_IMAGE"
  else
    local tar="${SCRIPT_DIR}/.image/bapp-web.latest.tar"
    if [ ! -f "$tar" ]; then
      echo -e "${RED}deploy/.image/bapp-web.latest.tar not found and APP_IMAGE is empty — run ./deploy/tag.sh first (or export APP_IMAGE)${NC}"
      exit 1
    fi
    ssh_run "$r" "mkdir -p $REMOTE_REPO/.image"
    scp ${SSH_OPTS} -i "$(vm_key "$r")" "$tar" "$(vm_user "$r")@$(vm_ip "$r"):$REMOTE_REPO/.image/bapp-web.latest.tar"
    ssh_run "$r" "docker load -i $REMOTE_REPO/.image/bapp-web.latest.tar"
  fi
}

infra_up() {
  local r="$1"
  echo -e "${GREEN}--- Container up (compose.prod.yml) on $(vm_ip "$r") ---${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r WEB_PORT=$WEB_PORT APP_IMAGE=$APP_IMAGE bash -s" <<'EOF'
set -e
cd "$REMOTE_REPO"
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

config_caddy() {
  local r="$1" dom; dom="$(domain "$r")"
  local sudo; sudo="$(sudo_cmd "$r")"
  local apex="${APEX_DOMAIN:-wallet.bigt.ai}"
  echo -e "${GREEN}--- Caddy vhosts for $dom on $(vm_ip "$r") ---${NC}"
  ssh ${SSH_OPTS} -i "$(vm_key "$r")" "$(vm_user "$r")@$(vm_ip "$r")" \
    "${sudo} tee /etc/caddy/Caddyfile.d/bapp-${r}.caddy > /dev/null" <<CADDYEOF
# bapp $r — wallet web app (static nginx container on 127.0.0.1:${WEB_PORT})
${dom}, www.${dom} {
    reverse_proxy 127.0.0.1:${WEB_PORT}
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/bapp-${r}-access.log
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
      "${sudo} tee -a /etc/caddy/Caddyfile.d/bapp-${r}.caddy > /dev/null" <<APEXEOF

# bapp apex (${APEX_REGION}) — ${apex} / www.${apex} → web
${apex}, www.${apex} {
    reverse_proxy 127.0.0.1:${WEB_PORT}
    encode gzip
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "strict-origin-when-cross-origin"
    }
    log {
        output file /var/log/caddy/bapp-${r}-apex-access.log
    }
}

http://${apex}, http://www.${apex} {
    redir https://${apex}{uri} permanent
}
APEXEOF
  fi
  ssh_run "$r" "${sudo} systemctl reload caddy 2>/dev/null || ${sudo} caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true"
  echo -e "${GREEN}    Caddy configured for $dom${NC}"
  if [ "$r" = "${APEX_REGION:-}" ]; then
    echo -e "${GREEN}    Caddy apex configured for $apex${NC}"
  fi
}

# ─── Actions ───

deploy_region() {
  local r="$1"
  echo -e "\n${GREEN}=== Deploy bapp → $r ===${NC}"
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
echo "--- bapp container ---"
docker ps --filter "name=bapp-$REGION-web" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo "--- web image ---"
docker images --format "{{.Repository}}:{{.Tag}}" | grep -E 'bapp-web|^REPOSITORY' | head -5 || true
EOF
  echo "  container port :$WEB_PORT → $(ssh_run "$r" "curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:$WEB_PORT/ 2>/dev/null || echo 000")"
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
}

logs_region() {
  local r="$1"; require_region "$r"
  echo -e "\n${GREEN}=== Logs: $r ===${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r bash -s" <<'EOF'
cd "$REMOTE_REPO"
docker compose -f deploy/compose.prod.yml logs --tail=80 --no-color 2>/dev/null | tail -120 || true
EOF
}

env_region() {
  local r="$1"; require_region "$r"
  echo "  region      : $r"
  echo "  domain      : $(domain "$r")"
  echo "  vm          : $(vm_user "$r")@$(vm_ip "$r") (key: $(vm_key "$r"))"
  echo "  remote repo : $REMOTE_REPO"
  echo "  web port    : $WEB_PORT"
  if [ "$r" = "${APEX_REGION:-}" ]; then
    echo "  apex        : ${APEX_DOMAIN:-wallet.bigt.ai} (served from $r)"
  fi
  [ -n "$APP_IMAGE" ] && echo "  app image   : $APP_IMAGE (registry pull)" \
                      || echo "  app image   : deploy/.image/bapp-web.latest.tar (docker load)"
}

destroy_region() {
  local r="$1"; require_region "$r"
  local sudo; sudo="$(sudo_cmd "$r")"
  echo -e "${RED}=== Destroy bapp on $r ($(vm_ip "$r")) ===${NC}"
  ssh_run "$r" "REMOTE_REPO=$REMOTE_REPO REGION=$r bash -s" <<'EOF'
cd "$REMOTE_REPO" 2>/dev/null || exit 0
docker compose -f deploy/compose.prod.yml down 2>/dev/null || true
EOF
  ssh_run "$r" "${sudo} rm -f /etc/caddy/Caddyfile.d/bapp-${r}.caddy"
  ssh_run "$r" "${sudo} systemctl reload caddy 2>/dev/null || ${sudo} caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true"
  echo -e "${GREEN}=== $r destroyed ===${NC}"
}

main() {
  local ACTION="${1:-}"; shift || true
  local REGION="${1:-}"
  case "${ACTION}" in
    deploy)  [ -n "$REGION" ] && deploy_region "$REGION" || usage ;;
    caddy)   [ -n "$REGION" ] && { require_region "$REGION"; config_caddy "$REGION"; } || usage ;;
    status)  [ -n "$REGION" ] && status_region "$REGION" || usage ;;
    health)  [ -n "$REGION" ] && health_region "$REGION" || usage ;;
    logs)    [ -n "$REGION" ] && logs_region "$REGION" || usage ;;
    env)     [ -n "$REGION" ] && env_region "$REGION" || usage ;;
    destroy) [ -n "$REGION" ] && destroy_region "$REGION" || usage ;;
    *) usage ;;
  esac
}

main "$@"
