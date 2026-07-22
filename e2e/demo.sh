#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="$ROOT/e2e"
WEB_BUILD="$E2E_DIR/web-build"
WEB_PORT="${WEB_PORT:-8081}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[OK]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }
info()  { echo -e "${YELLOW}[INFO]${NC} $1"; }

cleanup() {
  info "Cleaning up..."
  pkill -f "http-server.*web-build" 2>/dev/null || true
  log "Done."
}
trap cleanup EXIT

# Build web app
info "Building web app..."
cd "$ROOT/expo-app"
npm run web:build 2>&1 | tail -3
log "Web app built."

# Start web server
info "Starting web server..."
npx http-server "$WEB_BUILD" -p "$WEB_PORT" --silent &
SERVER_PID=$!
sleep 2
curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 || fail "Server not ready"
log "Web server on http://localhost:$WEB_PORT"

# Capture screenshots
info "Capturing screenshots in 6 languages..."
cd "$E2E_DIR"
node capture-screenshots.mjs 2>&1 | tail -3
log "Screenshots captured."

# Generate PDFs
info "Generating PDF demo guides..."
node generate-pdfs.mjs 2>&1
log "PDFs generated."

# Summary
echo ""
info "Output:"
echo "  Screenshots: $E2E_DIR/demo-output/screenshots/ ($(ls $E2E_DIR/demo-output/screenshots/*.png 2>/dev/null | wc -l) files)"
echo "  PDFs:       $E2E_DIR/demo-output/pdfs/ ($(ls $E2E_DIR/demo-output/pdfs/*.pdf 2>/dev/null | wc -l) files)"
echo ""
log "Demo generation complete."
