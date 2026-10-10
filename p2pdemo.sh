#!/usr/bin/env bash
# p2pdemo.sh — one entry point for the P2P demo guides.
#
# Renders the P2P demo PDFs from the markdown sources in docs/guides (the
# 12-language wallet guide) and docs/p2p-demo (the PayPal + CNY walkthroughs),
# optionally regenerating the screenshots first.
#
#   ./p2pdemo.sh              # pdf (default): render both PDFs from current shots
#   ./p2pdemo.sh pdf          # same as above
#   ./p2pdemo.sh pdf guide    # only the 12-language guide PDFs
#   ./p2pdemo.sh pdf cny      # only the CNY walkthrough PDF
#   ./p2pdemo.sh capture      # (re)capture screenshots, then render PDFs
#   ./p2pdemo.sh capture guide|cny
#   ./p2pdemo.sh all          # rebuild workspace deps + web + engine, shots, PDFs
#   ./p2pdemo.sh e2e          # REAL L0 e2e (escrow proved on-chain) via e2etest.sh
#                             #  p2p-demo — needs `e2e/infra.sh` up first
#   ./p2pdemo.sh down         # stop a leftover local engine / http-server
#
# NO chain infra for pdf/capture/all: `pdf` starts nothing; `capture`/`all` start
# only a local p2p-engine (mem store, no chain check) + a static web server, both
# torn down on exit. `e2e` is the real one — it delegates to `./e2e/e2etest.sh
# p2p-demo`, which runs against the L0/L1 infra and asserts the escrow legs on L0.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Same ports/defaults the capture scripts and e2etest.sh use.
WEB_PORT="${WEB_PORT:-18081}"
P2P_PORT="${P2P_PORT:-18089}"
P2P_ENGINE_URL="${P2P_ENGINE_URL:-http://localhost:${P2P_PORT}}"
APP_URL="${APP_URL:-http://localhost:${WEB_PORT}/}"
WEB_BUILD="$ROOT/e2e/web-build"
ENGINE_BUNDLE="$ROOT/services/p2p-engine/dist/server.bundle.mjs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[OK]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}[INFO]${NC} $1"; }

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

require_bin() { command -v "$1" >/dev/null 2>&1 || fail "$1 not found (install workspace deps: yarn install)"; }

# ── build steps ──────────────────────────────────────────────────────────────

# Workspace packages whose runtime entry is their compiled dist/ (gitignored).
build_ws() {
  info "Building workspace packages..."
  for pkg in bigtangle-ts chain-discovery did p2p-protocol record-sig; do
    ( cd "$ROOT/packages/$pkg" && npm run build >/dev/null 2>&1 ) || fail "build $pkg failed"
  done
  log "Workspace packages built."
}

# The engine runs from an esbuild bundle (bigtangle-ts ships extensionless ESM).
build_engine() {
  info "Building p2p engine bundle..."
  ( cd "$ROOT/services/p2p-engine" && npm run build >/dev/null 2>&1 && npm run bundle >/dev/null 2>&1 ) || fail "build/bundle p2p-engine failed"
  log "Engine bundle ready."
}

# Web app with the engine URL inlined; rebuild only when the URL changed.
build_web() {
  export EXPO_PUBLIC_P2P_ENGINE_URL="$P2P_ENGINE_URL"
  if [[ -f "$WEB_BUILD/index.html" && "$(cat "$WEB_BUILD/.p2p-url" 2>/dev/null)" == "$P2P_ENGINE_URL" ]]; then
    info "Web build already exists (P2P engine: $P2P_ENGINE_URL), skipping."
    return
  fi
  info "Building web app (P2P engine: $P2P_ENGINE_URL)..."
  ( cd "$ROOT/expo-app" && npm run web:build 2>&1 | tail -3 ) || fail "web:build failed"
  echo "$P2P_ENGINE_URL" > "$WEB_BUILD/.p2p-url"
  log "Web app built."
}

# ── capture + render ─────────────────────────────────────────────────────────

capture_guide() {
  require_bin node
  info "Capturing guide screenshots (PayPal rail)..."
  ( cd "$ROOT/e2e" && APP_URL="$APP_URL" E2E_P2P_ENGINE_URL="$P2P_ENGINE_URL" \
      CAPTURE_LANGS="${CAPTURE_LANGS:-en}" node capture-p2p-guide.mjs ) || fail "capture-p2p-guide failed"
  log "Guide screenshots captured."
}

capture_cny() {
  require_bin node
  info "Capturing CNY screenshots (WeChat/Alipay/bank)..."
  ( cd "$ROOT/e2e" && APP_URL="$APP_URL" E2E_P2P_ENGINE_URL="$P2P_ENGINE_URL" \
      node capture-p2p-cny.mjs ) || fail "capture-p2p-cny failed"
  log "CNY screenshots captured."
}

pdf_guide() {
  require_bin npx
  info "Rendering 12-language guide PDFs (scripts/docs-pdf.mts p2p)..."
  npx tsx scripts/docs-pdf.mts p2p || fail "docs-pdf failed"
  log "Guide PDFs → docs/p2p-demo/assets/p2p*.pdf"
}

pdf_cny() {
  require_bin node
  info "Rendering CNY walkthrough PDF..."
  node docs/p2p-demo/scripts/gen-p2p-cny-pdf.mjs || fail "gen-p2p-cny-pdf failed"
  log "CNY PDF → docs/p2p-demo/assets/p2p-cny.pdf"
}

# ── down ─────────────────────────────────────────────────────────────────────

down() {
  info "Stopping leftover local p2p engine / web server (if any)..."
  pkill -f "server.bundle.mjs" 2>/dev/null || true
  pkill -f "http-server.*web-build" 2>/dev/null || true
  log "Done."
}

# ── dispatch ─────────────────────────────────────────────────────────────────

CMD="${1:-pdf}"
TARGET="${2:-all}"

case "$CMD" in
  -h|--help|help|usage) usage ;;
  pdf)
    case "$TARGET" in
      guide) pdf_guide ;;
      cny)   pdf_cny ;;
      all)   pdf_guide; pdf_cny ;;
      *)     fail "unknown target '$TARGET' (use guide | cny | all)" ;;
    esac
    ;;
  capture)
    build_engine
    build_web
    case "$TARGET" in
      guide) capture_guide; pdf_guide ;;
      cny)   capture_cny; pdf_cny ;;
      all)   capture_guide; capture_cny; pdf_guide; pdf_cny ;;
      *)     fail "unknown target '$TARGET' (use guide | cny | all)" ;;
    esac
    ;;
  all)
    build_ws
    build_engine
    build_web
    capture_guide
    capture_cny
    pdf_guide
    pdf_cny
    ;;
  down|stop) down; exit 0 ;;
  e2e) "$ROOT/e2e/e2etest.sh" p2p-demo; exit 0 ;;
  *) fail "unknown command '$CMD' — run ./p2pdemo.sh --help" ;;
esac

log "Done. PDFs in docs/p2p-demo/assets (publish with scripts/docs-upload.sh)."
