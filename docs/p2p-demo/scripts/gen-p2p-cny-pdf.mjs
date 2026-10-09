#!/usr/bin/env node
/**
 * Render docs/p2p-demo/p2p-cny.md → docs/p2p-demo/assets/p2p-cny.pdf
 *
 * Self-contained (no `marked`, no workspace deps): a minimal markdown → HTML
 * pass, the local screenshots embedded as data URIs, and a headless Chromium
 * print-to-pdf — the same pipeline the dai help guides use (scripts/docs-pdf.mts).
 *
 * Usage:
 *   node docs/p2p-demo/scripts/gen-p2p-cny-pdf.mjs
 *   CHROME_BIN=/path/to/chrome node docs/p2p-demo/scripts/gen-p2p-cny-pdf.mjs
 *
 * Companion: e2e/capture-p2p-cny.mjs regenerates the screenshots first.
 */
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, ".."); // docs/p2p-demo
const MD_PATH = join(DEMO, "p2p-cny.md");
const OUT_PDF = join(DEMO, "assets", "p2p-cny.pdf");

const THEME = {
  primary: "#0A8462",
  textPrimary: "#111827",
  textSecondary: "#565869",
  border: "#E5E5E5",
  codeBg: "#F3F4F6",
  accent: "#B42318",
};

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/** Embed a local image as a data URI (PDF must be self-contained). */
function imgSrc(src, mdDir) {
  if (/^(https?:|data:)/.test(src)) return src;
  const abs = join(mdDir, src);
  if (!existsSync(abs)) {
    console.warn(`  image not found: ${src}`);
    return "";
  }
  const mime = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

/** Minimal markdown → HTML: headings, lists, tables, fences, quotes, images. */
function mdToHtml(source, mdDir) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null;
  let table = [];
  let fence = null;
  let quote = null;

  const flushList = () => {
    if (!list) return;
    out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote) return;
    out.push(`<div class="note">${quote.join(" ")}</div>`);
    quote = null;
  };
  const flushTable = () => {
    if (!table.length) return;
    const [head, ...body] = table;
    const rows = [head, ...body]
      .map(
        (r, i) =>
          `<tr>${r
            .map((c) => `<td class="${i === 0 ? "t-head" : ""}">${inline(c)}</td>`)
            .join("")}</tr>`,
      )
      .join("");
    out.push(`<table>${rows}</table>`);
    table = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (fence !== null) {
      if (line.startsWith("```")) {
        out.push("</pre>");
        fence = null;
      } else {
        out.push(esc(line));
      }
      continue;
    }
    if (line.startsWith("```")) {
      flushList();
      flushTable();
      flushQuote();
      out.push("<pre>");
      fence = line.slice(3);
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushList();
      flushQuote();
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      table.push(cells);
      continue;
    }
    flushTable();

    if (/^\s*>\s?/.test(line)) {
      flushList();
      if (!quote) quote = [];
      quote.push(inline(line.replace(/^\s*>\s?/, "")));
      continue;
    }
    flushQuote();

    if (/^\s*[-*]\s+/.test(line)) {
      if (!list) list = [];
      list.push(inline(line.replace(/^\s*[-*]\s+/, "")));
      continue;
    }
    flushList();

    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      const src = imgSrc(img[2], mdDir);
      if (src) out.push(`<img class="md-img" alt="${esc(img[1])}" src="${src}">`);
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (!line.trim()) {
      // blank line
    } else if (/^---+$/.test(line.trim())) {
      out.push("<hr>");
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flushList();
  flushTable();
  flushQuote();
  if (fence !== null) out.push("</pre>");
  return out.join("\n");
}

function renderHtml(title, body, meta) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 15mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: ${THEME.textPrimary}; font-size: 12.5px; line-height: 1.62; margin: 0; }
  .cover { page-break-after: always; text-align: center; padding-top: 120px; }
  .cover .rule { width: 72px; height: 4px; background: ${THEME.primary};
                 border-radius: 2px; margin: 18px auto 22px; }
  .cover h1 { font-size: 34px; font-weight: 800; margin: 0; letter-spacing: -0.5px; }
  .cover .sub { font-size: 15px; color: ${THEME.textSecondary}; margin: 10px 0 0; }
  .cover .meta { margin-top: 64px; font-size: 12px; color: ${THEME.textSecondary}; }
  .cover .meta strong { color: ${THEME.primary}; }
  h1 { font-size: 21px; margin: 20px 0 8px; }
  h2 { font-size: 16.5px; margin: 22px 0 8px; color: ${THEME.primary};
       border-bottom: 2px solid ${THEME.border}; padding-bottom: 5px; page-break-after: avoid; }
  h3 { font-size: 14px; margin: 16px 0 6px; page-break-after: avoid; }
  h4 { font-size: 13px; margin: 14px 0 6px; page-break-after: avoid; }
  p { margin: 7px 0; }
  a { color: ${THEME.primary}; text-decoration: none; }
  ul { margin: 6px 0 10px; padding-left: 20px; }
  li { margin: 3px 0; }
  strong { color: ${THEME.textPrimary}; }
  code { background: ${THEME.codeBg}; padding: 1px 5px; border-radius: 4px;
         font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11.5px; }
  pre { background: ${THEME.codeBg}; border: 1px solid ${THEME.border}; border-radius: 8px;
        padding: 10px 12px; margin: 8px 0; font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 10.5px; white-space: pre-wrap; word-break: break-word;
        page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 11px; }
  td { border: 1px solid ${THEME.border}; padding: 5px 7px; vertical-align: top; }
  td.t-head { font-weight: 700; background: ${THEME.codeBg}; }
  hr { border: none; border-top: 1px solid ${THEME.border}; margin: 18px 0; }
  img.md-img { display: block; max-width: 100%; max-height: 620px; width: auto;
               margin: 10px auto 4px; border: 1px solid ${THEME.border};
               border-radius: 6px; page-break-inside: avoid; }
  .note { background: rgba(10, 132, 98, 0.08); border-left: 3px solid ${THEME.primary};
          padding: 8px 12px; margin: 10px 0; font-size: 12px; border-radius: 0 6px 6px 0; }
  .note strong { color: ${THEME.primary}; }
