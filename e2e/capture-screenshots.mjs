/**
 * Capture UI screenshots for all screens in the bapp wallet.
 * Usage: node capture-screenshots.mjs
 * Environment: BASE_URL (default: http://localhost:8081), HEADLESS (default: true)
 */

import { chromium } from "playwright";
import { mkdirSync, existsSync, writeFileSync } from "fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:8081";
const HEADLESS = process.env.HEADLESS !== "false";
const DIR = "demo-output/screenshots";

const SHOTS = [
  { topic: "wallet", name: "transaction-locked", url: "/", desc: "Transaction screen (locked)" },
  { topic: "wallet", name: "wallet-locked", url: "/wallet", desc: "Wallet screen (locked)" },
  { topic: "wallet", name: "market", url: "/market", desc: "Market prices" },
  { topic: "wallet", name: "tokens", url: "/tokens", desc: "Token browser" },
  { topic: "wallet", name: "tokens-create", url: "/tokens", desc: "Token creation", tab: "Create" },
  { topic: "wallet", name: "settings", url: "/settings", desc: "Settings" },
  { topic: "wallet", name: "wallet-keys", url: "/wallet/keys", desc: "Wallet keys management" },
];

const LANGUAGES = ["en", "zh", "de", "fr", "es", "ja"];

async function captureOne(browser, lang, shot) {
  const filename = `${shot.topic}-${shot.name}-${lang}.png`;
  const filepath = `${DIR}/${filename}`;
  if (existsSync(filepath)) return `skip ${filename}`;

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: lang === "en" ? "en-US" : lang,
  });
  const page = await context.newPage();

  try {
    await page.goto(`${BASE_URL}${shot.url}`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(2000);

    // Click tab if specified
    if (shot.tab) {
      const tab = page.getByText(shot.tab).first();
      if (await tab.isVisible().catch(() => false)) await tab.click();
      await page.waitForTimeout(1000);
    }

    await page.screenshot({ path: filepath, fullPage: false });
    return `ok ${filename}`;
  } catch (e) {
    return `err ${filename} ${e.message.slice(0, 80)}`;
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const browser = await chromium.launch({ headless: HEADLESS });

  const results = [];
  for (const lang of LANGUAGES) {
    for (const shot of SHOTS) {
      const r = await captureOne(browser, lang, shot);
      results.push(r);
      console.log(r);
    }
  }

  await browser.close();

  const ok = results.filter(r => r.startsWith("ok")).length;
  const err = results.filter(r => r.startsWith("err")).length;
  const skip = results.filter(r => r.startsWith("skip")).length;
  console.log(`\nDone: ${ok} captured, ${skip} skipped, ${err} errors`);
}

main().catch(console.error);
