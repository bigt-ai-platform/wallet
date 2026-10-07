import { readFileSync, mkdirSync, existsSync } from "fs";
import { extname } from "path";
import { marked } from "marked";
import { chromium } from "playwright";

const LANGUAGES = ["en", "zh", "de", "fr", "es", "ja"];
const LANG_CODES = { en: "EN", zh: "ZH", de: "DE", fr: "FR", es: "ES", ja: "JA" };
const MIME = { ".png": "image/png", ".svg": "image/svg+xml" };
const ICON =
  "data:image/png;base64," +
  readFileSync("public/bigT_ai_192x192.png").toString("base64");

function embedImages(html) {
  return html.replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, (m, src) => {
    if (src.startsWith("data:") || src.startsWith("http")) return m;
    if (!existsSync(src)) {
      console.warn("  Image not found: " + src);
      return m;
    }
    const ext = extname(src).toLowerCase();
    const data = readFileSync(src).toString("base64");
    return m.replace(
      'src="' + src + '"',
      "src=\"data:" + (MIME[ext] || "image/png") + ";base64," + data + '"',
    );
  });
}

function filterByLanguage(md, langCode) {
  const lines = md.split("\n");
  const result = [];
  let inTable = false;
  let seenHeader = false;
  let headerLines = [];

  for (const line of lines) {
    const t = line.trim();

    if (t.startsWith("|")) {
      if (!inTable) {
        inTable = true;
        seenHeader = false;
        headerLines = [line];
      } else if (/^\|[\s\-:]+\|[\s\-:]+\|$/.test(t)) {
        headerLines.push(line);
      } else {
        const cells = t.split("|").map((c) => c.trim());
        if (cells.length >= 3 && cells[1] === langCode) {
          if (!seenHeader && headerLines.length > 0) {
            result.push(...headerLines);
            seenHeader = true;
          }
          result.push(line);
        }
      }
    } else {
      if (inTable) {
        inTable = false;
        headerLines = [];
        seenHeader = false;
      }
      // Remove language selector lines
      if (
        t.includes("Language selector") ||
        t.includes("**EN**") ||
        t.startsWith("| Language |")
      ) {
        continue;
      }
      result.push(line);
    }
  }

  return result.join("\n");
}

const TOPIC = {
  id: "p2p",
  file: "tests/demo/p2p.md",
  zhFile: "tests/demo/p2p.zh.md",
  subtitle: {
    en: "P2P Settlement User Guide",
    zh: "P2P 结算用户指南",
    de: "P2P-Abwicklung Benutzerhandbuch",
    fr: "Guide utilisateur Règlement P2P",
    es: "Guía de usuario de Liquidación P2P",
    ja: "P2P決済ユーザーガイド",
  },
};
const md = readFileSync(TOPIC.file, "utf-8");
const mdZh = existsSync(TOPIC.zhFile) ? readFileSync(TOPIC.zhFile, "utf-8") : md;
const browser = await chromium.launch({ headless: true });

for (const lang of LANGUAGES) {
  // Use fully translated file for Chinese, multi-language filter for others
  const isZh = lang === "zh";
  const sourceMd = isZh ? mdZh : md;
  const langCode = LANG_CODES[lang];
  let content = isZh ? sourceMd : filterByLanguage(sourceMd, langCode);
  content = content.replace(/\{\{lang\}\}/g, lang);

  let body = await marked.parse(content);
  body = embedImages(body);

  // Add cover page
  body = body.replace(
    "<h1>",
    '<div class="cover-page"><div class="cover-icon"><img src="' +
      ICON +
      '" alt=""></div><h1>',
  );
  body = body.replace(
    "</h1>",
    '</h1><hr class="cover-divider"><p class="cover-meta">BigT.AI &mdash; ' +
      (TOPIC.subtitle[lang] || TOPIC.subtitle.en) +
      "</p></div>",
  );

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head><meta charset="utf-8"><title>${TOPIC.id}</title>
<style>
  @page { margin: 1.5cm; size: A4; @bottom-center { content: counter(page); font-size: 9pt; color: #94a3b8; } }
  @page :first { @bottom-center { content: none; } }
  * { box-sizing: border-box; orphans: 3; widows: 3; }
  body { font-family: 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'Noto Sans CJK KR', system-ui, -apple-system, sans-serif; font-size: 10.5pt; line-height: 1.7; color: #1e293b; max-width: 190mm; margin: 0 auto; }
  .cover-page { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 80vh; page-break-after: always; text-align: center; }
  .cover-icon img { height: 80px; }
  .cover-page h1 { font-size: 24pt; font-weight: 700; color: #0f172a; border: none; margin: 0 0 0.3em; }
  .cover-divider { width: 50px; height: 3px; background: #2563eb; margin: 1em auto; border: none; border-radius: 2px; }
  .cover-meta { font-size: 8.5pt; color: #94a3b8; margin-top: 2em; }
  h2 { font-size: 15pt; color: #0f172a; border-bottom: 2px solid #2563eb; margin-top: 1em; }
  h3 { font-size: 12pt; color: #1e293b; margin-top: 0.8em; }
  pre { background: #1e1e2e; color: #cdd6f4; padding: 0.8em; border-radius: 6px; font-size: 7.5pt; overflow-x: auto; }
  code { background: #f1f5f9; padding: 0.15em 0.4em; border-radius: 4px; color: #2563eb; font-size: 8pt; }
  pre code { background: none; color: inherit; }
  img { max-width: 100%; max-height: 12cm; width: auto; border: 1px solid #e2e8f0; border-radius: 6px; margin: 0.3em auto; display: block; page-break-inside: avoid; }
  table { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin: 0.5em 0; }
  th, td { border: 1px solid #e2e8f0; padding: 0.4em; }
  th { background: #2563eb; color: #fff; }
  p { margin: 0.4em 0; }
  hr { margin: 1em 0; }
</style></head>
<body>${body}</body>
</html>`;

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  mkdirSync("demo-output/public", { recursive: true });
  const outFile =
    lang === "en"
      ? TOPIC.id + ".pdf"
      : TOPIC.id + "." + lang + ".pdf";
  await page.pdf({
    path: "demo-output/public/" + outFile,
    format: "A4",
    printBackground: true,
  });
  await page.close();
  console.log("✓ " + outFile);
}
await browser.close();
console.log("Done");
