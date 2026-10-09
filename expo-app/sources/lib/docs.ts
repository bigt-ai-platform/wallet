/**
 * Help-center guide PDFs. The guides under `docs/guides` are rendered to PDFs
 * (docs/p2p-demo/scripts) and published to the per-region MinIO docs buckets by
 * `scripts/docs-upload.sh`, mirroring ../dai (apps/web/src/lib/docs.ts).
 *
 * Each bucket holds `demo/<guide><suffix>.pdf`: English has no suffix, other
 * rendered languages use `.<lang>` (see {@link PDF_LANGS}). The native APK and
 * the static web export cannot host the files themselves, so they link straight
 * at the bucket (which is public-read). Pure (no React imports), so it is unit
 * testable in isolation.
 */

/** Languages that have a rendered PDF (`demo/<guide><suffix>.pdf`). Every UI
 *  language has translated page copy, but only these have a rendered PDF — a
 *  link built for any other language would 404 and falls back to English. */
export const PDF_LANGS = new Set<string>([
  'en', 'zh', 'de', 'fr', 'es', 'ja', 'hi', 'ar', 'pt', 'id', 'ru', 'ko',
]);

/** Path suffix for `demo/<guide><suffix>.pdf`: '' for English (and any language
 *  without a rendered PDF), `.<lang>` otherwise. */
export function pdfSuffix(lang: string): string {
  return lang !== 'en' && PDF_LANGS.has(lang) ? `.${lang}` : '';
}

export type BigtRegion = 'europa' | 'usa' | 'asia';

/** Public regional S3 endpoints (minio GEO) and the per-region wallet docs
 *  bucket created by scripts/docs-upload.sh — identical content in all three,
 *  so the region only decides latency. Mirrors ../dai. */
const DOCS_SITES: Record<BigtRegion, { endpoint: string; bucket: string }> = {
  europa: { endpoint: 'https://s3.bigt.ai', bucket: 'wallet-docs-eu' },
  usa: { endpoint: 'https://s3-us.bigt.ai', bucket: 'wallet-docs-us' },
  asia: { endpoint: 'https://s3-asia.bigt.ai', bucket: 'wallet-docs-asia' },
};

/** Absolute URL for a rendered guide PDF under `demo/` (e.g. `p2p.zh.pdf`). */
export function docsPdfUrl(file: string, region: BigtRegion = 'europa'): string {
  const site = DOCS_SITES[region];
  return `${site.endpoint}/${site.bucket}/demo/${file}`;
}

/** Timezone-implied region (Asia/Oceania/Pacific → asia, America → usa, else
 *  europa), so the link hits the nearest MinIO site. */
export function tzRegion(
  tz: string = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
): BigtRegion {
  if (tz.startsWith('Asia/') || tz.startsWith('Australia/') || tz.startsWith('Pacific/')) return 'asia';
  if (tz.startsWith('America/')) return 'usa';
  return 'europa';
}

/** Absolute URL for the P2P guide PDF in the UI language (BCP-47 tags are
 *  normalized to their base code, e.g. `zh-CN` → `zh`). */
export function p2pPdfUrl(lang: string, region: BigtRegion = 'europa'): string {
  return docsPdfUrl(`p2p${pdfSuffix(lang.split('-')[0])}.pdf`, region);
}
