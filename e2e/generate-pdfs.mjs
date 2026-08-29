/**
 * Generate PDF demo guides from captured screenshots.
 * Usage: node generate-pdfs.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { chromium } from "playwright";

const SCREENSHOT_DIR = "demo-output/screenshots";
const OUTPUT_DIR = "demo-output/pdfs";

const LANGUAGES = [
  { code: "en", name: "English", attr: "en" },
  { code: "zh", name: "中文", attr: "zh-CN" },
  { code: "de", name: "Deutsch", attr: "de" },
  { code: "fr", name: "Français", attr: "fr" },
  { code: "es", name: "Español", attr: "es" },
  { code: "ja", name: "日本語", attr: "ja" },
];

const LABELS = {
  en: { title: "Bapp Wallet Demo", desc: "Wallet screens and features", transaction: "Transaction", wallet: "Wallet", market: "Market", tokens: "Tokens", settings: "Settings", locked: "Locked State", create: "Token Creation", keys: "Keys Management" },
  zh: { title: "Bapp 钱包演示", desc: "钱包界面和功能", transaction: "交易", wallet: "钱包", market: "市场", tokens: "代币", settings: "设置", locked: "锁定状态", create: "创建代币", keys: "密钥管理" },
  de: { title: "Bapp Wallet Demo", desc: "Wallet-Bildschirme und Funktionen", transaction: "Transaktion", wallet: "Geldbörse", market: "Markt", tokens: "Token", settings: "Einstellungen", locked: "Gesperrt", create: "Token-Erstellung", keys: "Schlüsselverwaltung" },
  fr: { title: "Démo Bapp Wallet", desc: "Écrans et fonctionnalités", transaction: "Transaction", wallet: "Portefeuille", market: "Marché", tokens: "Jetons", settings: "Paramètres", locked: "Verrouillé", create: "Création de jeton", keys: "Gestion des clés" },
  es: { title: "Demo Bapp Wallet", desc: "Pantallas y funciones", transaction: "Transacción", wallet: "Billetera", market: "Mercado", tokens: "Tokens", settings: "Ajustes", locked: "Bloqueado", create: "Crear token", keys: "Gestión de claves" },
  ja: { title: "Bapp ウォレットデモ", desc: "ウォレットの画面と機能", transaction: "取引", wallet: "ウォレット", market: "マーケット", tokens: "トークン", settings: "設定", locked: "ロック中", create: "トークン作成", keys: "キー管理" },
};

const SCREENS = [
  { key: "transaction-locked", labelKey: "transaction", extra: "locked" },
  { key: "wallet-locked", labelKey: "wallet", extra: "locked" },
  { key: "market", labelKey: "market" },
  { key: "tokens", labelKey: "tokens" },
  { key: "tokens-create", labelKey: "tokens", extra: "create" },
  { key: "settings", labelKey: "settings" },
  { key: "wallet-keys", labelKey: "wallet", extra: "keys" },
];

function imgToBase64(filepath) {
  if (!existsSync(filepath)) return null;
  const data = readFileSync(filepath).toString("base64");
  return `data:image/png;base64,${data}`;
}

function buildHtml(lang) {
  const labels = LABELS[lang.code] || LABELS.en;
  const rows = SCREENS.map(s => {
    const fp = `${SCREENSHOT_DIR}/wallet-${s.key}-${lang.code}.png`;
    const b64 = imgToBase64(fp);
    if (!b64) return "";
    const extraLabel = s.extra ? ` — ${labels[s.extra] || s.extra}` : "";
    return `<div class="screen">
      <h2>${labels[s.labelKey]}${extraLabel}</h2>
      <img src="${b64}" />
    </div>`;
  }).filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="${lang.attr}">
<head>
<meta charset="utf-8">
<title>${labels.title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
  h1 { text-align: center; color: #333; margin-bottom: 4px; }
  .desc { text-align: center; color: #666; margin-bottom: 24px; }
  .screen { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);
            margin-bottom: 20px; padding: 16px; break-inside: avoid; }
  .screen h2 { font-size: 16px; color: #333; margin: 0 0 12px 0; }
  .screen img { width: 100%; max-width: 390px; display: block; margin: 0 auto;
                border: 1px solid #e0e0e0; border-radius: 8px; }
</style>
</head>
<body>
  <h1>${labels.title}</h1>
  <p class="desc">${labels.desc}</p>
  ${rows}
</body>
</html>`;
}

async function main() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  for (const lang of LANGUAGES) {
    const html = buildHtml(lang);
    if (!html.includes("<img")) {
      console.log(`skip ${lang.code} (no screenshots)`);
      continue;
    }
    const htmlPath = `${OUTPUT_DIR}/wallet-${lang.code}.html`;
    writeFileSync(htmlPath, html);

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdfPath = `${OUTPUT_DIR}/wallet-${lang.code}.pdf`;
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    await page.close();
    console.log(`ok wallet-${lang.code}.pdf`);
  }

  await browser.close();
}

main().catch(console.error);
