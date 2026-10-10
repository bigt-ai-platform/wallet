/**
 * L1-SOCIAL chain anchor for swap events (docs/p2p.md step 8).
 *
 * Every durable transition is anchored as a signed `social.p2p-swap` record on
 * the L1-SOCIAL chain. The record rides in the transaction's typed data
 * (`dataclassname="SocialRecord"`), the same path every `social.*` record uses;
 * the social server's ingestion gate accepts any `social.*` type, so no chain
 * change is needed. The engine owns its own validation/projection because dai
 * no longer knows the type.
 *
 * The engine signs the record with its own PQ (ML-DSA-87) did:key
 * (`SETTLEMENT_ENGINE_KEY` seed, `SETTLEMENT_ENGINE_DID` = didFromPQKey) and
 * funds/signs the submit transaction with the same key. Anchoring runs *before*
 * the event is appended to the engine store: if the chain path is down the
 * transition fails and the caller retries, so the rebuildable store never holds
 * a state the durable chain seed lacks (AGENTS.md invariant #1). No key / no
 * URL → no hook, which is the mock mode.
 */
import { Coin, NetworkParameters, TestParams, Transaction, Wallet } from "bigtangle-ts";
import { Utils } from "bigtangle-ts";
import { PQKey } from "bigtangle-ts";
import { didFromPQKey, signChallengePQ } from "did/pq";
import { recordDigest } from "record-sig";
import { p2pSwapRecord, type P2pSwapRecord } from "p2p-protocol";
import type { P2pSwapEvent } from "./types.js";

export type SignedSwapRecord = P2pSwapRecord & { sig: string; sigScheme: string };

export interface L1Anchor {
  l1Url: string;
  pqKey: PQKey;
  did: string;
  /** Discovery: resolve the current healthy L1-SOCIAL base (null = none). */
  resolveUrl?: () => string | null;
}

const BIG = NetworkParameters.getBIGTANGLE_TOKENID();

/**
 * Resolve the engine's anchor identity from env, or null when incomplete.
 * The key is the ML-DSA-87 seed (64 or 128 hex chars) that both signs the
 * record and funds the submit tx; when `SETTLEMENT_ENGINE_DID` is set it must
 * match the derived did:key.
 */
export function anchorFromEnv(env: NodeJS.ProcessEnv): L1Anchor | null {
  const l1Url = (env.SETTLEMENT_L1_SOCIAL_URLS?.split(",")[0]?.trim()
    || env.SETTLEMENT_L1_URL?.trim()
    || env.SETTLEMENT_L1_SOCIAL_URL?.trim()
    || env.L1_SOCIAL_URL?.trim()
    || "").replace(/\/+$/, "");
  const keyHex = env.SETTLEMENT_ENGINE_KEY?.trim() || "";
  if (!l1Url || !keyHex) return null;
  let pqKey: PQKey;
  try {
    pqKey = PQKey.fromPrivateKeyHex(keyHex);
  } catch {
    return null;
  }
  const did = didFromPQKey(pqKey);
  const declared = env.SETTLEMENT_ENGINE_DID?.trim();
  if (declared && declared !== did) return null;
  return { l1Url, pqKey, did };
}

/** The `social.p2p-swap` record for one swap event (fiat PII stays off chain). */
export function swapEventRecord(event: P2pSwapEvent, from: string): P2pSwapRecord {
  return p2pSwapRecord({
    from,
    to: event.swapId,
    status: event.status,
    swapSeq: event.seq,
    orderId: event.orderId,
    sellerDid: event.sellerDid,
    buyerDid: event.buyerDid,
    giveChain: event.giveChain,
    giveToken: event.giveToken,
    giveAmount: event.giveAmount,
    wantAmount: event.wantAmount,
    wantRail: event.wantRail,
    wantCurrency: event.wantCurrency,
    escrowAddress: event.escrowAddress,
    escrowTxHash: event.escrowTxHash,
    releaseTxHash: event.releaseTxHash,
    paymentRail: event.paymentRail,
    paymentRef: event.paymentRef,
    payoutRef: event.payoutRef,
    // CNY receipt evidence anchors as a hash only — the image stays in the
    // engine store (docs/p2pcny.md §8).
    receiptSha256: event.receiptSha256,
    ts: event.at,
  });
}

