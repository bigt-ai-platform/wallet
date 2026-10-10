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
  /** Raw UTXO JSON for an address (getOutputsHistory) — escrow outpoint lookup. */
  outputsHistory(address: string): Promise<RawUtxo[]>;
  /** Broadcast raw transaction bytes (submitTransaction); throws on rejection. */
  submitTransaction(rawTxHex: string): Promise<void>;
}

/** Raw getOutputs/getOutputsHistory output JSON (bigtangle `UTXO` shape). */
export interface RawUtxo {
  address?: string;
  /** Java `Coin` JSON: `{value, tokenHex}` (or a bare number/string). */
  value?: number | string | { value?: number | string; tokenHex?: string };
  tokenid?: string;
  tokenId?: string;
  spent?: boolean;
  spendPending?: boolean;
  confirmed?: boolean;
  /** Hex of the containing transaction — the escrow lock tx hash. */
  hashHex?: string;
  /** Hex of the containing block — required to rebuild an outpoint. */
  blockHashHex?: string;
  /** Hex of the output's scriptPubKey. */
  scriptHex?: string;
  index?: number;
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

  async outputsHistory(address: string): Promise<RawUtxo[]> {
    // Java-first (DatabaseFullBlockStoreBase.getOutputsHistory): the SQL ANDs
    // `outputs.fromaddress = ?` when fromaddress is set, and `fromaddress` is
    // the SENDER of the containing transaction (ServiceBase.fromAddress walks
    // the inputs), while `toaddress` is the receiver — every spend path
    // matches on toaddress alone. The escrow lock output is escrow-as-receiver,
    // so the address must go in the to slot; the from slot would only ever
    // find outputs the escrow itself created.
    const res = await this.fetchImpl(`${this.base}/getOutputsHistory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromaddress: "", toaddress: address, starttime: null, endtime: null }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`getOutputsHistory ${res.status}`);
    const raw = (await res.json()) as RawBalances;
    return raw.outputs ?? [];
  }

  /** Raw bytes, exactly like the wallet's broadcast path (octet-stream). */
  async submitTransaction(rawTxHex: string): Promise<void> {
    const res = await this.fetchImpl(`${this.base}/submitTransaction`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.from(rawTxHex, "hex"),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let body: { error?: string; errorcode?: number; message?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON response: fall through to the status check
    }
    if (!res.ok || body.error || (body.errorcode !== undefined && body.errorcode !== 0)) {
      throw new Error(body.message || body.error || `submitTransaction ${res.status}`);
    }
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
