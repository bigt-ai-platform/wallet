import { readFileSync, mkdirSync, existsSync } from "fs";
import { extname } from "path";
import { marked } from "marked";
import { chromium } from "playwright";

const LANGUAGES = [
  { code: "en", file: "tests/demo/p2p.md", label: "English" },
  { code: "zh", file: "tests/demo/p2p.zh.md", label: "中文" },
];

const MIME_TYPES = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

function embedImages(html) {
  return html.replace(/<img\s+[^>]*src="([^"]+)"[^>]*>/gi, (match, src) => {
    if (src.startsWith("data:") || src.startsWith("http://") || src.startsWith("https://")) return match;
    if (!existsSync(src)) { console.warn(`  ⚠ Image not found: ${src}`); return match; }
    const mime = MIME_TYPES[extname(src).toLowerCase()] || "image/png";
    const data = readFileSync(src).toString("base64");
    console.log(`  ✓ ${src}`);
    return match.replace(`src="${src}"`, `src="data:${mime};base64,${data}"`);
  });
}

const ICON = `data:image/png;base64,${readFileSync("public/bigT_ai_192x192.png").toString("base64")}`;

const HTML_TEMPLATE = (bodyHtml, subtitle) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>P2P Settlement</title>
<style>
  @page { margin: 2cm; size: A4; @bottom-center { content: counter(page); font-size: 9pt; color: #94a3b8; } }
  @page :first { @bottom-center { content: none; } }
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; font-size: 10.5pt; line-height: 1.7; color: #1e293b; max-width: 210mm; margin: 0 auto; }
  .cover-page { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 90vh; page-break-after: always; text-align: center; }
  .cover-icon img { height: 100px; }
  .cover-page h1 { font-size: 28pt; font-weight: 700; color: #0f172a; border: none; margin: 0 0 0.3em; }
  .cover-divider { width: 60px; height: 3px; background: #2563eb; margin: 1em auto; border: none; border-radius: 2px; }
  .cover-meta { font-size: 8.5pt; color: #94a3b8; margin-top: 2.5em; }
  h2 { font-size: 16pt; color: #0f172a; border-bottom: 2px solid #2563eb; page-break-after: avoid; }
  h3 { font-size: 12pt; color: #1e293b; page-break-after: avoid; }
  pre { background: #1e1e2e; color: #cdd6f4; padding: 1em; border-radius: 8px; font-size: 8pt; page-break-inside: avoid; }
  code { background: #f1f5f9; padding: 0.15em 0.4em; border-radius: 4px; color: #2563eb; font-size: 8.5pt; }
  pre code { background: none; color: inherit; }
  img { max-width: 100%; border-radius: 8px; border: 1px solid #e2e8f0; margin: 1em 0; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th, td { border: 1px solid #e2e8f0; padding: 0.5em; }
  th { background: #2563eb; color: #fff; }
  p { margin: 0.6em 0; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2em 0; }
  blockquote { border-left: 4px solid #2563eb; padding: 0.75em 1em; background: #eff6ff; }
</style></head>
<body>${bodyHtml}</body>
</html>`;

const browser = await chromium.launch({ headless: true });

for (const lang of LANGUAGES) {
  let bodyHtml = await marked.parse(readFileSync(lang.file, "utf-8"));
  bodyHtml = embedImages(bodyHtml);
  bodyHtml = bodyHtml.replace("<h1>", `<div class="cover-page"><div class="cover-icon"><img src="${ICON}" alt=""></div><h1>`);
  bodyHtml = bodyHtml.replace("</h1>", `</h1><hr class="cover-divider"><p class="cover-meta">BigT.AI — P2P Settlement</p></div>`);

  const page = await browser.newPage();
  await page.setContent(HTML_TEMPLATE(bodyHtml, ""), { waitUntil: "networkidle" });
  mkdirSync("demo-output/public", { recursive: true });
  const outFile = lang.code === "en" ? "p2p.pdf" : `p2p.${lang.code}.pdf`;
  await page.pdf({ path: `demo-output/public/${outFile}`, format: "A4", printBackground: true });
  await page.close();
  console.log(`✓ ${outFile} (${lang.label})`);
}

await browser.close();
console.log("Done");
