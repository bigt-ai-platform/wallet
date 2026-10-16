import {
  Escrow,
  PQKey,
  ScriptBuilder,
  SignatureBundle,
  Utils,
  type Sha256Hash,
  type Transaction,
} from 'bigtangle-ts';
import {
  p2pReleaseRecord,
  validateP2pReleaseRecord,
  type P2pReleaseKind,
  type P2pReleaseRecord,
} from 'p2p-protocol';
import { buildEscrowSpend, keyFromDid, signEscrow, type EscrowHistoryOutput, type EscrowSpend } from './p2pEscrow';

/**
 * Cooperative (engine-free) escrow release — draft, docs/p2p.md §6.
 *
 * The vault is *any two of three*, so the seller and buyer can settle a swap
 * themselves. Both rebuild the identical deterministic skeleton
 * (`buildEscrowSpend` — same vault, outpoint, `escrowSpendAmount` fee rule),
 * each signs the sighash with their own key (`signEscrow` from `./p2pEscrow`),
 * and either side orders the two signature bundles by redeem-script position,
 * writes the scriptSig and broadcasts. The engine never signs and no engine
 * server is in the loop.
 *
 * What still needs a channel: the two signature blobs. Without the engine's
 * `POST /escrow/cosign` there is nothing to collect them, so the parties
 * exchange them out of band — over the swap's `social.*` record, a relay, or a
 * direct DID-to-DID message. Because the skeleton is deterministic, only the
 * signatures cross the wire, never the transaction bytes.
 *
 * This is the cooperative case only. It does NOT replace the engine's
 * `engine + buyer` forced release or `engine + seller` refund, which are the
 * paths a lone party needs when the other will not sign (docs/p2p.md §6/§13).
 */

/** One participant's signature over a release/refund skeleton. */
export interface CoopSignature {
  /** The vault participant the signature belongs to (its public key). */
  signer: PQKey;
  /** Hex-encoded `SignatureBundle.serialize()` over the skeleton sighash. */
  sigHex: string;
}

/** Verify one hex signature against the participant it claims to be. Fails closed. */
export function verifyCoopSignature(sighash: Sha256Hash, sig: CoopSignature): boolean {
  if (!sig.sigHex || sig.sigHex.length > 20_000) return false;
  try {
    return PQKey.verify(
      sighash,
      SignatureBundle.deserialize(Utils.HEX.decode(sig.sigHex)),
      sig.signer.getPubKey(),
    );
  } catch {
    return false;
  }
}

/**
 * Order `threshold` signatures by redeem-script position and write the
 * scriptSig `OP_0 <sig…> <redeemProgram>` into `tx` input 0 — the order
 * `OP_CHECKMULTISIG` is strict about. Fails closed: a non-participant, an
 * invalid signature, a duplicate or too few signatures all throw before the tx
 * is broadcast.
 */
export function assembleCoopRelease(
  vault: Escrow,
  tx: Transaction,
  sighash: Sha256Hash,
  sigs: readonly CoopSignature[],
): number {
  const byIndex = new Map<number, Uint8Array>();
  for (const sig of sigs) {
    const i = vault.indexOf(sig.signer);
    if (i < 0) throw new Error('signer is not a participant of this escrow');
    if (byIndex.has(i)) throw new Error(`duplicate signer at escrow index ${i}`);
    if (!verifyCoopSignature(sighash, sig)) throw new Error(`invalid escrow signature at index ${i}`);
    byIndex.set(i, Utils.HEX.decode(sig.sigHex));
  }
  if (byIndex.size < vault.threshold) {
    throw new Error(`need ${vault.threshold} signatures, got ${byIndex.size}`);
  }
  const ordered = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, vault.threshold)
    .map(([, bytes]) => bytes);
  tx.getInput(0).setScriptSig(
    ScriptBuilder.createMultiSigInputScript(ordered, vault.redeemScript.getProgram()),
  );
  return ordered.length;
}

/**
 * Full cooperative release: rebuild the skeleton paying `toBase58`, verify and
 * assemble the collected signatures, and return the raw tx hex for
 * `POST /submitTransaction` (plus the tx for `correctlySpends` checks). Returns
 * null when the lock output is missing — fail closed.
 */
