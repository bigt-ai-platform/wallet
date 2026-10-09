#!/usr/bin/env tsx
/**
 * Regenerate the help-center PDF guides under docs/p2p-demo/assets from the
 * markdown sources in docs/guides. Renders a styled HTML page (bigtangle theme)
 * and prints it to PDF via headless Chromium — the same pipeline as
 * ../dai/scripts/docs-pdf.mts, adapted to this repo's layout.
 *
 * The PDFs are committed (docs/p2p-demo/assets) and published to the regional
 * MinIO docs buckets by scripts/docs-upload.sh (whose default src dir is
 * docs/p2p-demo/assets), mirroring ../dai.
 *
 * Usage:
 *   npx tsx scripts/docs-pdf.mts            # every guide, every language
 *   npx tsx scripts/docs-pdf.mts p2p        # one guide, all languages
 *   npx tsx scripts/docs-pdf.mts p2p ja     # one guide, one language
 *   npx tsx scripts/docs-pdf.mts --md docs/p2p-demo/p2p-cny.md [--out <pdf>] [--lang <code>]
 *
 * Guide sources are `<guide>.md` (English) and `<guide>.<lang>.md`; the output
 * is `<guide>.pdf` / `<guide>.<lang>.pdf`, the names lib/docs.ts links to.
 *
 * Needs a chromium binary on PATH (CHROME_BIN overrides): google-chrome,
 * chromium, chromium-browser.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const GUIDES_DIR = join(ROOT, "docs", "guides");
const ASSETS_DIR = join(ROOT, "docs", "p2p-demo", "assets");
const SHOTS_DIR = join(ASSETS_DIR, "screenshots");
/** Where the rendered PDFs land. Override with DOCS_PDF_OUT (e.g. a scratch dir). */
const OUT_DIR = process.env.DOCS_PDF_OUT ? resolve(process.env.DOCS_PDF_OUT) : ASSETS_DIR;

