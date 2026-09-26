import { ServerInfo } from "../../response/ServerInfo";

/**
 * Client for a `bigtangle-seeds` discovery registry.
 *
 * The registry is the *bootstrap* for the seed set: a node asks it for the
 * live node URLs of its own chain, then health-checks/ranks them itself (this
 * client only returns the advertised list). Plain JSON, built on `fetch` so it
 * works in Node and the browser/RN without node builtins (keeps the package
 * bundleable by webpack/Next).
 */
export interface ServerInfoListResponse {
  serverInfoList?: ServerInfo[] | null;
}

const DEFAULT_TIMEOUT_MS = 10000;

export class ServerInfoClient {
  /** Registered nodes from one registry (`POST /serverinfolist`). */
  public static async list(
    registryUrl: string | null | undefined,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ServerInfo[]> {
    const base = registryUrl == null ? "" : registryUrl.trim().replace(/\/+$/, "");
    if (!base) return [];
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/serverinfolist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: ctrl?.signal,
      });
      if (!res.ok) return [];
      const parsed = (await res.json()) as ServerInfoListResponse;
      return parsed?.serverInfoList ?? [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Union the active URLs for `chain` across several registries (decentralized
   * bootstrap: never trust one registry). Order is registry order, deduped.
   */
  public static async listAll(
    registries: (string | null | undefined)[],
    chain?: string | null,
  ): Promise<string[]> {
    const urls: string[] = [];
    for (const registry of registries) {
      const infos = await ServerInfoClient.list(registry);
      for (const url of ServerInfoClient.activeUrlsForChain(infos, chain)) {
        if (!urls.includes(url)) urls.push(url);
      }
    }
    return urls;
  }

  /**
   * Active node URLs ordered for `chain`: chain-matched entries first, then
   * unlabelled (legacy) entries as a fallback. A different chain's node is
   * never returned.
   */
  public static activeUrlsForChain(
    infos: ServerInfo[] | null | undefined,
    chain?: string | null,
  ): string[] {
    const matched: string[] = [];
    const unknown: string[] = [];
    for (const info of infos ?? []) {
      const url = info?.url?.trim();
      if (!url) continue;
      if (info.status && info.status.toLowerCase() !== "active") continue;
      const entryChain = info.chain;
      if (!entryChain) unknown.push(url);
      else if (ServerInfoClient.chainMatches(chain, entryChain)) matched.push(url);
    }
    return matched.concat(unknown);
  }

  /**
   * Whether a registry entry's chain matches this node's chain. A node without
   * a chain accepts anything; an entry advertising a different chain never
   * matches.
   */
  public static chainMatches(nodeChain?: string | null, entryChain?: string | null): boolean {
    if (!nodeChain) return true;
    if (!entryChain) return true;
    return nodeChain.trim().toLowerCase() === entryChain.trim().toLowerCase();
  }
}
