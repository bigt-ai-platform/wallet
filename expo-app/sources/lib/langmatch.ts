/** Match a list of BCP-47 language tags against a set of supported base
 *  codes (zh-CN → zh, de-AT → de). Returns the first supported base code, or
 *  null when none of the tags ship. Pure (no navigator/RN/MMKV imports), so
 *  it is unit testable in isolation — the same reason lib/ota.ts stays lean. */
export function matchBaseLang(tags: readonly string[], supported: readonly string[]): string | null {
  for (const tag of tags) {
    const base = tag.toLowerCase().split('-')[0];
    if (supported.includes(base)) return base;
  }
  return null;
}
