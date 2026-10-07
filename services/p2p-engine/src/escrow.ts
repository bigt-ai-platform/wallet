/**
 * 2-of-3 P2SH escrow (docs/p2p.md): seller / buyer / engine, threshold two.
 *
 * The redeem script is `OP_2 <keys...> OP_3 OP_CHECKMULTISIG` with keys placed
 * in lexicographic order by `ScriptBuilder.createRedeemScript`, so all three
 * parties derive the same script — and therefore the same escrow address — from
 * the same key set. Only the address/script derivation lives here; the engine
 * consumes `bigtangle-ts` for the actual spend assembly, which is the wallet's
 * on-chain half.
 */
import { Address, MainNetParams, ScriptBuilder, Utils } from "bigtangle-ts";
import type { ECKey, NetworkParameters, PQKey, Script } from "bigtangle-ts";

export type EscrowKey = ECKey | PQKey;

/** Deterministic 2-of-3 (or M-of-N) redeem script. */
export function escrowRedeemScript(threshold: number, keys: EscrowKey[]): Script {
  return ScriptBuilder.createRedeemScript(threshold, keys);
}

/** P2SH address for a redeem script (deterministic per swap). */
export function p2shAddress(redeemScript: Script, params: NetworkParameters = MainNetParams.get()): string {
  const hash = Utils.sha256hash160(redeemScript.getProgram());
  return Address.fromP2SHHash(params, hash).toBase58();
}

/** The P2SH scriptPubKey the seller funds. */
export function escrowOutputScript(threshold: number, keys: EscrowKey[]): Script {
  const hash = Utils.sha256hash160(escrowRedeemScript(threshold, keys).getProgram());
  return ScriptBuilder.createP2SHOutputScript(hash);
}

/** Convenience: derive the escrow address for a key set. */
export function escrowAddress(keys: EscrowKey[], threshold = 2, params?: NetworkParameters): string {
  return p2shAddress(escrowRedeemScript(threshold, keys), params);
}

/** h160 of a base58 address — the `getBalances` UTXO query key. */
export function addressHash160(address: string, params: NetworkParameters = MainNetParams.get()): Uint8Array {
  return Address.fromBase58(params, address).getHash160();
}
