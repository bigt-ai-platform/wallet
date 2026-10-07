import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3000";
const DIR = "demo-output/screenshots";
mkdirSync(DIR, { recursive: true });

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Francais" },
  { code: "es", label: "Espanol" },
  { code: "ja", label: "日本語" },
];

const browser = await chromium.launch({ headless: true });

for (const lang of LANGUAGES) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  // Set language via localStorage
  await page.goto(`${BASE_URL}/about`);
  await page.evaluate((lng) => {
    localStorage.setItem("i18nextLng", lng);
  }, lang.code);
  await page.reload();
  await page.waitForTimeout(500);

  // Capture dashboard
  await page.goto(`${BASE_URL}/p2p`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${DIR}/p2p-dashboard-${lang.code}.png`, fullPage: true });
  console.log(`✓ p2p-dashboard-${lang.code}.png (${lang.label})`);

  // Capture history
  await page.goto(`${BASE_URL}/p2p/history`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${DIR}/p2p-history-${lang.code}.png`, fullPage: true });
  console.log(`✓ p2p-history-${lang.code}.png (${lang.label})`);

  await page.close();
}

await browser.close();
console.log("All screenshots captured");
