import { MainNetParams, Utils, type NetworkParameters, type Transaction } from 'bigtangle-ts';
import { verifyRecordSig } from 'record-sig';
import { P2P_ORDER_TYPE, P2P_RELEASE_TYPE, P2P_SWAP_TYPE } from 'p2p-protocol';

/**
 * Wallet-side L1-SOCIAL reader — the seed of engine independence (docs/p2p.md
 * §18.5 / §26).
 *
 * The P2P records (`social.p2p-order`, `social.p2p-swap`, `social.p2p-release`)
 * are anchored on L1-SOCIAL and are therefore readable by anyone. Today the
 * wallet gets all of this from the p2p-engine's HTTP API; to trade without an
 * engine it must read them itself. This module is the app-side port of the
 * engine's projector walk (`services/p2p-engine/src/replay.ts`): `getTips` →
 * `getBlockByHash` by prev-hash, extract every `SocialRecord`-class tx data,
 * verify its author signature and classify the record.
 *
 * It is read-only and stores nothing: callers fold the entries into UI state or
 * their own cache. PII is *not* here — by design the chain carries only the
 * public fields (§14); payment profiles / receive addresses stay in the engine
 * store or the counterparty's record.
 */

/** The typed-data class tag every `social.*` record rides under. */
export const SOCIAL_DATA_CLASS = 'SocialRecord';

/** The record families the P2P feature cares about (plus everything else). */
export type SocialRecordKind = 'order' | 'swap' | 'release' | 'other';

/** The `type` field of a decoded record, or null when absent/not a string. */
export function socialRecordType(record: unknown): string | null {
  if (!record || typeof record !== 'object') return null;
  const t = (record as Record<string, unknown>).type;
  return typeof t === 'string' ? t : null;
}

/** Map a decoded record to its P2P family (by the `type` discriminator). */
export function classifySocialRecord(record: unknown): SocialRecordKind {
  switch (socialRecordType(record)) {
    case P2P_ORDER_TYPE: return 'order';
    case P2P_SWAP_TYPE: return 'swap';
    case P2P_RELEASE_TYPE: return 'release';
    default: return 'other';
  }
}

/** One social record located in a transaction, with its author-sig verdict. */
export interface SocialRecordEntry {
  /** The anchor transaction's hash. */
  txid: string;
  record: Record<string, unknown>;
  kind: SocialRecordKind;
  /** `record-sig` verifyRecordSig over the record's own `sig`. */
  verified: boolean;
}

/**
 * Extract the social record from one transaction, or null. Mirrors the engine's
 * extraction exactly: only `dataclassname === "SocialRecord"` with non-empty
 * data; malformed JSON yields a garbage record (counted, never trusted).
 */
export function extractSocialRecord(tx: Transaction): { txid: string; record: Record<string, unknown> } | null {
  if (tx.getDataClassName() !== SOCIAL_DATA_CLASS) return null;
  const data = tx.getData();
  if (!data || !data.length) return null;
  const txid = tx.getHash().toString();
  try {
    return { txid, record: JSON.parse(new TextDecoder().decode(data)) as Record<string, unknown> };
  } catch {
    return { txid, record: { type: '__garbage__' } };
  }
}

/** Extract + classify + verify every social record carried by these txs. */
export function extractSocialRecords(txs: readonly Transaction[]): SocialRecordEntry[] {
  const out: SocialRecordEntry[] = [];
  for (const tx of txs) {
    const found = extractSocialRecord(tx);
    if (!found) continue;
    let verified = false;
    try {
      verified = verifyRecordSig(found.record as never);
    } catch {
      verified = false;
    }
    out.push({ txid: found.txid, record: found.record, kind: classifySocialRecord(found.record), verified });
  }
  return out;
}

/** One block's social records, with the links the walk needs. */
export interface SocialBlock {
  hash: string;
  prevHash: string;
  height: number;
  entries: SocialRecordEntry[];
}

/** A read-only L1-SOCIAL source (injectable for tests). */
export interface SocialSource {
  /** The current head block hash (`getTips` → prevBlockHash). */
  head(): Promise<{ hash: string }>;
  /** One block's social records, or null when the node has no such block. */
  blockByHash(hash: string): Promise<SocialBlock | null>;
}

/** L1-SOCIAL read path: `getTips` + `getBlockByHash` (dataHex blocks). */
export class HttpSocialSource implements SocialSource {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
    private readonly params: NetworkParameters = MainNetParams.get(),
  ) {}

  private get base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  private async post<T>(cmd: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/${cmd}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`${cmd} ${res.status}`);
    return (await res.json()) as T;
  }

  async head(): Promise<{ hash: string }> {
    const res = await this.post<{ text?: string; message?: string }>('getTips', {});
    const raw = res.text ?? res.message;
    if (!raw) throw new Error('getTips: empty payload');
    const tips = JSON.parse(raw) as { prevBlockHash?: string };
    if (!tips.prevBlockHash) throw new Error('getTips: no prevBlockHash');
    // The rolling prototype's prev IS the current head block.
    return { hash: tips.prevBlockHash };
  }

  async blockByHash(hash: string): Promise<SocialBlock | null> {
    const res = await this.post<{ dataHex?: string }>('getBlockByHash', { hashHex: hash });
    if (!res.dataHex) return null;
    const block = this.params.getDefaultSerializer().makeBlock(Utils.HEX.decode(res.dataHex));
    return {
      hash: block.getHash().toString(),
      prevHash: block.getPrevBlockHash().toString(),
      height: block.getHeight(),
      entries: extractSocialRecords(block.getTransactions() ?? []),
    };
  }
}

/**
 * Walk L1-SOCIAL back from the head, newest first, collecting social records
 * until `maxBlocks` blocks have been read (or the chain ends / a cycle is
 * seen). Bounded on purpose: the wallet reads a recent window, not history.
 */
export async function collectSocialRecords(
  src: SocialSource,
  opts: { maxBlocks: number },
): Promise<SocialRecordEntry[]> {
  const out: SocialRecordEntry[] = [];
  const seen = new Set<string>();
  let hash = (await src.head()).hash;
  for (let i = 0; i < opts.maxBlocks && hash; i++) {
    if (seen.has(hash)) break;
    seen.add(hash);
    const block = await src.blockByHash(hash);
    if (!block) break;
    out.push(...block.entries);
    if (!block.prevHash || block.prevHash === hash) break;
    hash = block.prevHash;
  }
  return out;
}
