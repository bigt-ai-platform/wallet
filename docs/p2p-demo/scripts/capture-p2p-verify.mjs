import http from "http";
import crypto from "crypto";
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://127.0.0.1:3000";
const DIR = "demo-output/screenshots";
mkdirSync(DIR, { recursive: true });

const H = Buffer.from("302e020100300506032b657004220420", "hex");
const da = "did:key:z6MknoyoFp4JYE27RNqXkPSXekZX6iitDamvB3ZJ3R1Nfatn";
const pa = "17783496c8618f6815638258f589ef1efb97aa381c833fc703545d07cf633585";
const db = "did:key:z6Mku1ML6sB2Ykj5n79zFwRbJy8Hifv1HyfkV8g7efugYyeS";
const pb = "ad41a6d3180a9834d99c64329f506f3b51332c4bb43c734ddf14baf5322fec91";
const LANGUAGES = ["en", "zh", "de", "fr", "es", "ja"];

function sign(p, k) {
  const key = crypto.createPrivateKey({ key: Buffer.concat([H, Buffer.from(k, "hex")]), format: "der", type: "pkcs8" });
  return crypto.sign(null, Buffer.from(JSON.stringify(p, Object.keys(p).sort()), "utf8"), key).toString("hex");
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: "127.0.0.1", port: 3000, path: "/api/p2p" + path, method, headers: body ? { "Content-Type": "application/json" } : {}, timeout: 10000 };
    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error("Invalid JSON: " + d.substring(0, 100))); } });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function seed() {
  console.log("Seeding data...");
  const o1 = await api("POST", "/orders", {
    type: "limit_sell", sellerDid: db, giveToken: "USDT", giveAmount: "100", giveChain: "ethereum",
    wantCurrency: "USD", wantAmount: "101", wantRail: "paypal",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
    signature: sign({ sellerDid: db, giveToken: "USDT", giveAmount: "100", giveChain: "ethereum", wantCurrency: "USD", wantAmount: "101", wantRail: "paypal" }, pb),
  });
  if (!o1.orderId) throw new Error("Seed failed: " + JSON.stringify(o1));
  const oid = o1.orderId;

  const m1 = await api("POST", "/orders/" + oid + "/match", {
    buyerDid: da, amount: "100", receiveAddress: "0xAlice", paypalAccount: "alice@email.com",
    signature: sign({ orderId: oid, buyerDid: da, amount: "100" }, pa),
  });
  if (!m1.swapId) throw new Error("Match failed: " + JSON.stringify(m1));
  const sid = m1.swapId;

  await api("POST", "/swaps/" + sid + "/transitions", { action: "escrow_lock", txHash: "0xabc", signature: sign({ swapId: sid, action: "escrow_lock", txHash: "0xabc" }, pb) });
  await api("POST", "/payments/send", { swapId: sid, paypalTxRef: "PAY-DEMO", amount: "101", currency: "USD", signature: sign({ swapId: sid, paypalTxRef: "PAY-DEMO", amount: "101", currency: "USD" }, pa) });
  await api("POST", "/swaps/" + sid + "/transitions", { action: "verify", signature: sign({ swapId: sid, action: "verify" }, pa) });
  await api("POST", "/swaps/" + sid + "/transitions", { action: "release", txHash: "0xdef", signature: sign({ swapId: sid, action: "release", txHash: "0xdef" }, pa) });
  await api("POST", "/swaps/" + sid + "/transitions", { action: "payout", payoutRef: "PO-DEMO", signature: sign({ swapId: sid, action: "payout", payoutRef: "PO-DEMO" }, pa) });

  // Expired swap
  const o2 = await api("POST", "/orders", {
    type: "limit_sell", sellerDid: da, giveToken: "USDT", giveAmount: "50", giveChain: "ethereum",
    wantCurrency: "USD", wantAmount: "50.5", wantRail: "paypal",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
    signature: sign({ sellerDid: da, giveToken: "USDT", giveAmount: "50", giveChain: "ethereum", wantCurrency: "USD", wantAmount: "50.5", wantRail: "paypal" }, pa),
  });
  const oid2 = o2.orderId;
  const m2 = await api("POST", "/orders/" + oid2 + "/match", {
    buyerDid: db, amount: "50", receiveAddress: "0xBob", paypalAccount: "bob@email.com",
    signature: sign({ orderId: oid2, buyerDid: db, amount: "50" }, pb),
  });
  const sid2 = m2.swapId;
  await api("POST", "/swaps/" + sid2 + "/transitions", { action: "escrow_lock", txHash: "0xex", signature: sign({ swapId: sid2, action: "escrow_lock", txHash: "0xex" }, pa) });
  await api("POST", "/swaps/" + sid2 + "/transitions", { action: "expire", signature: sign({ swapId: sid2, action: "expire" }, pa) });

  // Pending swap
  const o3 = await api("POST", "/orders", {
    type: "limit_sell", sellerDid: db, giveToken: "USDT", giveAmount: "200", giveChain: "ethereum",
    wantCurrency: "USD", wantAmount: "202", wantRail: "paypal",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
    signature: sign({ sellerDid: db, giveToken: "USDT", giveAmount: "200", giveChain: "ethereum", wantCurrency: "USD", wantAmount: "202", wantRail: "paypal" }, pb),
  });
  const oid3 = o3.orderId;
  await api("POST", "/orders/" + oid3 + "/match", {
    buyerDid: da, amount: "200", receiveAddress: "0xAlice", paypalAccount: "alice@email.com",
    signature: sign({ orderId: oid3, buyerDid: da, amount: "200" }, pa),
  });

  // Verify data exists
  const swaps = await api("GET", "/swaps");
  if (!Array.isArray(swaps) || swaps.length < 3) throw new Error("Expected 3+ swaps, got " + (swaps || []).length);
  console.log("✓ " + swaps.length + " swaps seeded");
}

