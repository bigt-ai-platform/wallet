import {
  Address,
  Base58,
  Escrow,
  FreeStandingTransactionOutput,
  MainNetParams,
  PQKey,
  SigHash,
  TestParams,
  UTXO,
  Utils,
  escrowSpendAmount,
  type Coin,
  type NetworkParameters,
  type Sha256Hash,
  type Transaction,
} from 'bigtangle-ts';

/**
 * Wallet-side escrow signing (docs/p2p.md — the settlement closure). The wallet
 * rebuilds the exact spend skeleton the engine will rebuild — same 2-of-3
 * vault, same confirmed lock UTXO, same `escrowSpendAmount` fee rule — and
 * signs its sighash with the wallet's PQ key, so the signature verifies over
 * there over identical bytes.
 *
 * Mirrors services/p2p-engine/src/escrowSpend.ts but with bigtangle-ts only:
 * the `did` package pulls in node:crypto (Metro-hostile), so the did:key
 * helpers are reimplemented here the same way `p2pIdentity.ts` does.
 */
const MULTICODEC_MLDSA87 = 0x300001;

/** Uvarint decoder (same algorithm as `packages/did` decodeUvarint). */
function decodeUvarint(data: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0, shift = 0, i = offset;
  while (i < data.length) { const b = data[i]; value |= (b & 0x7f) << shift; i++; if (!(b & 0x80)) break; shift += 7; }
  return { value, length: i - offset };
}

/** The PQ public key a did:key carries (throws for classic/Ed25519 dids). */
export function pqPubFromDid(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error('unsupported DID format');
  const decoded = Base58.decode(did.slice(9));
  const { value, length } = decodeUvarint(decoded, 0);
  if (value !== MULTICODEC_MLDSA87) throw new Error(`unsupported multicodec: 0x${value.toString(16)}`);
  return decoded.slice(length);
}

export function keyFromDid(did: string): PQKey {
  return PQKey.fromPrefixedPublicKey(pqPubFromDid(did));
}

/**
 * The vault a swap's escrow address was derived from — the key order
 * (seller, buyer, engine) must match the engine's `vaultFor` exactly, since
 * the redeem script (and therefore the sighash) depends on it. Null when a
 * party did is missing or carries no PQ key.
 */
export function escrowVault(
  sellerDid: string | undefined,
  buyerDid: string | undefined,
  enginePubkeyHex: string,
): Escrow | null {
  if (!sellerDid || !buyerDid || !enginePubkeyHex) return null;
  try {
    return Escrow.twoOfThree({
      seller: keyFromDid(sellerDid),
      buyer: keyFromDid(buyerDid),
      engine: PQKey.fromPrefixedPublicKey(Utils.HEX.decode(enginePubkeyHex)),
    });
  } catch {
    return null;
  }
}

/** One raw `getOutputsHistory` row (bigtangle `UTXO` JSON shape). */
export interface EscrowHistoryOutput {
  hashHex?: string;
  blockHashHex?: string;
  scriptHex?: string;
  address?: string;
  spent?: boolean;
  value?: unknown;
  index?: number;
}

/**
 * Locate the escrow output inside the lock transaction — the same filter the
 * engine applies (unspent, pays the escrow address, has script + block).
 */
export function findEscrowOutput(
  outputs: readonly EscrowHistoryOutput[] | undefined,
  escrowTxHash: string,
  escrowAddress: string,
): EscrowHistoryOutput | null {
  if (!outputs) return null;
  const raw = outputs.find(
    (o) =>
      o &&
      String(o.hashHex ?? '') === escrowTxHash &&
      o.spent !== true &&
      (!o.address || String(o.address) === escrowAddress),
  );
  if (!raw || typeof raw.scriptHex !== 'string' || !raw.blockHashHex) return null;
  return raw;
}

export interface EscrowSkeleton {
  /** The digest both signatures (participant + engine) cover. */
  sighash: Sha256Hash;
}

/**
 * The rebuilt *unsigned* spend plus the digest its signatures cover. Kept
 * alongside {@link EscrowSkeleton} so a cooperative (engine-free) release can
 * assemble the finished transaction locally instead of handing the skeleton to
 * the engine.
 */
