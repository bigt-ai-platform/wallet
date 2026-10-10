/**
 * Escrow spend assembly (docs/p2p.md — the settlement closure).
 *
 * The 2-of-3 vault is spent by *rebuilding* the exact transaction both
 * parties agreed on and layering two signatures over it:
 *
 *   skeleton   Escrow.createSpend over the confirmed escrow UTXO — identical
 *              bytes on the wallet and the engine side (same vault, same
 *              blockHash/outpoint, same `escrowSpendAmount` fee rule), so a
 *              signature made anywhere verifies everywhere.
 *   two sigs   the caller's (seller presign or a party cosign) plus the
 *              engine's own key, ordered by redeem-script index — the order
 *              OP_CHECKMULTISIG is strict about.
 *
 * The engine submits the finished transaction, waits for CONFIRMED, and only
 * then lets the state machine move. Everything here fails closed: a missing
 * outpoint, an unverifiable signature, an engine key that is not vault
 * participant, or an unreachable L0 all abort before anything is broadcast.
 */
import {
  Address,
  Coin,
  Escrow,
  FreeStandingTransactionOutput,
  PQKey,
  ScriptBuilder,
  Sha256Hash,
  SignatureBundle,
  SigHash,
  UTXO,
  Utils,
  escrowSpendAmount,
  type Transaction,
} from "bigtangle-ts";
import type { ChainClient } from "./chain.js";
import { settlementParams } from "./escrow.js";
import { pqPubFromDid } from "did/pq";

export type EscrowKind = "release" | "refund";

/** The vault a swap's escrow address was derived from, or null (missing/non-PQ key). */
export function vaultFor(
  sellerDid: string | undefined,
  buyerDid: string | undefined,
  enginePubkeyHex: string,
): Escrow | null {
  if (!sellerDid || !buyerDid || !enginePubkeyHex) return null;
  const keys: PQKey[] = [];
  for (const did of [sellerDid, buyerDid]) {
    try {
      keys.push(keyFromDid(did));
    } catch {
      return null;
    }
  }
  try {
    keys.push(PQKey.fromPrefixedPublicKey(Utils.HEX.decode(enginePubkeyHex)));
    return Escrow.twoOfThree({ seller: keys[0], buyer: keys[1], engine: keys[2] });
  } catch {
    return null;
  }
}

/** The PQ public key a did:key carries (throws for classic/Ed25519 dids). */
export function keyFromDid(did: string): PQKey {
  return PQKey.fromPrefixedPublicKey(pqPubFromDid(did));
}

export function engineSigner(env: NodeJS.ProcessEnv): PQKey {
  const keyHex = env.SETTLEMENT_ENGINE_KEY?.trim() || "";
  if (!keyHex) throw new Error("SETTLEMENT_ENGINE_KEY is not configured");
  const key = PQKey.fromPrivateKeyHex(keyHex);
  const pubHex = env.SETTLEMENT_ENGINE_PUBKEY?.trim() || "";
  if (pubHex && Utils.HEX.encode(key.getPrefixedPublicKeyBytes()) !== pubHex) {
    throw new Error("SETTLEMENT_ENGINE_KEY does not match SETTLEMENT_ENGINE_PUBKEY");
  }
  return key;
}

/** One reconstructed escrow outpoint: the unspent output of the lock tx. */
export interface EscrowOutpoint {
  utxo: FreeStandingTransactionOutput;
  blockHash: Sha256Hash;
  value: Coin;
  txHash: string;
  index: number;
}

/**
 * Locate the escrow output inside the funding transaction. Fails closed when
 * the lock tx is unknown, the output is missing/spent, or the history does
 * not actually pay `escrowAddress`.
 */
export async function escrowOutpoint(
  chain: ChainClient,
  escrowAddress: string,
  escrowTxHash: string,
): Promise<EscrowOutpoint | null> {
  const outputs = await chain.outputsHistory(escrowAddress);
  const raw = outputs.find(
    (o) =>
      o &&
      String(o.hashHex ?? "") === escrowTxHash &&
      o.spent !== true &&
      (!o.address || String(o.address) === escrowAddress),
  );
  if (!raw || typeof raw.scriptHex !== "string" || !raw.blockHashHex) return null;
  const params = settlementParams();
  const utxo = UTXO.fromJSONObject(raw);
  const blockHash = utxo.getBlockHash();
  if (!blockHash) return null;
  return {
    utxo: new FreeStandingTransactionOutput(params, utxo),
    blockHash,
    value: utxo.getValue(),
    txHash: escrowTxHash,
    index: utxo.getIndex(),
  };
}