/** Author-sign the record with the engine's PQ key (mldsa scheme). */
export function signSwapRecord(record: P2pSwapRecord, pqKey: PQKey): SignedSwapRecord {
  return { ...record, sigScheme: "mldsa", sig: signChallengePQ(pqKey, recordDigest(record)) };
}

function arraysEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const A = typeof a === "string" ? Utils.HEX.decode(a) : a;
  const B = typeof b === "string" ? Utils.HEX.decode(b) : b;
  return A.length === B.length && A.every((v, i) => v === B[i]);
}

/**
 * Submit a signed record as a typed data-class transaction to L1-SOCIAL —
 * mirrors how OrderOpen/StakeDeposit are built: inputs from spendable
 * candidates, zero-value self change, signed, submitted.
 */
export async function submitSocialRecord(l1Url: string, pqKey: PQKey, record: unknown): Promise<string> {
  const params = TestParams.get();
  const url = l1Url.endsWith("/") ? l1Url : l1Url + "/";
  const wallet = Wallet.fromKeysURL(params, [pqKey], url);

  const coinList = await wallet.calculateAllSpendCandidates(null, false);
  const tx = new Transaction(params);
  tx.setData(new TextEncoder().encode(JSON.stringify(record)));
  tx.setDataClassName("SocialRecord");

  let beneficiary: unknown = null;
  let amount = Coin.valueOf(0n, BIG).negate();
  if ((wallet as unknown as { getFee(): boolean }).getFee()) {
    amount = amount.add((Coin as unknown as { FEE_DEFAULT: Coin }).FEE_DEFAULT.negate());
  }
  for (const spendable of coinList) {
    const utxo = spendable.getUTXO();
    if (!utxo || !arraysEqual(utxo.getValue().getTokenid(), BIG)) continue;
    beneficiary = await (wallet as unknown as { getECKey(a: unknown, b: unknown): Promise<unknown> }).getECKey(null, utxo.getAddress());
    amount = amount.add(utxo.getValue());
    tx.addInput2(utxo.getBlockHash(), spendable);
    if (!amount.isNegative()) {
      if (amount.isPositive()) tx.addOutputEckey(amount, beneficiary as never);
      break;
    }
  }
  if (beneficiary == null || amount.isNegative()) {
    throw new Error("insufficient spendable outputs for social tx");
  }

  await (wallet as unknown as { signTransaction(t: Transaction, a: unknown, m: string): Promise<void> }).signTransaction(tx, null, "THROW");
  await wallet.submitTransaction(tx);
  return tx.getHash().toString();
}

export type SubmitRecord = (l1Url: string, pqKey: PQKey, record: unknown) => Promise<string>;

/** Build the `deps.anchor` hook: sign the record and submit it to L1-SOCIAL. */
export function l1Anchor(cfg: L1Anchor, submit: SubmitRecord = submitSocialRecord): (event: P2pSwapEvent) => Promise<{ txid?: string }> {
  return async (event: P2pSwapEvent) => {
    // Discovery pool when present: the configured `l1Url` is only the boot
    // candidate, and a pool that has gone dark fails closed (transition
    // errors, caller retries — never an anchor to an unverified node).
    const resolved = (cfg.resolveUrl ? cfg.resolveUrl() : cfg.l1Url) ?? "";
    const l1Url = resolved.replace(/\/+$/, "");
    if (!l1Url) throw new Error("no healthy L1-SOCIAL endpoint (discovery)");
    const record = signSwapRecord(swapEventRecord(event, cfg.did), cfg.pqKey);
    const txid = await submit(l1Url, cfg.pqKey, record);
    return { txid };
  };
}
