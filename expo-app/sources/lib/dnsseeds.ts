/**
 * DNS seed parsing (pure). DNS is only the bootstrap for the *seed* set: the
 * operator publishes SRV/TXT records, the app resolves them via DNS-over-HTTPS
 * (the WebView/RN runtime cannot query SRV/TXT directly), then verifies and
 * ranks the returned endpoints (see `services/discovery.ts`).
 *
 * DoH JSON shape (dns.google / cloudflare-dns.com, `Accept: application/dns-json`):
 *   { "Status": 0, "Answer": [{ "name": "...", "type": 16|33, "data": "..." }] }
 *
 * Published records (scheme, see deploy docs):
 *   TXT  _bigtangle-l0.bigtangle.org   "https://eu1.bigtangle.org" "https://eu2.bigtangle.org"
 *   TXT  _bigtangle-l1.bigtangle.org   "https://ordereu1.bigtangle.org" ...
 *   SRV  _bigtangle-l0._tcp.bigtangle.org  0 0 443 eu1.bigtangle.org.
 *   SRV  _bigtangle-l1._tcp.bigtangle.org  0 0 443 ordereu1.bigtangle.org.
 */

export const DNS_TYPE_TXT = 16;
export const DNS_TYPE_SRV = 33;

export interface DohAnswer {
  name: string;
  type: number;
  TTL?: number;
  data: string;
}

export interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

/**
 * Normalize a seed value to a base URL (`https://host[:port]`, no trailing
 * slash). Only dotted hostnames are accepted, so unrelated TXT records on the
 * same name (e.g. `google-site-verification=…`) are ignored rather than parsed
 * into a bogus endpoint.
 */
export function normalizeSeed(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const m = /^(https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::(\d{1,5}))?\/?$/i.exec(
    v,
  );
  if (!m) return null;
  const scheme = (m[1] ?? 'https://').toLowerCase().replace(/\/+$/, '');
  return `${scheme}//${m[2]}${m[3] ? `:${m[3]}` : ''}`;
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}

/**
 * Extract seed URLs from a TXT DoH answer. Handles a single RR carrying several
 * quoted character-strings, multiple TXT RRs, and bare `host[:port]` values.
 */
export function parseTxtSeeds(resp: DohResponse | null): string[] {
  if (!resp || resp.Status !== 0) return [];
  const out: string[] = [];
  for (const a of resp.Answer ?? []) {
    if (a.type !== DNS_TYPE_TXT) continue;
    const quoted = [...a.data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      m[1].replace(/\\(.)/g, '$1'),
    );
    for (const value of quoted.length ? quoted : [a.data]) {
      const normalized = normalizeSeed(value);
      if (normalized) out.push(normalized);
    }
  }
  return dedupe(out);
}

/** Extract seed URLs from an SRV DoH answer, ordered by priority then weight. */
export function parseSrvSeeds(resp: DohResponse | null, scheme = 'https'): string[] {
  if (!resp || resp.Status !== 0) return [];
  const records = (resp.Answer ?? [])
    .filter((a) => a.type === DNS_TYPE_SRV)
    .map((a) => {
      const [priority, weight, port, target] = a.data.trim().split(/\s+/);
      return {
        priority: Number(priority) || 0,
        weight: Number(weight) || 0,
        port: Number(port) || 0,
        target: (target ?? '').replace(/\.$/, ''),
      };
    })
    .filter((r) => r.target);
  records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
  const out = records.map((r) => {
    const base = `${scheme}://${r.target}`;
    return r.port && r.port !== 443 ? `${base}:${r.port}` : base;
  });
  return dedupe(out);
}

/** Parse either a TXT or SRV DoH answer into seed URLs. */
export function parseDohSeeds(resp: DohResponse | null, scheme = 'https'): string[] {
  return dedupe([...parseTxtSeeds(resp), ...parseSrvSeeds(resp, scheme)]);
}