export interface EscrowSpend {
  tx: Transaction;
  sighash: Sha256Hash;
  /** Value of the escrow output the spend consumes. */
  value: Coin;
}

/**
 * The network params a base58 address belongs to. The app can be pointed at
 * testnet (settings.useTestnet) while this module defaults to mainnet, so try
 * each rather than assuming — the wrong one throws in `Address.fromBase58`.
 */
function paramsForAddress(base58: string): NetworkParameters {
  try {
    Address.fromBase58(MainNetParams.get(), base58);
    return MainNetParams.get();
  } catch {
    return TestParams.get();
  }
}

/**
 * Rebuild the unsigned spend over the lock output and hash input 0 for
 * signing. Throws only on an unparseable destination; a missing lock output
 * returns null (fail closed — the caller never signs unrelated bytes).
 */
export function buildEscrowSpend(opts: {
  vault: Escrow;
  outputs: readonly EscrowHistoryOutput[] | undefined;
  escrowAddress: string;
  escrowTxHash: string;
  toBase58: string;
}): EscrowSpend | null {
  const raw = findEscrowOutput(opts.outputs, opts.escrowTxHash, opts.escrowAddress);
  if (!raw) return null;
  const utxo = UTXO.fromJSONObject(raw);
  const blockHash = utxo.getBlockHash();
  if (!blockHash) return null;
  // Params follow the destination (the spend output script is params-agnostic;
  // only base58 parsing is not), so the same skeleton is built on testnet.
  const params = paramsForAddress(opts.toBase58);
  const tx = opts.vault.createSpend({
    params,
    blockHash,
    utxo: new FreeStandingTransactionOutput(params, utxo),
    to: Address.fromBase58(params, opts.toBase58),
    amount: escrowSpendAmount(utxo.getValue()),
  });
  const sighash = tx.hashForSignature(0, opts.vault.redeemScript.getProgram(), SigHash.ALL, false);
  return { tx, sighash, value: utxo.getValue() };
}

/** {@link buildEscrowSpend}, reduced to the digest the engine's API expects. */
export function buildEscrowSighash(opts: {
  vault: Escrow;
  outputs: readonly EscrowHistoryOutput[] | undefined;
  escrowAddress: string;
  escrowTxHash: string;
  toBase58: string;
}): EscrowSkeleton | null {
  const spend = buildEscrowSpend(opts);
  return spend ? { sighash: spend.sighash } : null;
}

/** Hex-encoded SignatureBundle over an escrow sighash (the engine's shape). */
export function signEscrow(key: PQKey, sighash: Sha256Hash): string {
  return Utils.HEX.encode(key.sign(sighash).serialize());
}

/**
 * The escrow participant pubkey to derive a vault with (docs/p2p.md §26/§27).
 *
 * A counterparty-supplied `pinned` key (from the order/swap record) is trusted
 * **only** if it is in `allow` (the operator's engine allowlist) or, when the
 * list is empty, equals the engine the wallet is already configured with
 * (`capsPubkey`). That rejects a seller pinning its own key — the fiat-rug
 * vector (§27.4 #1). With no pin, the configured engine's key is used.
 */
export function vaultEnginePubkey(
  pinned: string | null | undefined,
  capsPubkey: string | null | undefined,
  allow: readonly string[] = [],
): string | null {
  const p = (pinned ?? '').trim();
  const c = (capsPubkey ?? '').trim();
  if (!p) return c || null;
  const permitted = allow.length ? allow.includes(p) : !!c && p === c;
  return permitted ? p : null;
}

/**
 * True only when the vault derived from (seller, buyer, enginePubkey) hashes to
 * the recorded escrow address. This is the guard against a *substituted* engine
 * key: a seller-supplied `enginePubkey` (or a tampered `/capabilities` response)
 * that does not reproduce the on-chain lock address must never be signed over.
 * Tries mainnet then testnet, since the app can be pointed at either.
 */
export function vaultMatchesAddress(vault: Escrow, escrowAddress: string): boolean {
  try {
    return vault.address(paramsForAddress(escrowAddress)).toBase58() === escrowAddress;
  } catch {
    return false;
  }
}
