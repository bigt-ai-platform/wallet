import { Coin } from '../core/Coin';
import { Address } from '../core/Address';
import { Transaction } from '../core/Transaction';
import { TransactionOutput } from '../core/TransactionOutput';
import { Sha256Hash } from '../core/Sha256Hash';
import { SigHash } from '../core/SigHash';
import { NetworkParameters } from '../params/NetworkParameters';
import { Script } from '../script/Script';
import { ScriptBuilder } from '../script/ScriptBuilder';
import { PQKey } from '../crypto/pq/PQKey';
import { PQConstants } from '../crypto/pq/PQConstants';
import { Utils } from '../utils/Utils';

/**
 * The three participants of a 2-of-3 escrow vault.
 *
 * The seller funds the vault, then the engine and buyer co-sign a **release**
 * that spends it (typically to the buyer's `receiveAddress`), while the engine
 * and seller co-sign a **refund** that returns it to the seller. Neither party
 * can move the funds alone, which is what makes the vault escrow rather than a
 * plain two-party payment.
 */
export interface EscrowRoles {
    seller: PQKey;
    buyer: PQKey;
    engine: PQKey;
}

export interface EscrowSpendOptions {
    params: NetworkParameters;
    /** Block hash the escrow UTXO was mined in; required when building the input. */
    blockHash: Sha256Hash;
    /** The escrow output to spend, either free-standing or a child of a funding transaction. */
    utxo: TransactionOutput;
    to: Address;
    /** Defaults to the full UTXO value; anything less leaves the remainder as fee. */
    amount?: Coin;
    memo?: string | null;
}

/**
 * A `m`-of-`n` pay-to-script-hash escrow vault over post-quantum keys.
 *
 * The redeem script is a `CHECKMULTISIG` program whose pubkeys are stored in
 * lexicographic order (see {@link ScriptBuilder.createRedeemScript}), so the
 * address depends only on the key *set*, never on the order the keys were
 * handed in. Spends push `OP_0 <sig...> <redeemProgram>` with the signatures
 * ordered by their position in that sorted list — the order
 * `OP_CHECKMULTISIG` is strict about.
 *
 * Signatures are `SignatureBundle.serialize()` blobs with no sighash byte
 * appended: for PQ keys the sighash is fixed to `SigHash.ALL` / no
 * anyone-can-pay inside the verifier itself.
 */
export class Escrow {
    public readonly threshold: number;
    /** Pubkeys in redeem-script order, which is lexicographic, not delivery order. */
    public readonly pubkeys: PQKey[];
    public readonly redeemScript: Script;
    public readonly outputScript: Script;
    private readonly roles: EscrowRoles | null;

    private constructor(threshold: number, pubkeys: PQKey[], redeemScript: Script,
        outputScript: Script, roles: EscrowRoles | null) {
        this.threshold = threshold;
        this.pubkeys = pubkeys;
        this.redeemScript = redeemScript;
        this.outputScript = outputScript;
        this.roles = roles;
    }

    /**
     * Builds an escrow from an explicit threshold and key set. Throws if the
     * threshold or key count is out of range (`0 < m <= n <= 16`).
     */
    static of(threshold: number, pubkeys: PQKey[], roles?: EscrowRoles): Escrow {
        const redeemScript = ScriptBuilder.createRedeemScript(threshold, pubkeys);
        const outputScript = ScriptBuilder.createP2SHOutputScriptFromScript(redeemScript);
        return new Escrow(threshold, redeemScript.getPubKeys(), redeemScript, outputScript, roles ?? null);
    }

    /** The canonical 2-of-3 vault: seller, buyer and engine. */
    static twoOfThree(roles: EscrowRoles): Escrow {
        return Escrow.of(2, [roles.seller, roles.buyer, roles.engine], roles);
    }

    /** The P2SH address this vault pays into. */
    address(params: NetworkParameters): Address {
        return Address.fromP2SHHash(params, Utils.sha256hash160(this.redeemScript.getProgram()));
    }

