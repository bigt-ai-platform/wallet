import { readFileSync, mkdirSync, existsSync } from "fs";
import { extname } from "path";
import { marked } from "marked";
import { chromium } from "playwright";

const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

function embedImages(html) {
  return html.replace(/<img\s+[^>]*src="([^"]+)"[^>]*>/gi, (match, src) => {
    if (src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) return match;
    if (!existsSync(src)) { console.warn(`  ⚠ Image not found: ${src}`); return match; }
    const ext = extname(src).toLowerCase();
    const mime = MIME_TYPES[ext] || "image/png";
    const data = readFileSync(src).toString("base64");
    console.log(`  ✓ Embedded: ${src}`);
    return match.replace(`src="${src}"`, `src="data:${mime};base64,${data}"`);
  });
}

const ICON_BASE64 = readFileSync("public/bigT_ai_192x192.png").toString("base64");
const ICON_DATA_URI = `data:image/png;base64,${ICON_BASE64}`;

const md = readFileSync("tests/demo/p2p.md", "utf-8");

let bodyHtml = await marked.parse(md);
bodyHtml = embedImages(bodyHtml);
bodyHtml = bodyHtml.replace(
  "<h1>",
  `<div class="cover-page"><div class="cover-icon"><img src="${ICON_DATA_URI}" alt=""></div><h1>`,
);
bodyHtml = bodyHtml.replace(
  "</h1>",
  '</h1><hr class="cover-divider"><p class="cover-meta">BigT.AI — P2P Settlement User Guide</p></div>',
);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>P2P Settlement</title>
<style>
  @page { margin: 2cm; size: A4; @bottom-center { content: counter(page); font-size: 9pt; color: #94a3b8; } }
  @page :first { @bottom-center { content: none; } }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; font-size: 10.5pt; line-height: 1.7; color: #1e293b; max-width: 210mm; margin: 0 auto; padding: 0; }
  .cover-page { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 90vh; page-break-after: always; text-align: center; padding: 2em; }
  .cover-icon img { height: 100px; width: auto; }
  .cover-page h1 { font-size: 28pt; font-weight: 700; color: #0f172a; border: none; margin: 0 0 0.3em; padding: 0; }
  .cover-divider { width: 60px; height: 3px; background: #2563eb; margin: 1em auto; border: none; border-radius: 2px; }
  .cover-meta { font-size: 8.5pt; color: #94a3b8; margin-top: 2.5em; }
  h2 { font-size: 16pt; font-weight: 700; color: #0f172a; border-bottom: 2px solid #2563eb; margin-top: 1.8em; page-break-after: avoid; }
  img { max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; margin: 1em 0; page-break-inside: avoid; }
  pre { background: #1e1e2e; color: #cdd6f4; padding: 1em 1.2em; border-radius: 8px; font-size: 8pt; overflow-x: auto; page-break-inside: avoid; }
  code { font-family: monospace; font-size: 8.5pt; background: #f1f5f9; padding: 0.15em 0.4em; border-radius: 4px; color: #2563eb; }
  pre code { background: none; padding: 0; color: inherit; }
  p { margin: 0.6em 0; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2em 0; }
  blockquote { border-left: 4px solid #2563eb; margin: 1em 0; padding: 0.75em 1em; background: #eff6ff; border-radius: 0 6px 6px 0; }
  strong { font-weight: 600; color: #0f172a; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: "networkidle" });
mkdirSync("demo-output/public", { recursive: true });
await page.pdf({ path: "demo-output/public/p2p.pdf", format: "A4", printBackground: true });
await page.close();
await browser.close();
console.log("✓ demo-output/public/p2p.pdf");
