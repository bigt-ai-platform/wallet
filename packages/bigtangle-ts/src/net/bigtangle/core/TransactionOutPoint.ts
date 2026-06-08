/*******************************************************************************
 *  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/
/*
 * Copyright 2011 Google Inc.
 * Copyright 2015 Andreas Schildbach
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
import { Sha256Hash } from './Sha256Hash';
import { Utils } from './Utils';
import { NetworkParameters } from '../params/NetworkParameters';
import { ECKey } from './ECKey';
import { KeyBag } from '../wallet/KeyBag';
import { Transaction } from './Transaction';
import { TransactionOutput } from './TransactionOutput';
import { RedeemData } from '../wallet/RedeemData';
import { FreeStandingTransactionOutput } from '../wallet/FreeStandingTransactionOutput';

/**
 * <p>
 * This message is a reference or pointer to an output of a different
 * transaction.
 * </p>
 *
 * <p>
 * Instances of this class are not safe for use by multiple threads.
 * </p>
 */
export class TransactionOutPoint extends ChildMessage {

    static readonly MESSAGE_LENGTH: number = 32 + 32 + 4;

    /** Hash of the block to which we refer. */
    private blockHash: Sha256Hash;
    /** Hash of the transaction to which we refer. */
    private txHash: Sha256Hash;
    /** Which output of that transaction we are talking about. */
    private index: number = 0;

    // This is not part of bitcoin serialization. It points to the connected
    // transaction.
    fromTx: Transaction | null = null;

    // The connected output.
    public connectedOutput: TransactionOutput | null = null;

    public constructor(params: NetworkParameters) {
        super(params);
        this.blockHash = Sha256Hash.ZERO_HASH;
        this.txHash = Sha256Hash.ZERO_HASH;
        this.length = TransactionOutPoint.MESSAGE_LENGTH;
    }

    public static fromTx4(params: NetworkParameters, index: number, blockHash: Sha256Hash | null,
        fromTx: Transaction | null): TransactionOutPoint {
        const a = TransactionOutPoint.fromTransactionOutPoint4(params, index, Sha256Hash.ZERO_HASH, Sha256Hash.ZERO_HASH);

        if (fromTx !== null && blockHash !== null) {
            a.blockHash = blockHash;
            a.txHash = fromTx.getHash();
            a.fromTx = fromTx;
        }
        a.length = TransactionOutPoint.MESSAGE_LENGTH;
        return a;
    }

    public static fromTransactionOutPoint4(params: NetworkParameters, index: number,
        blockHash: Sha256Hash, transactionHash: Sha256Hash): TransactionOutPoint {
        const a = new TransactionOutPoint(params);
        a.index = index;
        a.blockHash = blockHash;
        a.txHash = transactionHash;
        a.length = TransactionOutPoint.MESSAGE_LENGTH;
        return a;
    }

    public static fromOutput3(params: NetworkParameters, blockHash: Sha256Hash | null,
        connectedOutput: TransactionOutput): TransactionOutPoint {
        const a = TransactionOutPoint.fromTransactionOutPoint4(
            params, 
            connectedOutput.getIndex(), 
            blockHash || Sha256Hash.ZERO_HASH,
            (connectedOutput as FreeStandingTransactionOutput).getParentTransactionHash()
        );
        a.connectedOutput = connectedOutput;
        return a;
    }

    /**
     * Deserializes the message. This is usually part of a transaction message.
     *
     * @param params     NetworkParameters object.
     * @param offset     The location of the first payload byte within the array.
     * @param serializer the serializer to use for this message.
     * @throws ProtocolException
     */
    public static fromTransactionOutPoint5(params: NetworkParameters, payload: Uint8Array, offset: number,
        parent: any, serializer: any): TransactionOutPoint {
        const a = new TransactionOutPoint(params);
        a.setValues5(params, payload, offset, serializer, TransactionOutPoint.MESSAGE_LENGTH);
        a.setParent(parent);
        // Ensure cursor is set to the end position after parsing
       //  a.cursor = offset + TransactionOutPoint.MESSAGE_LENGTH;
        return a;
    }

