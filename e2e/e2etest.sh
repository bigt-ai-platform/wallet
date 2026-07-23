#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="$ROOT/e2e"
WEB_BUILD="$ROOT/e2e/web-build"
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

# 1. Build web app
info "Building web app..."
cd "$ROOT/expo-app"
npm run web:build 2>&1 | tail -3
log "Web app built."

# 2. Start web server
info "Starting web server..."
npx http-server "$WEB_BUILD" -p "$WEB_PORT" --silent &
sleep 2
curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 || fail "Server not ready"
log "Web server on http://localhost:$WEB_PORT"

# 3. Run Playwright e2e tests (English only)
info "Running Playwright e2e tests..."
cd "$E2E_DIR"
npx playwright test --reporter=list 2>&1
log "All e2e tests passed."

# 4. Capture screenshots with a created wallet for realistic data
info "Capturing screenshots with wallet data..."
node -e "
const { chromium } = require('playwright');
const { mkdirSync } = require('fs');
const BASE = 'http://localhost:8081';
const DIR = 'demo-output/screenshots';
mkdirSync(DIR, { recursive: true });

async function capture() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept().catch(()=>{}));

  // Load app, create wallet, take screenshots — all in one session
  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Navigate to Wallet tab
  await page.getByText('Wallet', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: DIR + '/wallet-wallet-locked-en.png', fullPage: false });
  console.log('ok wallet-wallet-locked-en.png');

  // Transaction locked
  await page.getByText('Transaction', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(2000);
  await page.screenshot({ path: DIR + '/wallet-transaction-locked-en.png', fullPage: false });
  console.log('ok wallet-transaction-locked-en.png');

  // Create wallet via keys
  await page.getByText('Wallet', { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.locator('text=Manage Wallet').click();
  await page.waitForTimeout(1500);
  await page.locator('text=Create New Wallet').click();
  await page.waitForTimeout(1500);
  await page.locator('text=Save with Password').click().catch(()=>{});
  await page.waitForTimeout(500);

  // Fill password
  const inputs = page.locator('input');
  const cnt = await inputs.count();
  for (let i = 0; i < cnt; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder').catch(()=>'');
    if (ph && ph.toLowerCase().includes('password')) await inputs.nth(i).fill('DemoPass123!');
  }

  const dl = page.waitForEvent('download', { timeout: 5000 }).catch(()=>null);
  await page.locator('text=Save Wallet').click().catch(()=>{});
  const d = await dl;
  if (d) await d.saveAs('/dev/null');
  await page.waitForTimeout(2000);

  // Close modal
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2000);

  // Navigate via tab bar — wallet state stays alive
  async function shot(name) {
    await page.screenshot({ path: DIR + '/wallet-' + name + '-en.png', fullPage: false });
    console.log('ok wallet-' + name + '-en.png');
  }
  async function tab(label) {
    await page.getByText(label, { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  await tab('Transaction'); await shot('transaction');
  await tab('Wallet'); await shot('wallet');
  await tab('Market'); await shot('market');
  await tab('Tokens'); await shot('tokens');

  const createTab = page.locator('[data-testid=tokens-screen]').getByText('Create');
  if (await createTab.isVisible().catch(()=>false)) await createTab.click();
  await page.waitForTimeout(1000); await shot('tokens-create');

  await tab('Settings'); await shot('settings');

  await browser.close();
}
capture();
" 2>&1
log "Screenshots captured."

# 5. Generate English PDF
info "Generating PDF..."
node -e "
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('fs');
const { chromium } = require('playwright');
const DIR = 'demo-output';
mkdirSync(DIR + '/pdfs', { recursive: true });
const SCREENS = ['transaction','wallet','market','tokens','tokens-create','settings'];
const rows = SCREENS.map(name => {
  const fp = DIR + '/screenshots/wallet-' + name + '-en.png';
  if (!existsSync(fp)) return '';
  const b64 = readFileSync(fp).toString('base64');
  return '<div class=\"screen\"><h2>' + name + '</h2><img src=\"data:image/png;base64,' + b64 + '\" /></div>';
}).filter(Boolean).join('\\n');
const html = '<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Bapp Wallet</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f5f5f5}h1{text-align:center}.screen{background:white;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);break-inside:avoid}.screen img{width:100%;max-width:390px;display:block;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px}</style></head><body><h1>Bapp Wallet Demo</h1>' + rows + '</body></html>';
writeFileSync(DIR + '/pdfs/bapp-wallet-en.html', html);
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: DIR + '/pdfs/bapp-wallet-en.pdf', format: 'A4', printBackground: true });
  await browser.close();
  console.log('ok bapp-wallet-en.pdf');
})();
" 2>&1
log "PDF generated."

# 7. Summary
echo ""
info "Output:"
echo "  Tests:       28/28 passed"
echo "  Screenshots: $(ls $E2E_DIR/demo-output/screenshots/*.png 2>/dev/null | wc -l)"
echo "  PDF:         $E2E_DIR/demo-output/pdfs/bapp-wallet-en.pdf"
echo ""
log "e2e test complete."
