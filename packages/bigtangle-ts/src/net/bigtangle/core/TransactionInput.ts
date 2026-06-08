/*******************************************************************************
 *  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/
/*
 * Copyright 2011 Google Inc.
 * Copyright 2014 Andreas Schildbach
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { ChildMessage } from './ChildMessage';
import { TransactionOutPoint } from './TransactionOutPoint';
import type { Script } from '../script/Script';
import { ScriptHelper } from '../script/ScriptHelper';
import { NetworkParameters } from '../params/NetworkParameters';
import { Address } from './Address';
import { ScriptException } from '../exception/ScriptException';
import { VerificationException } from '../exception/VerificationException';
import { KeyBag } from '../wallet/KeyBag';
import { RedeemData } from '../wallet/RedeemData';
import { Coin } from './Coin';
import { Sha256Hash } from './Sha256Hash';
import { Utils } from './Utils';
import { VarInt } from './VarInt';
import { Transaction } from './Transaction';
import { TransactionOutput } from './TransactionOutput';
import { JsonProperty } from "jackson-js";

/**
 * <p>
 * A transfer of coins from one address to another creates a transaction in
 * which the outputs can be claimed by the recipient in the input of another
 * transaction. You can imagine a transaction as being a module which is wired
 * up to others, the inputs of one have to be wired to the outputs of another.
 * The exceptions are coinbase transactions, which create new coins.
 * </p>
 *
 * <p>
 * Instances of this class are not safe for use by multiple threads.
 * </p>
 */
export class TransactionInput extends ChildMessage {
    /** Magic sequence number that indicates there is no sequence number. */
    public static readonly NO_SEQUENCE: number = 0xFFFFFFFF;
    private static readonly EMPTY_ARRAY: Uint8Array = new Uint8Array(0);
    // Magic outpoint index that indicates the input is in fact unconnected.
    private static readonly UNCONNECTED: number = 0xFFFFFFFF;

    // Allows for altering transactions after they were broadcast. Values below
    // NO_SEQUENCE-1 mean it can be altered.
    @JsonProperty() private sequence: number = 0;
    // Data needed to connect to the output of the transaction we're gathering coins
    // from.
    @JsonProperty() private outpoint: TransactionOutPoint;
    // The "script bytes" might not actually be a script. In coinbase transactions
    // where new coins are minted there
    // is no input transaction, so instead the scriptBytes contains some extra stuff
    // (like a rollover nonce) that we
    // don't care about much. The bytes are turned into a Script object (cached
    // below) on demand via a getter.
    @JsonProperty() private scriptBytes: Uint8Array;
    // The Script object obtained from parsing scriptBytes. Only filled in on demand
    // and if the transaction is not
    // coinbase.
    @JsonProperty() private scriptSig: Script | null = null;
    @JsonProperty() protected value: Coin | null = null;
    
    public static fromCoinBase(params: NetworkParameters, parentTransaction: Transaction, output: TransactionOutput): TransactionInput {
        const a = new TransactionInput(params);
        a.scriptBytes = TransactionInput.EMPTY_ARRAY;
        a.sequence = TransactionInput.NO_SEQUENCE;
        a.setParent(parentTransaction);
        a.value = output.getValue();
        a.length = 41;
        return a;
    }

    public static fromScriptBytes(params: NetworkParameters, parentTransaction: Transaction, scriptBytes: Uint8Array): TransactionInput {
        const a = new TransactionInput(params);
        a.scriptBytes = scriptBytes;
        a.sequence = TransactionInput.NO_SEQUENCE;
        a.setParent(parentTransaction);
        a.value = null;
        // Estimate length: outpoint (36) + script length + sequence (4) + varint for script length
        a.length = 36 + VarInt.sizeOf(scriptBytes.length) + scriptBytes.length + 4;
        return a;
    }

    /**
     * Deserializes an input message. This is usually part of a transaction message.
     *
     * @param params     NetworkParameters object.
     * @param payload    Bitcoin protocol formatted byte array containing message
     *                   content.
     * @param offset     The location of the first payload byte within the array.
     * @param serializer the serializer to use for this message.
     * @throws ProtocolException
     */
    public static fromTransactionInput5(params: NetworkParameters, parentTransaction: Transaction,
        payload: Uint8Array, offset: number, serializer: any): TransactionInput {
        const a = new TransactionInput(params);
        a.setValues5(params, payload, offset, serializer, TransactionInput.UNKNOWN_LENGTH);
        a.setParent(parentTransaction);
        a.value = null;
        return a;
    }