    /** Position of a key in the redeem script, or -1 when it is not a participant. */
    indexOf(pubkey: PQKey | Uint8Array): number {
        const target = pubkey instanceof Uint8Array ? pubkey : pubkey.getPubKey();
        return this.pubkeys.findIndex(k => Utils.arraysEqual(k.getPubKey(), target));
    }

    /** Engine + buyer — spends the escrow to the buyer (e.g. `receiveAddress`). */
    releaseSigners(): PQKey[] {
        const r = this.requireRoles('release');
        return [r.engine, r.buyer];
    }

    /** Engine + seller — returns the escrowed funds to the seller. */
    refundSigners(): PQKey[] {
        const r = this.requireRoles('refund');
        return [r.engine, r.seller];
    }

    /**
     * Builds the unsigned spend transaction: version 2 (PQ), one input spending
     * the escrow UTXO, one output paying `to`.
     */
    createSpend(opts: EscrowSpendOptions): Transaction {
        const tx = new Transaction(opts.params);
        tx.version = PQConstants.TX_PQ_VERSION;
        tx.setMemo(opts.memo ?? null);
        tx.addInput2(opts.blockHash, opts.utxo);
        tx.addOutputAddress(opts.amount ?? opts.utxo.getValue(), opts.to);
        return tx;
    }

    /**
     * Signs `inputIndex` with the given signers, collecting signatures in
     * redeem-script order until `threshold` are reached.
     *
     * @returns the number of signatures written into the scriptSig.
     */
    signInput(tx: Transaction, inputIndex: number, signers: PQKey[]): number {
        const byIndex = new Map<number, PQKey>();
        for (const signer of signers) {
            const i = this.indexOf(signer);
            if (i < 0) throw new Error('signer is not a participant of this escrow');
            if (!signer.hasPrivateKey()) throw new Error(`escrow participant at index ${i} is watch-only`);
            if (byIndex.has(i)) throw new Error(`duplicate signer at escrow index ${i}`);
            byIndex.set(i, signer);
        }
        if (byIndex.size < this.threshold) {
            throw new Error(`need ${this.threshold} signatures, got ${byIndex.size}`);
        }
        const sighash = tx.hashForSignature(inputIndex, this.redeemScript.getProgram(),
            SigHash.ALL, false);
        const ordered = [...byIndex.keys()].sort((a, b) => a - b).slice(0, this.threshold);
        const sigs = ordered.map(i => byIndex.get(i)!.sign(sighash).serialize());
        tx.getInput(inputIndex).setScriptSig(
            ScriptBuilder.createMultiSigInputScript(sigs, this.redeemScript.getProgram()));
        return sigs.length;
    }

    /** {@link createSpend} plus a release signature set (engine + buyer). */
    buildRelease(opts: EscrowSpendOptions): Transaction {
        const tx = this.createSpend(opts);
        this.signInput(tx, 0, this.releaseSigners());
        return tx;
    }

    /** {@link createSpend} plus a refund signature set (engine + seller). */
    buildRefund(opts: EscrowSpendOptions): Transaction {
        const tx = this.createSpend(opts);
        this.signInput(tx, 0, this.refundSigners());
        return tx;
    }

    private requireRoles(action: string): EscrowRoles {
        if (this.roles === null) {
            throw new Error(`escrow has no ${action} roles; build it with Escrow.twoOfThree()`);
        }
        return this.roles;
    }
}

/**
 * The amount an escrow spend may pay out — the shared skeleton rule both the
 * wallet and the settlement engine must use so their signatures cover the
 * same transaction bytes.
 *
 * The mempool accepts a transaction with BIG inputs only when
 * `input >= output + FEE_DEFAULT` (MempoolService), while a non-BIG escrow
 * (e.g. a stablecoin) pays no fee at all. So a BIG escrow loses exactly the
 * default fee, and anything else pays out in full.
 *
 * @throws when a BIG escrow holds less than the fee itself.
 */
export function escrowSpendAmount(value: Coin): Coin {
    if (!value.isBIG()) return value;
    const out = value.subtract(Coin.FEE_DEFAULT);
    if (!out.isPositive()) {
        throw new Error(`escrow value ${value.toString()} is below the default fee ${Coin.FEE_DEFAULT.toString()}`);
    }
    return out;
}