export interface Skeleton {
  tx: Transaction;
  sighash: Sha256Hash;
  outpoint: EscrowOutpoint;
  /** What the spend pays out (value minus the BIG fee, or the full value). */
  amount: Coin;
}

/**
 * Rebuild the unsigned spend: identical bytes on every machine that follows
 * this rule (docs/p2p.md §settlement closure).
 */
export async function buildSkeleton(opts: {
  chain: ChainClient;
  vault: Escrow;
  escrowAddress: string;
  escrowTxHash: string;
  to: Address;
}): Promise<Skeleton | null> {
  const outpoint = await escrowOutpoint(opts.chain, opts.escrowAddress, opts.escrowTxHash);
  if (!outpoint) return null;
  const amount = escrowSpendAmount(outpoint.value);
  const tx = opts.vault.createSpend({
    params: settlementParams(),
    blockHash: outpoint.blockHash,
    utxo: outpoint.utxo,
    to: opts.to,
    amount,
  });
  const sighash = tx.hashForSignature(0, opts.vault.redeemScript.getProgram(), SigHash.ALL, false);
  return { tx, sighash, outpoint, amount };
}

/** Verify a hex SignatureBundle against one vault participant. Fails closed. */
export function verifyParticipantSig(sighash: Sha256Hash, sigHex: string, pubkey: PQKey): boolean {
  if (!sigHex || sigHex.length > 20_000) return false;
  try {
    return PQKey.verify(sighash, SignatureBundle.deserialize(Utils.HEX.decode(sigHex)), pubkey.getPubKey());
  } catch {
    return false;
  }
}

/**
 * Write the assembled scriptSig: `OP_0 <sig…> <redeemProgram>` with the
 * signatures in redeem-script order (OP_CHECKMULTISIG pops them in order).
 */
export function assembleSpend(vault: Escrow, tx: Transaction, sigHexByIndex: Map<number, string>): number {
  const ordered = [...sigHexByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, vault.threshold)
    .map(([, hex]) => Utils.HEX.decode(hex));
  if (ordered.length < vault.threshold) {
    throw new Error(`need ${vault.threshold} signatures, got ${ordered.length}`);
  }
  tx.getInput(0).setScriptSig(ScriptBuilder.createMultiSigInputScript(ordered, vault.redeemScript.getProgram()));
  return ordered.length;
}

export interface SpendOutcome {
  txHash: string;
  confirmed: boolean;
  /** Last observed status while polling (MEMPOOL/BATCHED/IN_BLOCK/SOLID/CONFIRMED). */
  status?: string;
  reason?: string;
}

/** Broadcast raw bytes; throws when the mempool rejects the transaction. */
export async function broadcastSpend(chain: ChainClient, tx: Transaction): Promise<void> {
  await chain.submitTransaction(Utils.HEX.encode(tx.bitcoinSerialize()));
}

/**
 * Poll an already-submitted transaction until CONFIRMED (or a failure status).
 * `pollMs: 0` performs a single check. Never throws after the first attempt —
 * an unreachable L0 just keeps the last observed status, so the caller can
 * leave the swap where it is and retry on the next escrow-hook tick.
 */
export async function awaitConfirmed(
  chain: ChainClient,
  txHash: string,
  toAddress: Address,
  opts: { pollMs: number; intervalMs: number },
): Promise<SpendOutcome> {
  const deadline = Date.now() + opts.pollMs;
  let status = "";
  for (;;) {
    try {
      const st = await chain.transactionStatus(txHash);
      status = st.status ?? "";
      if (status === "CONFIRMED") {
        if (st.address && st.address !== toAddress.toBase58()) {
          return { txHash, confirmed: false, status, reason: `pays ${st.address}, expected ${toAddress.toBase58()}` };
        }
        return { txHash, confirmed: true, status };
      }
      if (status === "DROPPED") {
        return { txHash, confirmed: false, status, reason: "transaction was dropped from the chain" };
      }
    } catch (e) {
      status = `L0 unreachable (${String(e).slice(0, 80)})`;
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  return { txHash, confirmed: false, status: status || undefined, reason: "not confirmed before timeout" };
}

/** Parse a base58 destination, failing closed on anything unparseable. */
export function destAddress(base58: string): Address | null {
  try {
    return Address.fromBase58(settlementParams(), base58);
  } catch {
    return null;
  }
}