const LANGS = ["en", "zh", "de", "fr", "es", "ja", "hi", "ar", "pt", "id", "ru", "ko"];
/** Mirror the doc when its language reads right-to-left (lib/i18n RTL_LANGS). */
const RTL_LANGS = new Set(["ar"]);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const THEME = {
  primary: "#0A8462",
  textPrimary: "#111827",
  textSecondary: "#565869",
  border: "#E5E5E5",
  surface: "#FFFFFF",
  codeBg: "#F3F4F6",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // code spans, **bold**, *italic*, [link](url)
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

/**
 * Resolve a markdown image src to a data URI. The guide sources reference the
 * step-by-step screenshots by their web path (`/demo/p2p/<file>`); the files
 * live in docs/p2p-demo/assets/screenshots. Older/translated sources use the
 * legacy `demo-output/screenshots/<file>` path. Try each candidate, then fall
 * back to the English shot (`<name>-<lang>.png` → `<name>-en.png`) since only
 * the English screenshots are captured.
 */
function imgSrc(src: string, mdDir: string, lang: string): string {
  if (/^(https?:|data:)/.test(src)) return src;
  const base = basename(src);
  const candidates = [
    src.startsWith("/") ? join(ROOT, src.replace(/^\/+/, "")) : join(mdDir, src),
    join(SHOTS_DIR, base),
    join(ASSETS_DIR, base),
    join(ASSETS_DIR, src.replace(/^\/+/, "").replace(/^demo\//, "")),
  ];
  let abs = candidates.find((p) => existsSync(p));
  if (!abs) {
    const alt = base.replace(new RegExp(`-${lang}\\.(png|jpe?g|webp|gif|svg)$`, "i"), "-en.$1");
    if (alt !== base && existsSync(join(SHOTS_DIR, alt))) abs = join(SHOTS_DIR, alt);
  }
  if (!abs) {
    console.warn(`  image not found: ${src}`);
    return src;
  }
  const mime = MIME_TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${readFileSync(abs).toString("base64")}`;
}

/** Minimal markdown → HTML for the guide files (headings, lists, tables,
 *  fenced code, hr, paragraphs). No external dependency. */
function mdToHtml(source: string, mdDir: string = GUIDES_DIR, lang: string = "en"): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: string[] | null = null;
  let table: string[][] = [];
  let fence: string | null = null;
  let quote: string[] | null = null;

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
        (r) =>
          `<tr>${r.map((c, i) => `<td class="${i === 0 ? "t-head" : ""}">${inline(c)}</td>`).join("")}</tr>`,
      )
      .join("");
    out.push(`<table>${rows}</table>`);
    table = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (fence) {
      if (line.startsWith("```")) {
        out.push(`</pre>`);
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
      out.push(`<pre>`);
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

    if (/^\s*-\s+/.test(line)) {
      if (!list) list = [];
      list.push(inline(line.replace(/^\s*-\s+/, "")));
      continue;
    }
    flushList();

    if (/^\s*#{1,3}\s/.test(line)) {
      const m = line.match(/^\s*(#{1,3})\s+(.*)$/)!;
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
    } else if (/^\s*$/.test(line)) {
      // blank: nothing
    } else if (/^---+$/.test(line.trim())) {
      out.push(`<hr>`);
    } else if (/^!\[([^\]]*)\]\(([^)]+)\)$/.test(line.trim())) {
      const m = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/)!;
      out.push(`<img class="md-img" alt="${esc(m[1])}" src="${imgSrc(m[2], mdDir, lang)}">`);
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flushList();
  flushTable();
  flushQuote();
  if (fence) out.push(`</pre>`);
  return out.join("\n");
}

function renderHtml(title: string, body: string, lang: string): string {
  const dir = RTL_LANGS.has(lang) ? "rtl" : "ltr";
  return `<!doctype html>
<html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<style>
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
         color: ${THEME.textPrimary}; line-height: 1.6; font-size: 13px; margin: 0; }
  .cover { text-align: center; padding: 60px 20px 20px; border-bottom: 3px solid ${THEME.primary}; margin-bottom: 22px; }
  .cover h1 { font-size: 26px; font-weight: 800; margin: 0 0 8px; color: ${THEME.textPrimary}; }
  .cover p { color: ${THEME.textSecondary}; margin: 0; font-size: 14px; }
  h1, h2, h3 { color: ${THEME.textPrimary}; }
  h1 { font-size: 20px; margin: 22px 0 8px; }
  h2 { font-size: 16px; margin: 20px 0 6px; color: ${THEME.primary}; }
  h3 { font-size: 14px; margin: 16px 0 6px; }
  p { margin: 8px 0; }
  a { color: ${THEME.primary}; text-decoration: none; }
  ul { margin: 6px 0 10px; padding-inline-start: 22px; }
  li { margin: 3px 0; }
  code { background: ${THEME.codeBg}; padding: 1px 5px; border-radius: 4px;
         font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
  pre { background: ${THEME.codeBg}; border-radius: 8px; padding: 10px 12px; margin: 8px 0;
        font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px;
        white-space: pre-wrap; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 12px; }
  td { border: 1px solid ${THEME.border}; padding: 6px 8px; vertical-align: top; }
  td.t-head { font-weight: 700; background: ${THEME.codeBg}; }
  hr { border: none; border-top: 1px solid ${THEME.border}; margin: 18px 0; }
  img.md-img { display: block; max-width: 100%; max-height: 420px; margin: 12px auto;
               border: 1px solid ${THEME.border}; border-radius: 8px; }
  .note { background: rgba(10, 132, 98, 0.08); border-inline-start: 3px solid ${THEME.primary};
          padding: 8px 12px; margin: 10px 0; font-size: 12px;
          border-start-start-radius: 0; border-end-start-radius: 0;
          border-start-end-radius: 6px; border-end-end-radius: 6px; }
</style></head><body>
  <div class="cover"><h1>bigt.ai</h1><p>${esc(title)}</p></div>
  ${body}
</body></html>`;
}

function chromium(): string {
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

/** Render one markdown file to a PDF at an explicit path (shared by the guide
 *  set and the `--md` mode). `mdDir` anchors relative image sources. */
function renderMarkdownToPdf(mdPath: string, pdfPath: string, lang: string, mdDir = dirname(mdPath)): void {
  const md = readFileSync(mdPath, "utf-8");
  const [titleLine, ...rest] = md.split("\n");
  const title = titleLine.replace(/^#\s*/, "").trim();
  const html = renderHtml(title, mdToHtml(rest.join("\n"), mdDir, lang), lang);

  const htmlPath = join(tmpdir(), `docs-${basename(mdPath, ".md")}-${lang}.html`);
  writeFileSync(htmlPath, html);
  mkdirSync(dirname(pdfPath), { recursive: true });
  execFileSync(
    chromium(),
    ["--headless", "--disable-gpu", "--no-sandbox", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`],
    { stdio: "pipe", timeout: 120000 },
  );
  console.log(`  ${basename(mdPath)} → ${pdfPath.replace(ROOT + "/", "")}`);
}

function generatePdf(guide: string, lang: string): void {
  const suffix = lang === "en" ? "" : `.${lang}`;
  const mdPath = join(GUIDES_DIR, `${guide}${suffix}.md`);
  if (!existsSync(mdPath)) {
    if (lang === "en") throw new Error(`missing guide source: ${mdPath}`);
    console.warn(`  skip ${guide}.${lang}: no source at ${mdPath.replace(ROOT + "/", "")}`);
    return;
  }
  renderMarkdownToPdf(mdPath, join(OUT_DIR, `${guide}${suffix}.pdf`), lang, GUIDES_DIR);
}

/** Distinct guide names in docs/guides (strip the `.md` and any `.<lang>`). */
function discoverGuides(): string[] {
  const names = new Set<string>();
  for (const f of readdirSync(GUIDES_DIR)) {
    if (!f.endsWith(".md")) continue;
    let name = f.slice(0, -3);
    const m = name.match(/^(.*)\.([a-z]{2})$/);
    if (m && LANGS.includes(m[2])) name = m[1];
    names.add(name);
  }
  return [...names].sort();
}

const argv = process.argv.slice(2);

// `--md <file> [--out <pdf>] [--lang <code>]` renders an arbitrary markdown doc
// (e.g. docs/p2p-demo/p2p-cny.md).
const mdIdx = argv.indexOf("--md");
if (mdIdx >= 0) {
  const mdPath = resolve(argv[mdIdx + 1]);
  const outIdx = argv.indexOf("--out");
  const outPath = resolve(outIdx >= 0 ? argv[outIdx + 1] : mdPath.replace(/\.md$/, ".pdf"));
  const langIdx = argv.indexOf("--lang");
  const mdLang = langIdx >= 0 ? argv[langIdx + 1] : "en";
  mkdirSync(dirname(outPath), { recursive: true });
  renderMarkdownToPdf(mdPath, outPath, mdLang);
  console.log("done.");
  process.exit(0);
}

// Positional: `[guide] [lang]`. Both optional; default = every guide, all langs.
const target = argv[0];
const langArg = argv[1];
const guides = target ? [target] : discoverGuides();
const langs = langArg ? [langArg] : LANGS;

if (langArg && !LANGS.includes(langArg)) {
  throw new Error(`unknown language '${langArg}' (known: ${LANGS.join(", ")})`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const g of guides) {
  console.log(`${g}:`);
  for (const l of langs) generatePdf(g, l);
}
console.log(`done → ${OUT_DIR.replace(ROOT + "/", "")}; publish with: scripts/docs-upload.sh`);
