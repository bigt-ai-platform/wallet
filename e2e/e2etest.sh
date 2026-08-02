#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
E2E_DIR="$ROOT/e2e"
WEB_BUILD="$ROOT/e2e/web-build"
WEB_PORT="${WEB_PORT:-18081}"
SERVER_PORT="${SERVER_PORT:-18088}"
L1_PORT="${L1_PORT:-18086}"

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

info "Checking infrastructure..."
curl -sf "http://localhost:${SERVER_PORT}/" >/dev/null 2>&1 || fail "Infra not ready — run ./e2e/infra.sh first"
log "Infrastructure ready."

# 1. Build web app
if [[ ! -d "$WEB_BUILD" ]]; then
  info "Building web app..."
  cd "$ROOT/expo-app"
  npm run web:build 2>&1 | tail -3
  log "Web app built."
else
  info "Web build already exists, skipping build."
fi

# 3. Start web server
info "Starting web server..."
npx http-server "$WEB_BUILD" -p "$WEB_PORT" --silent &
sleep 2
curl -sf "http://localhost:$WEB_PORT/" >/dev/null 2>&1 || fail "Web server not ready"
log "Web server on http://localhost:$WEB_PORT"

# 4. Run Playwright payment test
info "Running payment transaction test..."
cd "$E2E_DIR"
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
  npx playwright test --reporter=list --grep "Payment" 2>&1
log "Payment test passed."

# 4b. Run payment & order tracking tests
info "Running payment & order tracking tests..."
E2E_SERVER_URL="http://localhost:${SERVER_PORT}/" \
E2E_L1_URL="http://localhost:${L1_PORT}/" \
  npx playwright test --reporter=list --grep "Tracking" 2>&1
log "Tracking tests passed."

# 5. Capture payment flow screenshots and generate PDF
info "Capturing payment flow screenshots..."
OUT_DIR="$E2E_DIR/demo-output"
mkdir -p "$OUT_DIR/screenshots" "$OUT_DIR/pdfs"

node -e "
const { chromium } = require('playwright');
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('fs');

const BASE = 'http://localhost:8081';
const SVR = 'http://localhost:${SERVER_PORT}/';
const DIR = '$OUT_DIR/screenshots';
const PWD = 'AlicePass123!';
const FUND = 10000000000;

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);

  // Screenshot 1: Transaction screen locked (no wallet)
  await page.screenshot({ path: DIR + '/01-transaction-locked.png' });
  console.log('ok 01-transaction-locked');

  // Go to Wallet → Keys → Create wallet
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.locator('[data-testid=\"wallet-screen\"]').getByText('Manage Wallet').click();
  await page.waitForURL('**/wallet/keys**');
  await page.getByText('Create New Wallet').click();
  await page.waitForTimeout(2000);

  // Get the address and fund it via API
  const addressEl = page.locator('text=/^[0-9a-f]{70}$/').first();
  await addressEl.waitFor({ state: 'attached', timeout: 10000 });
  const address = (await addressEl.textContent()).trim();
  await fetch(SVR + 'fundAddresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addresses: [{ address, value: FUND }] }),
  });

  // Save wallet with password (handle download + dialog)
  await page.getByText('Save with Password').click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder('Enter password (min 6 characters)').fill(PWD);
  await page.getByPlaceholder('Confirm password').fill(PWD);
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.getByText('Save Wallet').click(),
  ]);
  if (dl) await dl.saveAs('/dev/null');
  const dlg = await page.waitForEvent('dialog', { timeout: 10000 }).catch(() => null);
  if (dlg) await dlg.accept();
  await page.waitForTimeout(1000);

  // Reload, set server URL, then unlock
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Configure server URL so token list loads from local preprod
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.locator('[data-testid=\"server-url-input\"]').fill('');
  await page.locator('[data-testid=\"server-url-input\"]').fill(SVR);
  await page.locator('[data-testid=\"l1-url-input\"]').fill('');
  await page.locator('[data-testid=\"l1-url-input\"]').fill(SVR);
  await page.locator('text=Save').first().click();
  await page.waitForTimeout(1000);

  // Go to Transaction and unlock
  await page.getByRole('tab', { name: 'Transaction', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder('Enter wallet password').fill(PWD);
  await page.getByText('Unlock Wallet').click();
  await page.waitForTimeout(5000);

  // Wait for BIG token to load and auto-select
  await page.waitForTimeout(3000);

  // Screenshot 2: Transaction screen unlocked with send form and BIG token selected
  await page.screenshot({ path: DIR + '/02-transaction-unlocked.png' });
  console.log('ok 02-transaction-unlocked');

  // Go to Wallet to see balance
  await page.getByRole('tab', { name: 'Wallet', exact: true }).click();
  await page.waitForTimeout(3000);

  // Screenshot 3: Wallet screen with BIG balance
  await page.screenshot({ path: DIR + '/03-wallet-balance.png' });
  console.log('ok 03-wallet-balance');

  // Go to Transaction, fill send form
  await page.getByRole('tab', { name: 'Transaction', exact: true }).click();
  await page.waitForTimeout(2000);
  await page.getByPlaceholder('Recipient').fill('1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm');
  await page.getByPlaceholder('0.00').first().fill('0.001');

  // Screenshot 4: Send form filled with BIG token selected
  await page.screenshot({ path: DIR + '/04-send-form-filled.png' });
  console.log('ok 04-send-form-filled');

  // Click send, accept confirmation, handle result
  await page.locator('text=Send Payment').first().click();
  await page.waitForTimeout(2000);
  await page.locator('text=Send').last().click();
  await page.waitForTimeout(5000);
  const resultDlg = await page.waitForEvent('dialog', { timeout: 20000 }).catch(() => null);
  if (resultDlg) await resultDlg.accept();
  await page.waitForTimeout(2000);

  // Screenshot 5: Transaction history
  await page.locator('text=History').first().click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: DIR + '/05-transaction-history.png' });
  console.log('ok 05-transaction-history');

  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
" 2>&1

log "Screenshots captured."

# 6. Generate PDF
info "Generating payment flow PDF..."
node -e "
const { readFileSync, writeFileSync, existsSync } = require('fs');
const { chromium } = require('playwright');

const DIR = '$OUT_DIR';
const SCREENS = ['01-transaction-locked','02-transaction-unlocked','03-wallet-balance','04-send-form-filled','05-transaction-history'];
const LABELS = ['Transaction (Locked)', 'Transaction (Unlocked)', 'Wallet with BIG Balance', 'Send Form Filled (BIG)', 'Transaction History'];

const rows = SCREENS.map((name, i) => {
  const fp = DIR + '/screenshots/' + name + '.png';
  if (!existsSync(fp)) return '';
  const b64 = readFileSync(fp).toString('base64');
  return '<div class=\"screen\"><h2>' + LABELS[i] + '</h2><img src=\"data:image/png;base64,' + b64 + '\" /></div>';
}).filter(Boolean).join('\\n');

const html = '<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Bapp Payment Flow</title><style>body{font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;background:#f5f5f5}h1{text-align:center}.screen{background:white;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);break-inside:avoid}.screen img{width:100%;max-width:390px;display:block;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px}</style></head><body><h1>Bapp Wallet - Payment Flow</h1>' + rows + '</body></html>';
writeFileSync(DIR + '/pdfs/payment-flow.html', html);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({ path: DIR + '/pdfs/payment-flow.pdf', format: 'A4', printBackground: true });
  await browser.close();
  console.log('ok payment-flow.pdf');
})();
" 2>&1
log "PDF generated: demo-output/pdfs/payment-flow.pdf"
