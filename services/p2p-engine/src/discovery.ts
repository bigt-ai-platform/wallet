/**
 * Chain endpoint discovery for the engine (docs/p2p.md). The wallet ships its
 * own orchestration (`expo-app/sources/services/discovery.ts`); the engine
 * needs a much smaller loop over the same shared `chain-discovery` package:
 *
 *   candidates (static env + optional DNS seeds + optional registry)
 *     → health probe (`getChainNumber`, the checkchain.sh health rule)
 *     → rank (chain progress, then latency)
 *     → a fail-closed pool the chain/anchor clients route through.
 *
 * Fail-closed rules:
 *   - an endpoint is usable only after a probe passes (`parseChainProbe`);
 *   - a pool with no healthy endpoint answers `best() === null` and the
 *     routed clients throw — never an unverified fallback;
 *   - a refresh that finds zero healthy endpoints keeps the last known-good
 *     ranking (each of those verified once); at boot there is no last-good,
 *     so an unprobeable chain is simply absent.
 *
 * DNS/registry sources are opt-in (`SETTLEMENT_DISCOVERY_DNS=1`,
 * `SETTLEMENT_SEEDS_URLS`): a pinned deployment must not start talking to the
 * outside world because an env line was forgotten.
 */
import {
  REGISTRY_CHAIN,
  dnsSrvName,
  dnsTxtName,
  fetchRegistryNodes,
  orderOnionLast,
  parseChainProbe,
  parseDohSeeds,
  rankProbes,
  type ChainRole,
  type DohResponse,
  type ProbeResult,
  type RankedEndpoint,
} from "chain-discovery";
import { HttpChainClient, type ChainClient } from "./chain.js";

export interface DiscoverySources {
  role: ChainRole;
  /** Operator-pinned endpoints (env). Always candidates, never trusted blindly. */
  staticUrls: string[];
  /** DoH resolver (`https://dns.google/resolve`); "" = no DNS discovery. */
  dohUrl: string;
  /** DNS seeds domain (`bigtangle.org`). */
  seedsDomain: string;
  /** `bigtangle-seeds` registry bases (`POST /serverinfolist`). */
  registryUrls: string[];
  probeTimeoutMs?: number;
}

/** Comma-list env → normalized base URLs (no trailing slash, deduped). */
export function splitUrls(raw: string | undefined | null): string[] {
  return [...new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
  )];
}

/** Resolve the DNS-published seed list for the pool's role (TXT + SRV). */
export async function fetchDnsSeedUrls(sources: DiscoverySources, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  if (!sources.dohUrl) return [];
  const timeoutMs = sources.probeTimeoutMs ?? 5_000;
  const [txt, srv] = await Promise.all([
    dohQueryVia(fetchImpl, sources.dohUrl, dnsTxtName(sources.role, sources.seedsDomain), "TXT", timeoutMs),
    dohQueryVia(fetchImpl, sources.dohUrl, dnsSrvName(sources.role, sources.seedsDomain), "SRV", timeoutMs),
  ]);
  return [...new Set([...parseDohSeeds(txt), ...parseDohSeeds(srv)])];
}

