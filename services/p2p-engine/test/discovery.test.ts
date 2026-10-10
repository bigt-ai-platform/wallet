import { describe, expect, it } from "vitest";
import {
  EndpointPool,
  PooledChainClient,
  gatherCandidates,
  poolFromEnv,
  probeCandidates,
  splitUrls,
  type DiscoverySources,
} from "../src/discovery.js";

function sources(overrides: Partial<DiscoverySources> = {}): DiscoverySources {
  return { role: "l0", staticUrls: [], dohUrl: "", seedsDomain: "bigtangle.org", registryUrls: [], ...overrides };
}

type Route = Record<string, unknown> | Error;

/** URL-routed mock fetch: exact URL → JSON body, Error → throw, else 404. */
function mockFetch(routes: Route): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const hit = routes[String(url)];
    if (hit instanceof Error) throw hit;
    if (!hit) return new Response("not found", { status: 404 });
    return Response.json(hit);
  }) as typeof fetch;
}

function chainNumber(chainLength: number, extra: Record<string, unknown> = {}): unknown {
  return { txReward: { chainLength, blockHashHex: "ab" }, ...extra };
}

describe("splitUrls", () => {
  it("splits comma lists, trims, strips trailing slashes, dedupes", () => {
    expect(splitUrls(" https://a.example/ , https://b.example,, https://a.example ")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
    expect(splitUrls(undefined)).toEqual([]);
  });
});

describe("poolFromEnv", () => {
  it("is null with no sources at all (legacy no-chain shape)", () => {
    expect(poolFromEnv({}, "l0")).toBeNull();
  });

  it("keeps the singular legacy L0 env", () => {
    const pool = poolFromEnv({ SETTLEMENT_L0_URL: "https://eu1.example/" }, "l0");
    expect(pool).not.toBeNull();
    expect(pool!.role).toBe("l0");
    expect(pool!.best()).toBeNull(); // unverified until the first probe
  });

  it("accepts the comma-list env and dedupes against the singular var", () => {
    const pool = poolFromEnv(
      { SETTLEMENT_L0_URLS: "https://a.example,https://b.example", SETTLEMENT_L0_URL: "https://a.example" },
      "l0",
    );
    const statics = (pool as unknown as { sources: DiscoverySources }).sources.staticUrls;
    expect(statics).toEqual(["https://a.example", "https://b.example"]);
  });

  it("reads the social role from the new + legacy social envs", () => {
    const pool = poolFromEnv(
      { SETTLEMENT_L1_SOCIAL_URLS: "https://s1.example,https://s2.example", L1_SOCIAL_URL: "https://s3.example" },
      "social",
    );
    expect(pool!.role).toBe("social");
    const statics = (pool as unknown as { sources: DiscoverySources }).sources.staticUrls;
    expect(statics).toEqual(["https://s1.example", "https://s2.example", "https://s3.example"]);
  });

  it("enables DoH only behind SETTLEMENT_DISCOVERY_DNS=1", () => {
    const off = poolFromEnv({ SETTLEMENT_L0_URL: "https://eu1.example" }, "l0");
    expect((off as unknown as { sources: DiscoverySources }).sources.dohUrl).toBe("");
    const on = poolFromEnv({ SETTLEMENT_DISCOVERY_DNS: "1" }, "l0");
    expect((on as unknown as { sources: DiscoverySources }).sources.dohUrl).toBe("https://dns.google/resolve");
  });
});

describe("gatherCandidates", () => {
  it("unions static + DNS + registry (role-matched), deduped", async () => {
    const fetchImpl = mockFetch({
      "https://dns.google/resolve?name=_bigtangle-social.bigtangle.org&type=TXT": {
        Status: 0,
        Answer: [{ name: "_bigtangle-social.bigtangle.org", type: 16, data: '"https://dns1.example"' }],
      },
      "https://dns.google/resolve?name=_bigtangle-social._tcp.bigtangle.org&type=SRV": { Status: 0 },
      "https://reg.example/serverinfolist": {
        serverInfoList: [
          { url: "https://soc.example", chain: "SOCIAL", status: "active" },
          { url: "https://ord.example", chain: "ordermatch", status: "active" },
          { url: "https://plain.example", status: "active" },
        ],
      },
    });
    const urls = await gatherCandidates(
      sources({
        role: "social",
        staticUrls: ["https://static.example"],
        dohUrl: "https://dns.google/resolve",
        registryUrls: ["https://reg.example"],
      }),
      fetchImpl,
    );
    expect(urls).toEqual(
      expect.arrayContaining(["https://static.example", "https://dns1.example", "https://soc.example", "https://plain.example"]),
    );
    expect(urls).not.toContain("https://ord.example"); // other chain, never
  });
});

describe("probeCandidates", () => {
  it("keeps only healthy nodes, ranked by chain progress", async () => {
    const fetchImpl = mockFetch({
      "https://head.example/getChainNumber": chainNumber(20),
      "https://behind.example/getChainNumber": chainNumber(10),
      "https://notready.example/getChainNumber": { errorcode: 103 },
      "https://empty.example/getChainNumber": chainNumber(0),
    });
    const ranked = await probeCandidates(
      ["https://head.example", "https://behind.example", "https://notready.example", "https://empty.example", "https://down.example"],
      { fetchImpl },
    );
    expect(ranked.map((r) => r.url)).toEqual(["https://head.example", "https://behind.example"]);
    expect(ranked[0].chainLength).toBe(20);
  });
});

describe("EndpointPool", () => {
  const routes = (a: number, b: number): Route => ({
    "https://a.example/getChainNumber": chainNumber(a),
    "https://b.example/getChainNumber": chainNumber(b),
  });

  it("fails closed before any probe, then serves the best healthy endpoint", async () => {
    const pool = new EndpointPool(sources({ staticUrls: ["https://a.example", "https://b.example"] }), {
      fetchImpl: mockFetch(routes(5, 9)),
    });
    expect(pool.best()).toBeNull();
    await pool.start();
    expect(pool.best()).toBe("https://b.example");
    expect(pool.healthy().map((r) => r.url)).toEqual(["https://b.example", "https://a.example"]);
    pool.stop();
  });

  it("demotes a failing endpoint and clears the blocklist when everything is down", async () => {
    const pool = new EndpointPool(sources({ staticUrls: ["https://a.example", "https://b.example"] }), {
      fetchImpl: mockFetch(routes(5, 9)),
    });
    await pool.refresh();
    pool.reportFailure("https://b.example/");
    expect(pool.best()).toBe("https://a.example");
    pool.reportFailure("https://a.example");
    expect(pool.best()).toBe("https://b.example"); // all down → clear, verified set restored
  });

  it("keeps the last known-good ranking when a later refresh finds nothing", async () => {
    let healthy = true;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (!healthy) return new Response("down", { status: 503 });
      if (u === "https://a.example/getChainNumber") return Response.json(chainNumber(7));
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const pool = new EndpointPool(sources({ staticUrls: ["https://a.example"] }), { fetchImpl });
    await pool.refresh();
    expect(pool.best()).toBe("https://a.example");
    healthy = false;
    await pool.refresh();
    expect(pool.best()).toBe("https://a.example");
  });
});

describe("PooledChainClient", () => {
  it("throws when the pool has no verified endpoint", async () => {
    const pool = new EndpointPool(sources({ staticUrls: ["https://a.example"] }), { fetchImpl: mockFetch({}) });
    const client = new PooledChainClient(pool);
    await expect(client.transactionStatus("dead")).rejects.toThrow(/no healthy l0 endpoint/);
  });

  it("routes through the best endpoint and demotes on failure", async () => {
    const routes: Route = {
      "https://a.example/getTransactionStatus": { status: "CONFIRMED" },
      "https://b.example/getTransactionStatus": new Error("boom"),
    };
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === "https://b.example/getChainNumber") return Response.json(chainNumber(50));
      if (u === "https://a.example/getChainNumber") return Response.json(chainNumber(40));
      const hit = routes[u];
      if (hit instanceof Error) throw hit;
      if (hit) return Response.json(hit);
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const pool = new EndpointPool(sources({ staticUrls: ["https://a.example", "https://b.example"] }), {
      // b ranks first (higher chain), but its requests throw
      fetchImpl,
    });
    await pool.refresh();
    expect(pool.best()).toBe("https://b.example");
    const client = new PooledChainClient(pool, fetchImpl);
    await expect(client.transactionStatus("t1")).rejects.toThrow("boom");
    expect(pool.best()).toBe("https://a.example");
    const status = await client.transactionStatus("t1");
    expect(status.status).toBe("CONFIRMED");
  });
});