export function buildCoopReleaseTx(opts: {
  vault: Escrow;
  outputs: readonly EscrowHistoryOutput[] | undefined;
  escrowAddress: string;
  escrowTxHash: string;
  toBase58: string;
  sigs: readonly CoopSignature[];
}): { txHex: string; tx: Transaction } | null {
  const spend = buildEscrowSpend(opts);
  if (!spend) return null;
  assembleCoopRelease(opts.vault, spend.tx, spend.sighash, opts.sigs);
  return { txHex: Utils.HEX.encode(spend.tx.bitcoinSerialize()), tx: spend.tx };
}

/**
 * What the two parties must agree on before a signature is exchanged: the
 * rebuilt skeleton plus the identifiers an incoming `social.p2p-release`
 * record is checked against. `kind`/`toAddress`/`escrowTxHash` pin the record
 * to *this* spend, so a counterparty cannot hand over a signature over a
 * different destination or a different lock.
 */
export interface CoopReleaseContext {
  vault: Escrow;
  spend: EscrowSpend;
  escrowTxHash: string;
  kind: P2pReleaseKind;
  toAddress: string;
}

/**
 * The `social.p2p-release` record a party anchors (or hands over out of band)
 * to give the counterparty its escrow signature. Authors the record with this
 * party's own signature over the shared skeleton sighash.
 */
export function buildCoopReleaseRecord(opts: {
  key: PQKey;
  /** This party's did:key (must match `key`). */
  from: string;
  swapId: string;
  kind: P2pReleaseKind;
  escrowTxHash: string;
  toAddress: string;
  spend: EscrowSpend;
  ts?: number;
}): P2pReleaseRecord {
  return p2pReleaseRecord({
    from: opts.from,
    to: opts.swapId,
    kind: opts.kind,
    escrowTxHash: opts.escrowTxHash,
    toAddress: opts.toAddress,
    escrowSig: signEscrow(opts.key, opts.spend.sighash),
    ts: opts.ts,
  });
}

/**
 * Verify a counterparty's `social.p2p-release` against the locally rebuilt
 * skeleton and return its escrow signature. Fails closed on a malformed
 * record, a mismatched kind/destination/lock, a non-PQ author, or a signature
 * that does not verify over this spend's sighash.
 */
export function acceptCoopRelease(
  record: Partial<P2pReleaseRecord>,
  ctx: CoopReleaseContext,
): CoopSignature {
  const valid = validateP2pReleaseRecord(record);
  if (!valid.ok) throw new Error(`invalid release record: ${valid.error}`);
  if (record.kind !== ctx.kind) throw new Error(`release record kind ${record.kind} != ${ctx.kind}`);
  if (record.escrowTxHash !== ctx.escrowTxHash) throw new Error('release record is for a different lock');
  if (record.toAddress !== ctx.toAddress) throw new Error('release record pays a different address');
  let signer: PQKey;
  try {
    signer = keyFromDid(record.from!);
  } catch {
    throw new Error('release record author is not a PQ did:key');
  }
  const sig: CoopSignature = { signer, sigHex: record.escrowSig! };
  if (!verifyCoopSignature(ctx.spend.sighash, sig)) throw new Error('invalid escrow signature');
  return sig;
}

/**
 * Cooperative settle: verify the counterparty's record against the shared
 * skeleton, add this party's own signature, assemble the scriptSig and return
 * the raw tx hex for `POST /submitTransaction`. No engine involved.
 */
export function combineCoopRelease(
  ctx: CoopReleaseContext,
  ownKey: PQKey,
  counterparty: Partial<P2pReleaseRecord>,
): { txHex: string; tx: Transaction } {
  const theirs = acceptCoopRelease(counterparty, ctx);
  const ours: CoopSignature = { signer: ownKey, sigHex: signEscrow(ownKey, ctx.spend.sighash) };
  assembleCoopRelease(ctx.vault, ctx.spend.tx, ctx.spend.sighash, [theirs, ours]);
  return { txHex: Utils.HEX.encode(ctx.spend.tx.bitcoinSerialize()), tx: ctx.spend.tx };
}