</style></head><body>
  <div class="cover">
    <h1>bigT</h1>
    <div class="rule"></div>
    <div class="sub">${esc(title)}</div>
    <div class="meta">${meta}</div>
  </div>
  ${body}
</body></html>`;
}

function chromium() {
  const bin = process.env.CHROME_BIN;
  if (bin && existsSync(bin)) return bin;
  for (const c of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    try {
      execFileSync("which", [c], { stdio: "pipe" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("no chromium found — set CHROME_BIN or install chromium");
}

const md = readFileSync(MD_PATH, "utf-8");
const [titleLine, ...rest] = md.split("\n");
const title = titleLine.replace(/^#\s*/, "").trim();

const report = join(resolve(DEMO, "..", ".."), "e2e", "demo-output", "p2p-cny-capture.json");
let meta = "P2P settlement · WeChat Pay / Alipay (CNY rails)<br>Step-by-step demo guide";
if (existsSync(report)) {
  const run = JSON.parse(readFileSync(report, "utf-8"));
  meta = `${meta}<br><strong>captured</strong> ${run.capturedAt} · swap <code>${run.swapId}</code>`;
}

const html = renderHtml(title, mdToHtml(rest.join("\n"), DEMO), meta);
const htmlPath = join(tmpdir(), "p2p-cny.html");
writeFileSync(htmlPath, html);
mkdirSync(dirname(OUT_PDF), { recursive: true });
execFileSync(
  chromium(),
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    `--print-to-pdf=${OUT_PDF}`,
    `file://${htmlPath}`,
  ],
  { stdio: "pipe", timeout: 120000 },
);
console.log(`✓ ${OUT_PDF} (${(readFileSync(OUT_PDF).length / 1024).toFixed(0)} KB)`);
