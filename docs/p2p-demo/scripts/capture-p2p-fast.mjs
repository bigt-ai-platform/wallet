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
  return new Promise((resolve) => {
    const opts = { hostname: "127.0.0.1", port: 3000, path: "/api/p2p" + path, method, headers: body ? { "Content-Type": "application/json" } : {}, timeout: 10000 };
    const req = http.request(opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on("error", () => resolve({}));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function seed() {
  const o1 = await api("POST", "/orders", {
    type: "limit_sell", sellerDid: db, giveToken: "USDT", giveAmount: "100", giveChain: "ethereum",
    wantCurrency: "USD", wantAmount: "101", wantRail: "paypal",
    validUntil: Math.floor(Date.now() / 1000) + 3600,
    signature: sign({ sellerDid: db, giveToken: "USDT", giveAmount: "100", giveChain: "ethereum", wantCurrency: "USD", wantAmount: "101", wantRail: "paypal" }, pb),
  });
  const oid = o1.orderId;
  const m1 = await api("POST", "/orders/" + oid + "/match", {
    buyerDid: da, amount: "100", receiveAddress: "0xAlice", paypalAccount: "alice@email.com",
    signature: sign({ orderId: oid, buyerDid: da, amount: "100" }, pa),
  });
  const sid = m1.swapId;
  await api("POST", "/swaps/" + sid + "/transitions", { action: "escrow_lock", txHash: "0xabc", signature: sign({ swapId: sid, action: "escrow_lock", txHash: "0xabc" }, pb) });
  await api("POST", "/payments/send", { swapId: sid, paypalTxRef: "PAY-DEMO", amount: "101", currency: "USD", signature: sign({ swapId: sid, paypalTxRef: "PAY-DEMO", amount: "101", currency: "USD" }, pa) });
  await api("POST", "/swaps/" + sid + "/transitions", { action: "verify", signature: sign({ swapId: sid, action: "verify" }, pa) });
  await api("POST", "/swaps/" + sid + "/transitions", { action: "release", txHash: "0xdef", signature: sign({ swapId: sid, action: "release", txHash: "0xdef" }, pa) });
  await api("POST", "/swaps/" + sid + "/transitions", { action: "payout", payoutRef: "PO-DEMO", signature: sign({ swapId: sid, action: "payout", payoutRef: "PO-DEMO" }, pa) });

  // Expired
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

  // Pending
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
  console.log("✓ Seeded");
}

async function capture() {
  const browser = await chromium.launch({ headless: true });

  for (const lang of LANGUAGES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    // Set language
    await page.goto(BASE + "/about");
    await page.evaluate((l) => localStorage.setItem("i18nextLng", l), lang);
    await page.reload();
    await page.waitForTimeout(300);

    // Dashboard
    await page.goto(BASE + "/p2p");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.screenshot({ path: DIR + "/p2p-dashboard-" + lang + ".png", fullPage: true });
    console.log("✓ p2p-dashboard-" + lang + ".png");

    // History
    await page.goto(BASE + "/p2p/history");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: DIR + "/p2p-history-" + lang + ".png", fullPage: true });
    console.log("✓ p2p-history-" + lang + ".png");

    await page.close();
  }

  await browser.close();
}

// Check server is alive first
try {
  await new Promise((resolve, reject) => {
    const req = http.get(BASE + "/api/p2p/swaps", (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
  console.log("Server alive, skipping seed");
} catch {
  console.log("Server down, can't capture");
  process.exit(1);
}

await seed();
await capture();
console.log("Done");
