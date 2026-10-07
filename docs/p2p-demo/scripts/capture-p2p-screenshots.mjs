import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const DIR = "demo-output/screenshots";
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Dashboard with swaps
await page.goto(`${BASE_URL}/p2p`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DIR}/p2p-dashboard.png`, fullPage: true });
console.log("✓ p2p-dashboard.png");

// History page
await page.goto(`${BASE_URL}/p2p/history`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DIR}/p2p-history.png`, fullPage: true });
console.log("✓ p2p-history.png");

// Also capture swap detail if any swap exists
const res = await page.request.get(`${BASE_URL}/api/p2p/swaps`);
const swaps = await res.json();
if (Array.isArray(swaps) && swaps.length > 0) {
  const swapId = swaps[0].swapId;
  await page.goto(`${BASE_URL}/p2p/swap/${swapId}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${DIR}/p2p-swap-detail.png`, fullPage: true });
  console.log("✓ p2p-swap-detail.png");
}

await browser.close();
console.log("Done");
