/**
 * Bigtangle L0 chain evidence (docs/p2p.md). A lock/release is never "claimed",
 * it is proved: the engine reads the transaction status (and, for a lock, the
 * escrow UTXO) and fails closed on an unreachable node, a non-CONFIRMED status,
 * a wrong destination, or an insufficient amount.
 */
import { verifySettlement, type SettlementOutput } from "p2p-protocol";
import { addressHash160 } from "./escrow.js";

export interface ChainStatus {
  status?: string;
  address?: string;
  blockHash?: string;
  chainlength?: number;
}

export interface ChainEvidence {
  ok: boolean;
  reason?: string;
}

export interface ChainClient {
  transactionStatus(txHash: string): Promise<ChainStatus>;
  /** UTXO-shaped outputs for an h160 query key. */
  balances(hashHex: string): Promise<SettlementOutput[]>;
}

interface RawUtxo {
  address?: string;
  value?: number | string | { value?: number | string };
  tokenid?: string;
  tokenId?: string;
  spent?: boolean;
  spendPending?: boolean;
  confirmed?: boolean;
}

interface RawBalances {
  outputs?: RawUtxo[];
  tokennames?: Record<string, { tokensymbol?: string; tokenname?: string }>;
}

function amountOf(v: RawUtxo["value"]): string {
  const raw = v && typeof v === "object" ? v.value : v;
  const s = raw === undefined || raw === null ? "0" : String(raw);
  return /^\d+$/.test(s) ? s : String(Math.trunc(Number(s)) || 0);
}

/** Normalize a getBalances response into core `SettlementOutput`s. */
export function normalizeOutputs(
  outputs: readonly RawUtxo[],
  tokennames: RawBalances["tokennames"] = {},
): SettlementOutput[] {
  return outputs.map((o) => {
    const id = String(o.tokenid ?? o.tokenId ?? "");
    const meta = tokennames[id];
    return {
      address: String(o.address ?? ""),
      token: meta?.tokensymbol || meta?.tokenname || id,
      amount: amountOf(o.value),
      spent: o.spent === true || o.spendPending === true,
      confirmed: o.confirmed !== false,
    };
  });
}

export class HttpChainClient implements ChainClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  private get base(): string {
    return this.baseUrl.replace(/\/+$/, "");
  }

  async transactionStatus(txHash: string): Promise<ChainStatus> {
    const res = await this.fetchImpl(`${this.base}/getTransactionStatus`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`getTransactionStatus ${res.status}`);
    return (await res.json()) as ChainStatus;
  }

  async balances(hashHex: string): Promise<SettlementOutput[]> {
    const res = await this.fetchImpl(`${this.base}/getBalances`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([hashHex]),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`getBalances ${res.status}`);
    const raw = (await res.json()) as RawBalances;
    return normalizeOutputs(raw.outputs ?? [], raw.tokennames ?? {});
  }
}

/**
 * Prove a lock: the funding tx must be CONFIRMED and pay `escrowAddress`, and
 * (when token/amount are supplied) a confirmed escrow UTXO of at least
 * `amount` must exist. Fails closed.
 */
export async function verifyChainLock(
  chain: ChainClient,
  opts: { txHash: string; escrowAddress: string; token?: string; amount?: string },
): Promise<ChainEvidence> {
  if (!opts.txHash.trim()) return { ok: false, reason: "txHash required" };
  try {
    const st = await chain.transactionStatus(opts.txHash);
    if (!st.status) return { ok: false, reason: "L0 has no status for this transaction" };
    if (st.status !== "CONFIRMED") return { ok: false, reason: `transaction is ${st.status}, expected CONFIRMED` };
    if (st.address && st.address !== opts.escrowAddress) {
      return { ok: false, reason: `transaction pays ${st.address}, expected ${opts.escrowAddress}` };
    }
    if (opts.token && opts.amount) {
      const outputs = await chain.balances(Buffer.from(addressHash160(opts.escrowAddress)).toString("hex"));
      const check = verifySettlement(outputs, {
        toAddress: opts.escrowAddress,
        token: opts.token,
        amount: opts.amount,
      });
      if (!check.ok) return { ok: false, reason: check.error ?? "escrow amount not found" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `L0 unreachable (${String(e).slice(0, 100)})` };
  }
}

/** Prove a release: CONFIRMED and paying `toAddress`. Fails closed. */
export async function verifyChainPayment(
  chain: ChainClient,
  opts: { txHash: string; toAddress: string },
): Promise<ChainEvidence> {
  if (!opts.txHash.trim()) return { ok: false, reason: "txHash required" };
  try {
    const st = await chain.transactionStatus(opts.txHash);
    if (st.status !== "CONFIRMED") {
      return { ok: false, reason: st.status ? `transaction is ${st.status}, expected CONFIRMED` : "no status" };
    }
    if (st.address && st.address !== opts.toAddress) {
      return { ok: false, reason: `transaction pays ${st.address}, expected ${opts.toAddress}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `L0 unreachable (${String(e).slice(0, 100)})` };
  }
}