    protected parse(): void {
        // Set the length first to avoid the "Length field has not been set" error
        this.length = TransactionOutPoint.MESSAGE_LENGTH;
        
        // Check if we have a payload to parse
        if (!this.payload) {
            throw new Error("No payload to parse");
        }
        
        // Check if we have enough bytes to read the blockHash (32 bytes)
        if (this.cursor + 32 > this.payload.length) {
            throw new Error(`Not enough bytes to read blockHash: offset=${this.cursor}, buffer length=${this.payload.length}`);
        }
        this.blockHash = this.readHash();
        
        // Check if we have enough bytes to read the txHash (32 bytes)
        if (this.cursor + 32 > this.payload.length) {
            throw new Error(`Not enough bytes to read txHash: offset=${this.cursor}, buffer length=${this.payload.length}`);
        }
        this.txHash = this.readHash();
        
        // Check if we have enough bytes to read the index (4 bytes)
        if (this.cursor + 4 > this.payload.length) {
            throw new Error(`Not enough bytes to read index: offset=${this.cursor}, buffer length=${this.payload.length}`);
        }
        this.index = this.readUint32();
    }

    public bitcoinSerializeToStream(stream: any): void {
        stream.write(this.blockHash.getReversedBytes());
        stream.write(this.txHash.getReversedBytes());
        Utils.uint32ToByteStreamLE(this.index, stream);
        // Utils.uint32ToByteStreamLE(this.connectedOutput != null ? 1 : 0,
        // stream);
        // if (this.connectedOutput != null) {
        // this.connectedOutput.bitcoinSerializeToStream(stream);
        // }
    }

    /**
     * An outpoint is a part of a transaction input that points to the output of
     * another transaction. If we have both sides in memory, and they have been
     * linked together, this returns a pointer to the connected output, or null if
     * there is no such connection.
     */
    public getConnectedOutput(): TransactionOutput | null {
        if (this.fromTx !== null) {
            return this.fromTx.getOutputs()[this.index];
        } else if (this.connectedOutput !== null) {
            return this.connectedOutput;
        }
        return null;
    }

    /**
     * Returns the pubkey script from the connected output.
     *
     * @throws java.lang.NullPointerException if there is no connected output.
     */
    public getConnectedPubKeyScript(): Uint8Array {
        const result = this.getConnectedOutput()!.getScriptBytes();
        if (result.length <= 0) {
            throw new Error("Connected output has empty script");
        }
        return result;
    }

    /**
     * Returns the ECKey identified in the connected output, for either
     * pay-to-address scripts or pay-to-key scripts. For P2SH scripts you can use
     * {@link #getConnectedRedeemData(net.bigtangle.wallet.KeyBag)} and then get the
     * key from RedeemData. If the script form cannot be understood, throws
     * ScriptException.
     *
     * @return an ECKey or null if the connected key cannot be found in the wallet.
     */
    public async getConnectedKey(keyBag: KeyBag): Promise<ECKey | null> {
        const connectedOutput = this.getConnectedOutput();
        if (connectedOutput === null) {
            throw new Error("Input is not connected so cannot retrieve key");
        }
        const connectedScript = connectedOutput.getScriptPubKey();
        if (connectedScript.isSentToAddress()) {
            const addressBytes = connectedScript.getPubKeyHash();
            // This method might return a Promise, so we need to await it
            const key = await keyBag.findKeyFromPubHash(addressBytes);
            return key as ECKey | null;
        } else if (connectedScript.isSentToRawPubKey()) {
            const pubkeyBytes = connectedScript.getPubKey();
            // This method might return a Promise, so we need to await it
            const key = await keyBag.findKeyFromPubKey(pubkeyBytes);
            return key as ECKey | null;
        } else if (connectedScript.isSentToMultiSig()) {
            const key = await this.getConnectedKeyFromMultiSig(keyBag, connectedScript.getPubKeys());
            return key;
        } else {
            throw new Error("Could not understand form of connected output script: " + connectedScript);
        }
    }

    private async getConnectedKeyFromMultiSig(keyBag: KeyBag, ecs: ECKey[]): Promise<ECKey | null> {
        for (const ec of ecs) {
            // This method might return a Promise, so we need to await it
            const a = await keyBag.findKeyFromPubKey(ec.getPubKey());
            if (a !== null)
                return a as ECKey | null;
        }
        throw new Error("Could not understand form of connected output script: " + ecs);
    }