async function capture() {
  const browser = await chromium.launch({ headless: true });

  for (const lang of LANGUAGES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Set language
    await page.goto(BASE + "/about", { waitUntil: "networkidle", timeout: 15000 });
    await page.evaluate((l) => localStorage.setItem("i18nextLng", l), lang);
    await page.reload({ waitUntil: "networkidle", timeout: 15000 });
    await page.waitForTimeout(500);

    // Capture dashboard — wait for data to load, verify no error
    await page.goto(BASE + "/p2p", { waitUntil: "networkidle", timeout: 20000 });
    // Wait for swap cards to appear (meaning API response rendered)
    try {
      await page.waitForFunction(() => {
        const text = document.body?.textContent || "";
        // Component rendered swap data (⇄ is the arrow between amounts)
        // or the empty state message appeared
        return text.includes("⇄") || text.includes("No active swaps") || text.includes("没有活跃") || text.includes("Keine aktiven") || text.includes("Aucun échange") || text.includes("Sin swaps") || text.includes("アクティブ");
      }, { timeout: 15000 });
    } catch {
      // Timeout — page may still be loading. Try waiting more.
      await page.waitForTimeout(5000);
    }
    // Final error check: look for React error boundaries, not Next.js stream data
    const finalContent = await page.textContent("body") || "";
    if (finalContent.includes("Application client error") || finalContent.includes("An unexpected error")) {
      console.error("FAIL: Dashboard error for " + lang);
      process.exit(1);
    }
    await page.screenshot({ path: DIR + "/p2p-dashboard-" + lang + ".png", fullPage: true });
    console.log("✓ p2p-dashboard-" + lang + ".png");

    // Capture history
    await page.goto(BASE + "/p2p/history", { waitUntil: "networkidle", timeout: 20000 });
    try {
      await page.waitForFunction(() => {
        const text = document.body?.textContent || "";
        return text.includes("⇄") || text.includes("No completed") || text.includes("还没有") || text.includes("Noch keine") || text.includes("Aucun échange terminé") || text.includes("Sin swaps completados") || text.includes("完了したスワップ");
      }, { timeout: 15000 });
    } catch {
      await page.waitForTimeout(5000);
    }
    const hc = await page.textContent("body") || "";
    if (hc.includes("Application client error") || hc.includes("An unexpected error")) {
      console.error("FAIL: History error for " + lang);
      process.exit(1);
    }
    await page.screenshot({ path: DIR + "/p2p-history-" + lang + ".png", fullPage: true });
    console.log("✓ p2p-history-" + lang + ".png");

    await page.close();
  }

  await browser.close();
}

// Main
try {
  // Verify server
  const swaps = await api("GET", "/swaps?limit=1").catch(() => null);
  if (!swaps) throw new Error("Server not reachable");
  console.log("Server OK, seeding...");
  await seed();
  console.log("Capturing screenshots...");
  await capture();
  console.log("All screenshots captured successfully");
} catch (e) {
  console.error("FAILED: " + e.message);
  process.exit(1);
}