    /**
     * Creates an UNSIGNED input that links to the given output
     */
    public static fromTransactionInput4(params: NetworkParameters, parentTransaction: Transaction,
        output: TransactionOutput, blockHash: Sha256Hash): TransactionInput {
        const a = new TransactionInput(params);
        const outputIndex = output.getIndex();
        if (output.getParentTransaction() != null) {
            a.outpoint = TransactionOutPoint.fromTx4(params, outputIndex, blockHash, output.getParentTransaction());
        } else {
            a.outpoint = TransactionOutPoint.fromOutput3(params, blockHash, output);
        }
         a.outpoint .toString();
        a.scriptBytes = TransactionInput.EMPTY_ARRAY;
        a.sequence = TransactionInput.NO_SEQUENCE;
        a.setParent(parentTransaction);
        a.value = output.getValue();
        a.length = 41;
        return a;
    }


    public constructor(params: NetworkParameters) {
        super(params);
        this.outpoint = new TransactionOutPoint(params);
        this.scriptBytes = TransactionInput.EMPTY_ARRAY;
    }

    protected parse(): void {
        if (!this.params) {
            throw new Error("Network parameters are required");
        }
        if (!this.payload) {
            throw new Error("Payload is required");
        }
        this.outpoint = TransactionOutPoint.fromTransactionOutPoint5(this.params, this.payload, this.cursor, this, this.serializer!);
        this.cursor += TransactionOutPoint.MESSAGE_LENGTH;
        
        const scriptLen = this.readVarInt();
        	this.length = this.cursor - this.offset + scriptLen + 4;
        this.scriptBytes = this.readBytes(scriptLen);
        this.sequence = this.readUint32();
	if (this.readUint32() == 1) {
			this.outpoint.connectedOutput = TransactionOutput.fromTransactionOutput(this.params, this.parent as Transaction,
					this.payload, this.cursor, this.serializer);
			this.cursor += this.outpoint.connectedOutput.getMessageSize();
		}
    }

    /**
     * Coinbase transactions have special inputs with hashes of zero. If this is
     * such an input, returns true.
     */
    public isCoinBase(): boolean {
        return this.outpoint.isCoinBase(); // -1 but all is serialized to the wire as unsigned int.
    }

    /**
     * Returns the script that is fed to the referenced output (scriptPubKey) script
     * in order to satisfy it: usually contains signatures and maybe keys, but can
     * contain arbitrary data if the output script accepts it.
     */
    public getScriptSig(): Script {
        // Transactions that generate new coins don't actually have a script. Instead
        // this
        // parameter is overloaded to be something totally different.
        if (this.scriptSig === null) {
            this.scriptSig = ScriptHelper.fromBytes(this.scriptBytes);
        }
        return this.scriptSig;
    }

    protected bitcoinSerializeToStream(stream: any): void {
        this.outpoint.bitcoinSerialize(stream);
        stream.write(new VarInt(this.scriptBytes.length).encode());
        stream.write(this.scriptBytes);
        Utils.uint32ToByteStreamLE(this.sequence, stream);
      Utils.uint32ToByteStreamLE(this.outpoint.connectedOutput != null ? 1 : 0, stream);
		if (this.outpoint.connectedOutput != null) {
			this.outpoint.connectedOutput.bitcoinSerializeToStream(stream);
		}
    }



    /**
     * Sequence numbers allow participants in a multi-party transaction signing
     * protocol to create new versions of the transaction independently of each
     * other. Newer versions of a transaction can replace an existing version that's
     * in nodes memory pools if the existing version is time locked. See the
     * Contracts page on the Bitcoin wiki for examples of how you can use this
     * feature to build contract protocols.
     */
    public getSequenceNumber(): number {
        return this.sequence;
    }

    /**
     * Sequence numbers allow participants in a multi-party transaction signing
     * protocol to create new versions of the transaction independently of each
     * other. Newer versions of a transaction can replace an existing version that's
     * in nodes memory pools if the existing version is time locked. See the
     * Contracts page on the Bitcoin wiki for examples of how you can use this
     * feature to build contract protocols.
     */
    public setSequenceNumber(sequence: number): void {
        this.unCache();
        this.sequence = sequence;
    }

    /**
     * @return The previous output transaction reference, as an OutPoint structure.
     *         This contains the data needed to connect to the output of the
     *         transaction we're gathering coins from.
     */
    public getOutpoint(): TransactionOutPoint {
        return this.outpoint;
    }