async function dohQueryVia(fetchImpl: typeof fetch, dohUrl: string, name: string, type: "TXT" | "SRV", timeoutMs: number): Promise<DohResponse | null> {
  try {
    const res = await fetchImpl(`${dohUrl}?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as DohResponse;
  } catch {
    return null;
  }
}

/** Candidate endpoints: static + DNS + registry, deduped, onion last. */
export async function gatherCandidates(sources: DiscoverySources, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const [dns, registry] = await Promise.all([
    fetchDnsSeedUrls(sources, fetchImpl),
    sources.registryUrls.length
      ? fetchRegistryNodes(sources.registryUrls, REGISTRY_CHAIN[sources.role], fetchImpl)
      : Promise.resolve([]),
  ]);
  return orderOnionLast([...new Set([...sources.staticUrls, ...dns, ...registry])]);
}

/**
 * Probe every candidate's `getChainNumber` and keep the healthy ones, ranked
 * by chain progress then latency (the checkchain.sh health rule via
 * `parseChainProbe`). Unreachable / not-ready / chainless nodes are dropped.
 */
export async function probeCandidates(
  urls: readonly string[],
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number } = {},
): Promise<RankedEndpoint[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const results: ProbeResult[] = [];
  await Promise.all(
    urls.map(async (url) => {
      const base = url.replace(/\/+$/, "");
      const started = Date.now();
      try {
        const res = await fetchImpl(`${base}/getChainNumber`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return;
        const parsed = parseChainProbe(await res.json());
        if (!parsed) return;
        results.push({
          url: base,
          chainLength: parsed.chainLength,
          latencyMs: Date.now() - started,
          finalizedChainLength: parsed.finalizedChainLength,
          head: parsed.head || undefined,
        });
      } catch {
        // unreachable / timed out — not healthy, not a candidate
      }
    }),
  );
  return rankProbes(results, { now: now() });
}

export class EndpointPool {
  private ranked: RankedEndpoint[] = [];
  private down = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sources: DiscoverySources,
    private readonly opts: { refreshMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  get role(): ChainRole {
    return this.sources.role;
  }

  /** The endpoint to use right now, or null when none is verified healthy. */
  best(): string | null {
    for (const r of this.ranked) if (!this.down.has(r.url)) return r.url;
    return null;
  }

  /** Verified-healthy endpoints in rank order (for diagnostics). */
  healthy(): RankedEndpoint[] {
    return this.ranked.filter((r) => !this.down.has(r.url));
  }

  /**
   * Demote a failing endpoint (session). When every ranked endpoint is down
   * the blocklist clears: a total outage wants a fresh probe, not a permanent
   * blackhole of nodes that verified earlier.
   */
  reportFailure(url: string): void {
    const base = url.replace(/\/+$/, "");
    this.down.add(base);
    if (this.best() === null) this.down.clear();
  }

  /** Gather + probe; on a fully failed refresh keep the last known-good set. */
  async refresh(): Promise<void> {
    const urls = await gatherCandidates(this.sources, this.opts.fetchImpl ?? fetch);
    const ranked = await probeCandidates(urls, {
      fetchImpl: this.opts.fetchImpl ?? fetch,
      timeoutMs: this.sources.probeTimeoutMs ?? 5_000,
      now: this.opts.now,
    });
    if (ranked.length > 0) {
      this.ranked = ranked;
      this.down.clear();
    }
  }

  /** Boot probe + optional background cadence (`refreshMs` 0/undefined = off). */
  async start(): Promise<void> {
    await this.refresh();
    const ms = this.opts.refreshMs ?? 0;
    if (ms > 0 && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), ms);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * `ChainClient` that routes each call through the pool's current best
 * endpoint and demotes it when the call throws. A pool with no healthy
 * endpoint throws — the engine's evidence paths then fail closed exactly as
 * they do with no chain configured.
 */
export class PooledChainClient implements ChainClient {
  constructor(
    private readonly pool: EndpointPool,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async route<T>(fn: (client: HttpChainClient) => Promise<T>): Promise<T> {
    const url = this.pool.best();
    if (!url) throw new Error(`no healthy ${this.pool.role} endpoint (discovery)`);
    try {
      return await fn(new HttpChainClient(url, this.fetchImpl));
    } catch (e) {
      this.pool.reportFailure(url);
      throw e;
    }
  }

  transactionStatus(txHash: string) {
    return this.route((c) => c.transactionStatus(txHash));
  }
  balances(hashHex: string) {
    return this.route((c) => c.balances(hashHex));
  }
  outputsHistory(address: string) {
    return this.route((c) => c.outputsHistory(address));
  }
  submitTransaction(rawTxHex: string) {
    return this.route((c) => c.submitTransaction(rawTxHex));
  }
}

/**
 * Build a pool from env, or null when no source is configured (the legacy
 * "no chain" shape). `SETTLEMENT_L0_URLS` / `SETTLEMENT_L1_SOCIAL_URLS` are
 * comma lists; the singular legacy vars stay supported.
 */
export function poolFromEnv(env: NodeJS.ProcessEnv, role: ChainRole): EndpointPool | null {
  const staticUrls =
    role === "l0"
      ? [...splitUrls(env.SETTLEMENT_L0_URLS), ...splitUrls(env.SETTLEMENT_L0_URL)]
      : [
          ...splitUrls(env.SETTLEMENT_L1_SOCIAL_URLS),
          ...splitUrls(env.SETTLEMENT_L1_URL),
          ...splitUrls(env.SETTLEMENT_L1_SOCIAL_URL),
          ...splitUrls(env.L1_SOCIAL_URL),
        ];
  const registryUrls = splitUrls(env.SETTLEMENT_SEEDS_URLS);
  const dnsEnabled = env.SETTLEMENT_DISCOVERY_DNS === "1";
  const dohUrl = dnsEnabled ? env.SETTLEMENT_DOH_URL?.trim() || "https://dns.google/resolve" : "";
  if (!staticUrls.length && !registryUrls.length && !dohUrl) return null;
  const sources: DiscoverySources = {
    role,
    staticUrls: [...new Set(staticUrls)],
    dohUrl,
    seedsDomain: env.SETTLEMENT_DNS_SEEDS_DOMAIN?.trim() || "bigtangle.org",
    registryUrls,
    probeTimeoutMs: Number(env.SETTLEMENT_DISCOVERY_TIMEOUT_MS ?? "5000") || 5_000,
  };
  const refreshMs = Number(env.SETTLEMENT_DISCOVERY_MS ?? "300000") || 0;
  return new EndpointPool(sources, { refreshMs });
}
