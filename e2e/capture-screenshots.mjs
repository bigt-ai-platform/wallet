/**
 * Capture UI screenshots for all screens in the bapp wallet, in each supported
 * language.
 * Usage: node capture-screenshots.mjs
 * Environment: BASE_URL (default: http://localhost:8081), HEADLESS (default: true)
 *
 * The static web build is an SPA with no server-side route fallback, so every
 * capture starts at "/" and navigates through the app's own tab UI. Navigation
 * happens while the app is in its default (English) language, then the active
 * language is switched before the screenshot, and the destination is verified
 * via a stable testID so a failed navigation is reported instead of silently
 * capturing the wrong screen.
 */

import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE_URL = process.env.BASE_URL || "http://localhost:8081";
const HEADLESS = process.env.HEADLESS !== "false";
const DIR = "demo-output/screenshots";

const SHOTS = [
  { topic: "wallet", name: "transaction-locked", tab: null, verify: "transaction-screen", desc: "Transaction screen (locked)" },
  { topic: "wallet", name: "wallet-locked", tab: "Wallet", verify: "wallet-screen", desc: "Wallet screen (locked)" },
  { topic: "wallet", name: "market", tab: "Order", verify: "order-screen", desc: "Market prices" },
  { topic: "wallet", name: "tokens", tab: "Tokens", verify: "tokens-screen", desc: "Token browser" },
  { topic: "wallet", name: "settings", tab: "Settings", verify: "settings-screen", desc: "Settings" },
  { topic: "wallet", name: "wallet-keys", tab: "Wallet", verify: "wallet-screen", desc: "Wallet keys management" },
];

const LANGUAGES = ["en", "zh", "de", "fr", "es", "ja"];

async function captureOne(browser, lang, shot) {
  const filename = `${shot.topic}-${shot.name}-${lang}.png`;
  const filepath = `${DIR}/${filename}`;

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();

  try {
    await page.goto(BASE_URL + "/", { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(2500);

    // Navigate in the app's default language, then switch before capture.
    if (shot.tab) {
      const tab = page.getByRole("tab", { name: shot.tab, exact: true }).first();
      if (!(await tab.isVisible().catch(() => false))) {
        return `err ${filename} tab "${shot.tab}" not visible`;
      }
      await tab.click();
      await page.waitForTimeout(2000);
    }

    // Wallet keys is a modal pushed from the Wallet screen.
    if (shot.name === "wallet-keys") {
      const manage = page.getByText("Manage Wallet").first();
      if (!(await manage.isVisible().catch(() => false))) {
        return `err ${filename} "Manage Wallet" not visible`;
      }
      await manage.click();
      await page.waitForTimeout(2000);
    }

    // Fail loudly if the expected destination screen was not reached.
    if (shot.name === "wallet-keys") {
      if (!page.url().includes("/wallet/keys")) {
        return `err ${filename} keys screen not reached (url ${page.url()})`;
      }
    } else {
      const destination = page.locator(`[data-testid="${shot.verify}"]`).first();
      if (!(await destination.isVisible().catch(() => false))) {
        return `err ${filename} destination screen ${shot.verify} not reached`;
      }
    }

    // Switch the app's active language explicitly (browser locale does not
    // drive the app's i18n). The bundle exposes i18n on globalThis.
    await page.evaluate((code) => {
      if (globalThis.__bigtangleI18n) {
        globalThis.__bigtangleI18n.changeLanguage(code);
      }
    }, lang);
    await page.waitForTimeout(1000);

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

  const ok = results.filter((r) => r.startsWith("ok")).length;
  const err = results.filter((r) => r.startsWith("err")).length;
  console.log(`\nDone: ${ok} captured, ${err} errors`);
}

main().catch(console.error);