    /**
     * The "script bytes" might not actually be a script. In coinbase transactions
     * where new coins are minted there is no input transaction, so instead the
     * scriptBytes contains some extra stuff (like a rollover nonce) that we don't
     * care about much. The bytes are turned into a Script object (cached below) on
     * demand via a getter.
     *
     * @return the scriptBytes
     */
    public getScriptBytes(): Uint8Array {
        return this.scriptBytes;
    }

    /** Clear input scripts, e.g. in preparation for signing. */
    public clearScriptBytes(): void {
        this.setScriptBytes(TransactionInput.EMPTY_ARRAY);
    }

    /**
     * @param scriptBytes the scriptBytes to set
     */
    public setScriptBytes(scriptBytes: Uint8Array): void {
        this.unCache();
        this.scriptSig = null;
        const oldLength = this.length;
        this.scriptBytes = scriptBytes;
        // 40 = previous_outpoint (极端的36) + sequence (4)
        const newLength = 40 + (scriptBytes === null ? 1 : VarInt.sizeOf(scriptBytes.length) + scriptBytes.length);
        this.adjustLength(newLength - oldLength);
    }
    
    public setOutpoint(outpoint: TransactionOutPoint): void {
        this.outpoint = outpoint;
    }

    /**
     * Sets the scriptSig (convenience wrapper used by signers).
     */
    public setScriptSig(script: Script): void {
        this.setScriptBytes(script.getProgram());
    }

    /**
     * Factory alias used by older codepaths. Mirrors Java overloads.
     */
    public static fromOutpoint4(params: NetworkParameters, parentTransaction: Transaction, payload: Uint8Array, outpoint: TransactionOutPoint, value?: Coin | null): TransactionInput {
        const inp = new TransactionInput(params);
        inp.setParent(parentTransaction);
        inp.outpoint = outpoint;
        inp.scriptBytes = TransactionInput.EMPTY_ARRAY;
        inp.sequence = TransactionInput.NO_SEQUENCE;
        inp.length = 36 + 1 + 0 + 4; // rough estimate
        if (value) inp.value = value;
        return inp;
    }

    public static fromOutpoint5(params: NetworkParameters, parentTransaction: Transaction, payload: Uint8Array, outpoint: TransactionOutPoint, value?: Coin | null): TransactionInput {
        return TransactionInput.fromOutpoint4(params, parentTransaction, payload, outpoint, value);
    }

    /**
     * Convenience method that returns the from address of this input by parsing the
     * scriptSig. The concept of a "from address" is not well defined in Bitcoin and
     * you should not assume that senders of a transaction can actually receive
     * coins on the same address they used to sign (e.g. this is not true for shared
     * wallets).
     *
     * @return The address that originally owned the output this input is spending.
     * @throws ScriptException if the input is a coinbase input or if the scriptSig is invalid
     */
    public getFromAddress(): Address {
        if (this.isCoinBase()) {
            throw new ScriptException(
                "This is a coinbase transaction which generates new coins. It does not have a from address.");
        }
        if (this.params === null) {
            throw new ScriptException("Network parameters are null");
        }
        const scriptSig = this.getScriptSig();
        return scriptSig.getFromAddress(this.params);
    }

    /**
     * @return The Transaction that owns this input.
     */
    public getParentTransaction(): Transaction | null {
        return this.parent as Transaction;
    }

    /**
     * @return Value of the output connected to this input, if known. Null if
     *         unknown.
     */
    public getValue(): Coin | null {
        return this.value;
    }

    /**
     * Alias for getOutpoint().getConnectedRedeemData(keyBag)
     *
     * @see TransactionOutPoint#getConnectedRedeemData(net.bigtangle.wallet.KeyBag)
     */
    public async getConnectedRedeemData(keyBag: KeyBag): Promise<RedeemData | null> {
        return await this.getOutpoint().getConnectedRedeemData(keyBag);
    }

    public static ConnectMode = {
        DISCONNECT_ON_CONFLICT: "DISCONNECT_ON_CONFLICT",
        ABORT_ON_CONFLICT: "ABORT_ON_CONFLICT"
    } as const;

    /**
     * @return true if this transaction's sequence number is set (ie it may be a
     *         part of a time-locked transaction)
     */
    public hasSequence(): boolean {
        return this.sequence !== TransactionInput.NO_SEQUENCE;
    }