    /**
     * Returns the RedeemData identified in the connected output, for either
     * pay-to-address scripts, pay-to-key or P2SH scripts. If the script forms
     * cannot be understood, throws ScriptException.
     *
     * @return a RedeemData or null if the connected data cannot be found in the
     *         wallet.
     */
    public async getConnectedRedeemData(keyBag: KeyBag): Promise<RedeemData | null> {
        const connectedOutput = this.getConnectedOutput();
        if (connectedOutput === null) {
            throw new Error("Input is not connected so cannot retrieve key");
        }
        const connectedScript = connectedOutput.getScriptPubKey();
     
        if (connectedScript.isSentToAddress()) {
            const addressBytes = connectedScript.getPubKeyHash();
            // This method might return a Promise, so we need to await it
            const key = await keyBag.findKeyFromPubHash(addressBytes);
            return RedeemData.of(key, connectedScript);
        } else if (connectedScript.isSentToRawPubKey()) {
            const pubkeyBytes = connectedScript.getPubKey();
            // This method might return a Promise, so we need to await it
            const key = await keyBag.findKeyFromPubKey(pubkeyBytes);
            return RedeemData.of(key, connectedScript);
        } else if (connectedScript.isPayToScriptHash()) {
            const scriptHash = connectedScript.getPubKeyHash();
            // This method might return a Promise, so we need to await it
            const redeemData = await keyBag.findRedeemDataFromScriptHash(scriptHash);
            return redeemData as RedeemData | null;
        } else if (connectedScript.isSentToMultiSig()) {
            const key = await this.getConnectedKey(keyBag);
            // For multisig, we need to pass an array of keys, not a single key
            // This is a simplification - in reality, we'd need to get all keys
            return key ? RedeemData.of([key], connectedScript) : null;
        } else {
            throw new Error("Could not understand form of connected output script: " + connectedScript);
        }
    }

    public toString(): string {
        return this.blockHash + " : " + this.txHash + " : " + this.index;
    }

    /**
     * Returns the hash of the outpoint.
     */
    public getHash(): Sha256Hash {
        return Sha256Hash.of(Utils.addAll(this.blockHash.getBytes(), this.txHash.getBytes()));
    }

    public getTxHash(): Sha256Hash {
        return this.txHash;
    }

    public getBlockHash(): Sha256Hash {
        return this.blockHash;
    }

    public getIndex(): number {
        return this.index;
    }
    
    public setBlockHash(blockHash: Sha256Hash): void {
        this.blockHash = blockHash;
    }
    
    public setTxHash(txHash: Sha256Hash): void {
        this.txHash = txHash;
    }
    
    public setIndex(index: number): void {
        this.index = index;
    }
    
    public setConnectedOutput(connectedOutput: TransactionOutput | null): void {
        this.connectedOutput = connectedOutput;
    }

    /**
     * Coinbase transactions have special outPoints with hashes of zero. If this is
     * such an outPoint, returns true.
     */
    public isCoinBase(): boolean {
        return this.getBlockHash().equals(Sha256Hash.ZERO_HASH) && this.getTxHash().equals(Sha256Hash.ZERO_HASH)
            && ( this.getIndex()==0  || (this.getIndex() >>> 0) === 0xFFFFFFFF);
    }

    public equals(o: any): boolean {
        if (this === o)
            return true;
        if (o === null || !(o instanceof TransactionOutPoint))
            return false;
        const other = o as TransactionOutPoint;
        return this.getIndex() === other.getIndex() && 
               this.getBlockHash().equals(other.getBlockHash()) && 
               this.getTxHash().equals(other.getTxHash());
    }

    public hashCode(): number {
        return this.getIndex() * 31 + this.getHash().hashCode();
    }

    /**
     * Creates a copy of this TransactionOutPoint.
     */
    public copy(): TransactionOutPoint {
        const copy = new TransactionOutPoint(this.params!);
        copy.blockHash = this.blockHash;
        copy.txHash = this.txHash;
        copy.index = this.index;
        copy.fromTx = this.fromTx;
        copy.connectedOutput = this.connectedOutput;
        copy.length = this.length;
        return copy;
    }
}