    /**
     * Returns whether this input will cause a transaction to opt into the
     * <a href="https://github.com/bitcoin/bips/blob/master/bip-0125.mediawiki">full
     * replace-by-fee </a> semantics.
     */
    public isOptInFullRBF(): boolean {
        return this.sequence < TransactionInput.NO_SEQUENCE - 1;
    }

    /**
     * For a connected transaction, runs the script against the connected pubkey and
     * verifies they are correct.
     *
     * @throws ScriptException       if the script did not verify.
     * @throws VerificationException If the outpoint doesn't match the given output.
     */
    public verify(): void {
        const fromTx = this.getOutpoint().fromTx;
        const spendingIndex = this.getOutpoint().getIndex();
        if (fromTx === null) {
            throw new VerificationException("Not connected");
        }
        // Assuming getOutputs() returns an array and we need to access the element at spendingIndex
        const outputs = fromTx.getOutputs();
        if (spendingIndex >= outputs.length) {
            throw new VerificationException("Invalid spending index");
        }
        const output = outputs[spendingIndex];
        this.verifyOutput(output);
    }

    /**
     * Verifies that this input can spend the given output. Note that this input
     * must be a part of a transaction. Also note that the consistency of the
     * outpoint will be checked, even if this input has not been connected.
     *
     * @param output the output that this input is supposed to spend.
     * @throws ScriptException       If the script doesn't verify.
     * @throws VerificationException If the outpoint doesn't match the given output.
     */
    public verifyOutput(output: TransactionOutput): void {
        const parentTx = output.getParentTransaction();
        if (parentTx !== null) {
            const parentBlock = parentTx.getParentBlock();
            if (parentBlock !== null) {
                if (!this.getOutpoint().getHash().equals(
                    Sha256Hash.of(Utils.addAll(parentBlock.getHash().getBytes(),
                        parentTx.getHash().getBytes()))))
                    throw new VerificationException("This input does not refer to the tx containing the output.");
                if (this.getOutpoint().getIndex() !== output.getIndex())
                    throw new VerificationException("This input refers to a different output on the given tx.");
            }
        }
        const pubKey = output.getScriptPubKey();
        const myIndex = this.getParentTransaction()!.getInputs().indexOf(this);
        const r = this.getScriptSig();
        r.correctlySpends(this.getParentTransaction()!, myIndex, pubKey, ScriptHelper.getAllVerifyFlags());
    }

    /**
     * Returns the connected output, assuming the input was connected with
     * {@link TransactionInput#connect(TransactionOutput)} or variants at some
     * point. If it wasn't connected, then this method returns null.
     */
    public getConnectedOutput(): TransactionOutput | null {
        return this.getOutpoint().getConnectedOutput();
    }

    /**
     * Returns the connected transaction, assuming the input was connected with
     * {@link TransactionInput#connect(TransactionOutput)} or variants at some
     * point. If it wasn't connected, then this method returns null.
     */
    public getConnectedTransaction(): Transaction | null {
        return this.getOutpoint().fromTx;
    }

    public equals(o: any): boolean {
        if (this === o)
            return true;
        if (o === null || !(o instanceof TransactionInput))
            return false;
        const other = o as TransactionInput;
        return this.sequence === other.sequence && this.parent === other.parent && this.outpoint.equals(other.outpoint)
            && this.arraysEqual(this.scriptBytes, other.scriptBytes);
    }

    private arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    public hashCode(): number {
        let result = this.sequence;
        // Since Message doesn't have a hashCode method, we'll use a simple approach
        // to generate a hash code for the parent object
        result = 31 * result + (this.parent ? this.stringHashCode(this.parent.toString()) : 0);
        result = 31 * result + this.outpoint.hashCode();
        for (let i = 0; i < this.scriptBytes.length; i++) {
            result = 31 * result + this.scriptBytes[i];
        }
        return result;
    }

    private stringHashCode(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash;
    }

    public toString(): string {
        let s = "TxIn";
        try {
            if (this.isCoinBase()) {
                s += ": COINBASE";
            } else {
                s += " for [" + this.outpoint + "]: " + this.getScriptSig();
                const flags = [];
                if (this.hasSequence()) flags.push("sequence: " + this.sequence.toString(16));
                if (this.isOptInFullRBF()) flags.push("opts into full RBF");
                if (flags.length > 0)
                    s += " (" + flags.join(", ") + ')';
            }
            return s;
        } catch (e) {
            throw new Error("Script exception: " + e);
        }
    }
}
