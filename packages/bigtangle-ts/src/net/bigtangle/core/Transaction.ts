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

import { ChildMessage } from "./ChildMessage";
import { NetworkParameters } from "../params/NetworkParameters";
import { ProtocolException } from "../exception/ProtocolException";
import { Sha256Hash } from "./Sha256Hash";
import { TransactionInput } from "./TransactionInput";
import { TransactionOutput } from "./TransactionOutput";
import { TransactionOutPoint } from "./TransactionOutPoint";
import { Block } from "./Block";
import { Coin } from "./Coin";
import { CoinConstants } from "./CoinConstants";
import { Address } from "./Address";
import { ECKey } from "./ECKey";
import { ECDSASignature } from "./ECDSASignature";
import { Script } from "../script/Script";
import * as ScriptOpCodes from "../script/ScriptOpCodes";
import { TransactionBag } from "./TransactionBag";
import { VerificationException } from "../exception/VerificationException";
import { Purpose } from "./Purpose";
import { SigHash } from "./SigHash";
import { Utils } from "./Utils";
import { VarInt } from "./VarInt";
import { MessageSerializer } from "./MessageSerializer";
import { ScriptBuilder } from "../script/ScriptBuilder";
import { TransactionSignature } from "../crypto/TransactionSignature";
import { JsonProperty } from "jackson-js";

import { UnsafeByteArrayOutputStream } from "./UnsafeByteArrayOutputStream";

/**
 * <p>
 * A transaction represents the movement of coins from some addresses to some
 * other addresses.
 * </p>
 *
 * <p>
 * Transactions are the fundamental atoms and have many powerful features.
 * </p>
 *
 * <p>
 * Instances of this class are not safe for use by multiple threads.
 * </p>
 */
export class Transaction extends ChildMessage {
  /**
   * Threshold for lockTime: below this value it is interpreted as block number,
   * otherwise as timestamp.
   **/
  public static readonly LOCKTIME_THRESHOLD: number = 500000000; // Tue Nov 5
  // 00:53:20 1985 UTC
  /** Same but as a BigInteger for CHECKLOCKTIMEVERIFY */
  public static readonly LOCKTIME_THRESHOLD_BIG: bigint = BigInt(
    Transaction.LOCKTIME_THRESHOLD
  );

  // These are bitcoin serialized.
  @JsonProperty() public version: number = 1;
  @JsonProperty() private inputs: TransactionInput[] = [];
  @JsonProperty() private outputs: TransactionOutput[] = [];

  @JsonProperty() private lockTime: number = 0;

  // This is an in memory helper only.
  @JsonProperty() private hash: Sha256Hash | null = null;

  // Records a map of which blocks the transaction has appeared in
  @JsonProperty() private appearsInHashes: Map<Sha256Hash, number> | null = null;

  // Tracks optimal encoding message size (mirror of Java field)
  @JsonProperty() private optimalEncodingMessageSize: number = 0;

  @JsonProperty() private purpose: Purpose = Purpose.UNKNOWN;

  /**
   * This field can be used to record the memo of the payment request that
   * initiated the transaction. It's optional.
   */
  @JsonProperty() private memo: string | null = null;

  @JsonProperty() private data: Uint8Array | null = null;

  @JsonProperty() private dataSignature: Uint8Array | null = null;

  @JsonProperty() private dataClassName: string | null = null;

  @JsonProperty() private toAddressInSubtangle: Uint8Array | null = null;

  public getData(): Uint8Array | null {
    return this.data;
  }

  public setData(data: Uint8Array | null): void {
    this.data = data;
  }

  public getDataSignature(): Uint8Array | null {
    return this.dataSignature;
  }

  public setDataSignature(signature: Uint8Array | null): void {
    this.dataSignature = signature;
  }

  public getDataClassName(): string | null {
    return this.dataClassName;
  }

  public setDataClassName(className: string | null): void {
    this.dataClassName = className;
  }

  public getMemo(): string | null {
    return this.memo;
  }

  public setMemo(memo: string | null): void {
    this.memo = memo;
  }

  public getInputs(): TransactionInput[] {
    return this.inputs;
  }

  public getInput(index: number): TransactionInput {
    if (index < 0 || index >= this.inputs.length) {
      throw new Error("Input index out of bounds");
    }
    return this.inputs[index];
  }

  public getOutputs(): TransactionOutput[] {
    return this.outputs;
  }

  public verify(): void {
    // Check for duplicate outpoints
    const outpointSet = new Set<string>();
    for (const input of this.inputs) {
      const outpointKey = input.getOutpoint().toString();
      if (outpointSet.has(outpointKey)) {
        throw new VerificationException("Duplicated outpoint");
      }
      outpointSet.add(outpointKey);
    }

    // Check for coinbase input in non-coinbase transaction
    if (!this.isCoinBase()) {
      for (const input of this.inputs) {
        if (input.isCoinBase()) {
          throw new VerificationException("Unexpected coinbase input");
        }
      }
    } else {
      // For coinbase transactions, check script size
      if (this.inputs.length > 0) {
        const scriptBytes = this.inputs[0].getScriptBytes();
        if (scriptBytes.length < 2 || scriptBytes.length > 100) {
          throw new VerificationException("Coinbase script size out of range");
        }
      }
    }
  }

  public isTimeLocked(): boolean {
    return this.lockTime !== 0;
  }

  public isOptInFullRBF(): boolean {
    // Implementation would go here
    return false;
  }

  public getSigOpCount(): number {
    // Stub implementation
    return 0;
  }

  public getParentBlock(): Block | null {
    return this.parent as Block;
  }

  /**
   * <p>
   * Calculates a signature hash, that is, a hash of a simplified form of the
   * transaction. How exactly the transaction is simplified is specified by the
   * type and anyoneCanPay parameters.
   * </p>
   *
   * <p>
   * This is a low level API and when using the regular {@link Wallet} class you
   * don't have to call this yourself. When working with more complex transaction
   * types and contracts, it can be necessary. When signing a P2SH output the
   * redeemScript should be the script encoded into the scriptSig field, for
   * normal transactions, it's the scriptPubKey of the output you're signing for.
   * </p>
   *
   * @param inputIndex   input the signature is being calculated for. Tx
   *                     signatures are always relative to an input.
   * @param redeemScript the script that should be in the given input during
   *                     signing.
   * @param type         Should be SigHash.ALL
   * @param anyoneCanPay should be false.
   */
  public hashForSignatureScript(
    inputIndex: number,
    redeemScript: Script,
    type: SigHash,
    anyoneCanPay: boolean
  ): Sha256Hash {
    const sigHash = TransactionSignature.calcSigHashValue(type, anyoneCanPay);
    return this.hashForSignature3(
      inputIndex,
      redeemScript.getProgram(),
      sigHash
    );
  }

  /**
   * Creates a transaction from the given serialized bytes, eg, from a block or a
   * tx network message.
   */
  public static setTransaction2(
    params: NetworkParameters,
    payloadBytes: Uint8Array
  ): Transaction {
    const a = new Transaction(params);
    a.setValues3(params, payloadBytes, 0);
    return a;
  }

  /**
   * Creates a transaction by reading payload starting from offset bytes in.
   * Length of a transaction is fixed.
   */
  public static setTransaction3(
    params: NetworkParameters,
    payload: Uint8Array,
    offset: number
  ): Transaction {
    const a = new Transaction(params);
    a.setValues3(params, payload, offset);
    return a;
  }

  /**
   * Creates a transaction by reading payload starting from offset bytes in.
   * Length of a transaction is fixed.
   *
   * @param params  NetworkParameters object.
   * @param payload Bitcoin protocol formatted byte array containing message
   *                content.
   * @param offset  The location of the first payload byte within the array.
   * @param length  The length of message if known. Usually this is provided when
   *                deserializing of the wire as the length will be provided as
   *                part of the header. If unknown then set to
   *                Message.UNKNOWN_LENGTH
   */
  public static fromTransaction6(
    params: NetworkParameters,
    payload: Uint8Array,
    offset: number,
    parent: Block | null,
    serializer: MessageSerializer<NetworkParameters>,
    length: number
  ): Transaction {
    const a = new Transaction(params);
    a.setValues5(params, payload, offset, serializer, length);
    a.setParent(parent);
    return a;
  }

  /**
   * Creates a transaction by reading payload. Length of a transaction is fixed.
   */
  public static fromTransaction5(
    params: NetworkParameters,
    payload: Uint8Array,
    parent: Block | null,
    serializer: MessageSerializer<NetworkParameters>,
    length: number
  ): Transaction {
    const a = new Transaction(params);
    a.setValues5(params, payload, 0, serializer, length);
    a.setParent(parent);
    return a;
  }

  public static createCoinbaseTransaction(
    params: NetworkParameters,
    to: Uint8Array,
    value: Coin,
    tokenInfo: any | null = null, // Use any for now to fix TokenInfo error
    memoInfo: any | null = null // Use any for now to fix MemoInfo error
  ): Transaction {
    const transaction = new Transaction(params);
    
    // Create ECKey from public key bytes, then use ScriptBuilder to create output script
    const ecKey = ECKey.fromPublic(to);
    const script = ScriptBuilder.createOutputScript(ecKey);
    const output = new TransactionOutput(params, transaction, value, script.getProgram());
    
    // Create the coinbase input using the proper factory method
    const input = TransactionInput.fromCoinBase(params, transaction, output);
    // Override the script bytes to use the proper coinbase script (e.g., block height info)
    input.setScriptBytes(new Uint8Array([0, 0])); // Two zero bytes for coinbase
    transaction.addInput(input);

    transaction.addOutput(output);

    if (tokenInfo) {
      // Use the actual class name instead of calling .classname()
      transaction.setDataClassName("TokenInfo");
      transaction.setData(tokenInfo.toByteArray());
    }

    if (memoInfo) {
      // Create a simple memo string
      transaction.setMemo(memoInfo.toString());
    }

    return transaction;
  }

  /**
   * Returns the transaction hash as you see them in the block explorer.
   */
  public getHash(): Sha256Hash {
     
     if (this.hash === null) {
      // Serialize the transaction excluding memo and dataSignature fields using positive count
      const buf = new Uint8Array(this.bitcoinSerializeWithoutMemoAndDataSignature());
      // console.debug("bitcoinSerializeWithoutMemoAndDataSignature transaction= " + Utils.HEX.encode(buf));
      this.hash = Sha256Hash.wrapReversed(
        Sha256Hash.hashTwice(buf)
      );
     //console.debug("getHash was null "  );
     }
    //  console.debug("getHash " +this.hash.toString());
    return this.hash;
  }

   public calcHash(): Sha256Hash {
    this.hash = null;
    return this.getHash();
   }

  private calculateMemoLen(): number {
    let len = 4;
    if (this.memo !== null) {
      len += new TextEncoder().encode(this.memo).length;
    }
    return len;
  }

  private calculateDataSignatureLen(): number {
    let len = 4;
    if (this.dataSignature !== null) {
      len += this.dataSignature.length;
    }
    return len;
  }

  /**
   * Used by BitcoinSerializer. The serializer has to calculate a hash for
   * checksumming so to avoid wasting the considerable effort a set method is
   * provided so the serializer can set it.
   * <p>
   * No verification is performed on this hash.
   */
  public setHash(hash: Sha256Hash): void {
    this.hash = hash;
  }

  public getHashAsString(): string {
    return this.getHash().toString();
  }

  /**
   * Calculates the sum of the outputs that are sending coins to a key in the
   * wallet.
   */
  public getValueSentToMe(transactionBag: TransactionBag): Coin {
    // This is tested in WalletTest.
    let v = CoinConstants.ZERO;
    for (const o of this.outputs) {
      if (!o.isMineOrWatched(transactionBag)) continue;
      v = v.add(o.getValue());
    }
    return v;
  }

  /**
   * Returns a map of block [hashes] which contain the transaction mapped to
   * relativity counters, or null if this transaction doesn't have that data
   * because it's not stored in the wallet or because it has never appeared in a
   * block.
   */
  public getAppearsInHashes(): Map<Sha256Hash, number> | null {
    return this.appearsInHashes !== null ? new Map(this.appearsInHashes) : null;
  }

  public addBlockAppearance(
    blockHash: Sha256Hash,
    relativityOffset: number
  ): void {
    if (this.appearsInHashes === null) {
      // TODO: This could be a lot more memory efficient as we'll
      // typically only store one element.
      this.appearsInHashes = new Map();
    }
    this.appearsInHashes.set(blockHash, relativityOffset);
  }

  /**
   * Gets the sum of the outputs of the transaction. If the outputs are less than
   * the inputs, it does not count the fee.
   *
   * @return the sum of the outputs regardless of who owns them.
   */
  public getOutputSum(): bigint {
    let totalOut = BigInt(0);

    for (const output of this.outputs) {
      totalOut += output.getValue().getValue();
    }

    return totalOut;
  }

  /**
   * Returns true if any of the outputs is marked as spent.
   */
  public isAnyOutputSpent(): boolean {
    for (const output of this.outputs) {
      if (!output.isAvailableForSpending()) return true;
    }
    return false;
  }

  /**
   * Returns false if this transaction has at least one output that is owned by
   * the given wallet and unspent, true otherwise.
   */
  public isEveryOwnedOutputSpent(transactionBag: TransactionBag): boolean {
    for (const output of this.outputs) {
      if (
        output.isAvailableForSpending() &&
        output.isMineOrWatched(transactionBag)
      )
        return false;
    }
    return true;
  }

  public setUpdateTime(updatedAt: Date): void {
    // This is either the time the transaction was broadcast as measured from
    // the local clock, or the time from the
    // block in which it was included. Note that this can be changed by re-orgs
    // so the wallet may update this field.
    // Old serialized transactions don't have this field, thus null is valid. It
    // is used for returning an ordered
    // list of transactions from a wallet, which is helpful for presenting to
    // users.
    this.unCache();
  }

  /**
   * @deprecated Instead use SigHash.ANYONECANPAY.value or
   *             SigHash.ANYONECANPAY.byteValue() as appropriate.
   */
  public static readonly SIGHASH_ANYONECANPAY_VALUE: number = 0x80;

  protected unCache(): void {
    super.unCache();
    this.hash = null;
  }

  protected static calcLength(buf: Uint8Array, offset: number): number {
    let varint: VarInt;
    // jump past version (uint32)
    let cursor = offset + 4;

    let i: number;

    varint = new VarInt(buf, cursor);
    const txInCount = Number(varint.value);
    cursor += varint.getOriginalSizeInBytes();

    for (i = 0; i < txInCount; i++) {
      // 36 = length of previous_outpoint
      cursor += 36;
      varint = new VarInt(buf, cursor);
      const scriptLen = Number(varint.value);
      // 4 = length of sequence field (unint32)
      cursor += scriptLen + 4 + varint.getOriginalSizeInBytes();
    }

    varint = new VarInt(buf, cursor);
    const txOutCount = Number(varint.value);
    cursor += varint.getOriginalSizeInBytes();

    for (i = 0; i < txOutCount; i++) {
      // 8 = length of tx value field (uint64)
      cursor += 8;
      varint = new VarInt(buf, cursor);
      const scriptLen = Number(varint.value);
      cursor += scriptLen + varint.getOriginalSizeInBytes();
    }
    // 4 = length of lock_time field (uint32)
    return cursor - offset + 4;
  }

  protected parse(): void {
    this.cursor = this.offset;

    this.version = this.readUint32();
    this.optimalEncodingMessageSize = 4;

    // First come the inputs.
    const numInputs = this.readVarInt();
    this.optimalEncodingMessageSize += VarInt.sizeOf(numInputs);
    this.inputs = [];
    for (let i = 0; i < numInputs; i++) {
      const input = TransactionInput.fromTransactionInput5(
        this.params!,
        this,
        this.payload!,
        this.cursor,
        this.serializer!
      );
      this.inputs.push(input);

      const scriptLen = this.readVarInt1(TransactionOutPoint.MESSAGE_LENGTH);
      const connectedOutput = input.getOutpoint().connectedOutput;
      const addLen =
        4 + (connectedOutput == null ? 0 : connectedOutput.getMessageSize());
      this.optimalEncodingMessageSize +=
        TransactionOutPoint.MESSAGE_LENGTH +
        addLen +
        VarInt.sizeOf(scriptLen) +
        scriptLen +
        4;
      this.cursor += scriptLen + 4 + addLen;
    }

    // Now the outputs
    const numOutputs = this.readVarInt();
    this.optimalEncodingMessageSize += VarInt.sizeOf(numOutputs);
    this.outputs = [];
    for (let i = 0; i < numOutputs; i++) {
      const output = TransactionOutput.fromTransactionOutput(
        this.params!,
        this,
        this.payload!,
        this.cursor,
        this.serializer!
      );
      this.outputs.push(output);
      this.cursor += output.getMessageSize();
      this.optimalEncodingMessageSize += output.getMessageSize();
    }

    this.lockTime = this.readUint32();
    this.optimalEncodingMessageSize += 4;

    let len = this.readUint32();
    this.optimalEncodingMessageSize += VarInt.sizeOf(len);
    if (len > 0) {
      const buf = this.readBytes(len);
      this.dataClassName = new TextDecoder().decode(buf);
      this.optimalEncodingMessageSize += len;
    }

    len = this.readUint32();
    this.optimalEncodingMessageSize += VarInt.sizeOf(len);
    if (len > 0) {
      this.data = this.readBytes(len);
      this.optimalEncodingMessageSize += len;
    }

    len = this.readUint32();
    this.optimalEncodingMessageSize += VarInt.sizeOf(len);
    if (len > 0) {
      this.toAddressInSubtangle = this.readBytes(len);
      this.optimalEncodingMessageSize += len;
    }

    len = this.readUint32();
    this.optimalEncodingMessageSize += VarInt.sizeOf(len);
    if (len > 0) {
      this.memo = new TextDecoder().decode(this.readBytes(len));
      this.optimalEncodingMessageSize += len;
    }

    len = this.readUint32();
    this.optimalEncodingMessageSize += VarInt.sizeOf(len);
    if (len > 0) {
      this.dataSignature = this.readBytes(len);
      this.optimalEncodingMessageSize += len;
    }

    this.length = this.cursor - this.offset;
     this.calcHash;
  }

  public getOptimalEncodingMessageSize(): number {
    if (this.optimalEncodingMessageSize !== 0)
      return this.optimalEncodingMessageSize;
    this.optimalEncodingMessageSize = this.getMessageSize();
    return this.optimalEncodingMessageSize;
  }

  /**
   * The priority (coin age) calculation doesn't use the regular message size, but
   * rather one adjusted downwards for the number of inputs. The goal is to
   * incentivise cleaning up the UTXO set with free transactions, if one can do
   * so.
   */
  public getMessageSizeForPriorityCalc(): number {
    let size = this.getMessageSize();
    for (const input of this.inputs) {
      // 41: min size of an input
      // 110: enough to cover a compressed pubkey p2sh redemption
      // (somewhat arbitrary).
      const benefit =
        41 + Math.min(110, input.getScriptSig().getProgram().length);
      if (size > benefit) size -= benefit;
    }
    return size;
  }

  /**
   * A coinbase transaction is one that creates a new coin.
   */
  public isCoinBase(): boolean {
    return this.inputs.length === 1 && this.inputs[0].isCoinBase();
  }

  /**
   * A human readable version of the transaction useful for debugging. The format
   * is not guaranteed to be stable.
   *
   */
  public toString(): string {
    let s: string[] = [];
    s.push("  " + (this.hash ? this.hash.toString() : this.calcHash().toString()) + "\n");
    // if (this.updatedAt != null)
    //     s.push(" updated: " + Utils.dateTimeFormat(this.updatedAt) + '\n');
    if (this.version !== 1) s.push("  version " + this.version + "\n");
    if (this.isTimeLocked()) {
      s.push("  time locked until ");
      if (this.lockTime < Transaction.LOCKTIME_THRESHOLD) {
        s.push("block " + this.lockTime);
      } else {
        s.push(Utils.dateTimeFormat(this.lockTime * 1000));
      }
      s.push("\n");
    }
    if (this.isOptInFullRBF()) {
      s.push("  opts into full replace-by-fee\n");
    }
    if (this.isCoinBase()) {
      let script: string;
      let script2: string;
      try {
        script =
          this.inputs.length === 0
            ? "None"
            : this.inputs[0].getScriptSig().toString();
        script2 =
          this.outputs.length === 0 ? "None" : this.outputs[0].toString();
      } catch (e: any) {
        script = "???";
        script2 = "???";
      }
      s.push(
        "     == COINBASE (scriptSig " +
          script +
          ")  (scriptPubKey " +
          script2 +
          ")\n"
      );
      return s.join("");
    }
    if (this.inputs.length > 0) {
      for (const input of this.inputs) {
        s.push("     ");
        s.push("in   ");
        try {
          let scriptSigStr = "";
          const ss = input.getScriptSig();
          if (ss) scriptSigStr = ss.toString();
          s.push(
            scriptSigStr && scriptSigStr.length > 0
              ? scriptSigStr
              : "<no scriptSig>"
          );
          const inputValue = input.getValue ? input.getValue() : null;
          if (inputValue != null) s.push(" " + inputValue.toString());
          s.push("\n          ");
          s.push("outpoint:");
          const outpoint = input.getOutpoint ? input.getOutpoint() : null;
          s.push(outpoint ? outpoint.toString() : "null");
          const connectedOutput =
            outpoint && outpoint.getConnectedOutput
              ? outpoint.getConnectedOutput()
              : null;
          if (connectedOutput != null) {
            const scriptPubKey = connectedOutput.getScriptPubKey
              ? connectedOutput.getScriptPubKey()
              : null;
            if (
              scriptPubKey &&
              (scriptPubKey.isSentToAddress() ||
                scriptPubKey.isPayToScriptHash())
            ) {
              s.push(" hash160:");
              s.push(Utils.HEX.encode(scriptPubKey.getPubKeyHash()));
            }
          }
          if (input.hasSequence && input.hasSequence()) {
            s.push(
              "\n          sequence:" +
                (input.getSequenceNumber
                  ? input.getSequenceNumber().toString(16)
                  : "unknown")
            );
            if (input.isOptInFullRBF && input.isOptInFullRBF())
              s.push(", opts into full RBF");
          }
        } catch (e: any) {
          s.push("[exception: " + (e && e.message ? e.message : e) + "]");
        }
        s.push("\n");
      }
    } else {
      s.push("     ");
      // s.push("INCOMPLETE: No inputs!\n");
    }
    for (const out of this.outputs) {
      s.push("     ");
      s.push("out  ");
      try {
        let scriptPubKeyStr = out.getScriptPubKey
          ? out.getScriptPubKey().toString()
          : "";
        s.push(
          scriptPubKeyStr && scriptPubKeyStr.length > 0
            ? scriptPubKeyStr
            : "<no scriptPubKey>"
        );
        s.push("\n ");
        s.push(out.getValue().toString());
        if (!out.isAvailableForSpending()) {
          s.push(" Spent");
        }
        const spentBy = out.getSpentBy ? out.getSpentBy() : null;
        if (spentBy != null) {
          const pt = spentBy.getParentTransaction
            ? spentBy.getParentTransaction()
            : null;
          if (pt && pt.getHash) {
            const h = pt.getHash();
            s.push(" by ");
            s.push(h ? h.toString() : "unknown");
          } else {
            s.push(" by unknown");
          }
        }
      } catch (e: any) {
        s.push("[exception: " + (e && e.message ? e.message : e) + "]");
      }
      s.push("\n");
    }
    if (this.memo != null) s.push("   memo " + this.memo + "\n");
    return s.join("");
  }

  /**
   * Removes all the inputs from this transaction. Note that this also invalidates
   * the length attribute
   */
  public clearInputs(): void {
    this.unCache();
    for (const input of this.inputs) {
      input.setParent(null);
    }
    this.inputs = [];
    // You wanted to reserialize, right?
    this.length = this.unsafeBitcoinSerialize().length;
  }

  /**
   * Adds an input to this transaction that imports value from the given output.
   * Note that this input is <i>not</i> complete and after every input is added
   * with and every output is added with , a {@link TransactionSigner} must be
   * used to finalize the transaction and finish the inputs off. Otherwise it
   * won't be accepted by the network.
   *
   * @return the newly created input.
   */
  public addInput2(blockHash: Sha256Hash | null, from: TransactionOutput): TransactionInput { 
      if (this.params==null || blockHash == null) {
        throw new ProtocolException("Network parameters not set");
      }
      return this.addInput1(TransactionInput.fromTransactionInput4(this.params, this, from, blockHash ));
  }
  
  // Alias for backward compatibility
  public addInput(input: TransactionInput): TransactionInput {
      return this.addInput1(input);
  }

  public addInput1(input: TransactionInput): TransactionInput {
    this.unCache();
    input.setParent(this);
    this.inputs.push(input);
    this.adjustLength2(this.inputs.length, 0);
    return input;
  }

  protected adjustLength2(newArraySize: number, adjustment: number): void {
    // The super class might not have this method, so we'll skip calling it
    if (this.parent !== null && (this.parent as any).adjustLength2) {
      (this.parent as any).adjustLength2(newArraySize, adjustment);
    }
  }

  /**
   * Adds a new and fully signed input for the given parameters. Note that this
   * method is <b>not</b> thread safe and requires external synchronization.
   * Please refer to general documentation on Bitcoin scripting and contracts to
   * understand the values of sigHash and anyoneCanPay: otherwise you can use the
   * other form of this method that sets them to typical defaults.
   *
   * @throws ScriptException if the scriptPubKey is not a pay to address or pay to
   *                         pubkey script.
   */
  public async addSignedInput(
    prevOut: TransactionOutPoint,
    scriptPubKey: Script,
    sigKey: ECKey,
    sigHash: SigHash,
    anyoneCanPay: boolean
  ): Promise<TransactionInput> {
    // TODO: Implement this method properly
    throw new Error("addSignedInput not implemented");
  }

  public async signInputs(
    prevOut: TransactionOutPoint,
    scriptPubKey: Script,
    sigKey: ECKey
  ): Promise<void> {
    // TODO: Implement this method properly
    throw new Error("signInputs not implemented");
  }

  /**
   * Same as
   * {@link #addSignedInput(TransactionOutPoint, net.bigtangle.script.Script, ECKey, net.bigtangle.core.Transaction.SigHash, boolean)}
   * but defaults to {@link SigHash#ALL} and "false" for the anyoneCanPay flag.
   * This is normally what you want.
   */
  public async addSignedInputDefault(
    prevOut: TransactionOutPoint,
    scriptPubKey: Script,
    sigKey: ECKey
  ): Promise<TransactionInput> {
    // TODO: Implement this method properly
    throw new Error("addSignedInputDefault not implemented");
  }

  /**
   * Removes all the outputs from this transaction. Note that this also
   * invalidates the length attribute
   */
  public clearOutputs(): void {
    this.unCache();
    for (const output of this.outputs) {
      output.setParent(null);
    }
    this.outputs = [];
    // You wanted to reserialize, right?
    this.length = this.unsafeBitcoinSerialize().length;
  }
  /**
   * Creates an output based on the given address and value, adds it to this
   * transaction, and returns the new output.
   */
  public addOutputAddress(value: Coin, address: Address): TransactionOutput {
    if (this.params == null) {
      throw new ProtocolException("Network parameters not set");
    }
    return this.addOutput(
      TransactionOutput.fromAddress(this.params, this, value, address)
    );
  }

  /**
   * Creates an output that pays to the given pubkey directly (no address) with
   * the given value, adds it to this transaction, and returns the new output.
   */
  public addOutputEckey(value: Coin, pubkey: ECKey): TransactionOutput {
    if (this.params == null) {
      throw new ProtocolException("Network parameters not set");
    }
    return this.addOutput(
      TransactionOutput.fromCoinKey(this.params, this, value, pubkey)
    );
  }

  /**
   * Adds the given output to this transaction. The output must be completely
   * initialized. Returns the given output.
   */
  public addOutput(to: TransactionOutput): TransactionOutput {
    this.unCache();
    to.setParent(this);
    this.outputs.push(to);
    this.adjustLength(this.outputs.length, to.getLength());
    return to;
  }

  /**
   * Creates an output that pays to the given script. The address and key forms
   * are specialisations of this method, you won't normally need to use it unless
   * you're doing unusual things.
   */
  public addOutputScript(value: Coin, script: Script): TransactionOutput {
    if (this.params == null) {
      throw new ProtocolException("Network parameters not set");
    }
    return this.addOutput(
      new TransactionOutput(this.params, this, value, script.getProgram())
    );
  }

  /**
   * Calculates a signature that is valid for being inserted into the input at the
   * given position. This is simply a wrapper around calling
   * {@link Transaction#hashForSignature(int, byte[], net.bigtangle.core.Transaction.SigHash, boolean)}
   * followed by {@link ECKey#sign(Sha256Hash)} and then returning a new
   * {@link TransactionSignature}. The key must be usable for signing as-is: if
   * the key is encrypted it must be decrypted first external to this method.
   *
   * @param inputIndex   Which input to calculate the signature for, as an index.
   * @param key          The private key used to calculate the signature.
   * @param redeemScript Byte-exact contents of the scriptPubKey that is being
   *                     satisified, or the P2SH redeem script.
   * @param hashType     Signing mode, see the enum for documentation.
   * @param anyoneCanPay Signing mode, see the SigHash enum for documentation.
   * @return A newly calculated signature object that wraps the r, s and sighash
   *         components.
   */
  public async calculateSignature(
    inputIndex: number,
    key: ECKey,
    redeemScript: Uint8Array,
    hashType: SigHash,
    anyoneCanPay: boolean
  ): Promise<TransactionSignature> {
    const hash = this.hashForSignature(
      inputIndex,
      redeemScript,
      hashType,
      anyoneCanPay
    );
    const signature: ECDSASignature = await key.sign(hash.getBytes());
    // Ensure signature is canonical (S value is low) to follow Bitcoin standard
    const canonicalSignature = signature.toCanonicalised();
    return new TransactionSignature(canonicalSignature, hashType, anyoneCanPay);
  }

 
  /**
   * <p>
   * Calculates a signature hash, that is, a hash of a simplified form of the
   * transaction. How exactly the transaction is simplified is specified by the
   * type and anyoneCanPay parameters.
   * </p>
   *
   * <p>
   * This is a low level API and when using the regular {@link Wallet} class you
   * don't have to call this yourself. When working with more complex transaction
   * types and contracts, it can be necessary. When signing a P2SH output the
   * redeemScript should be the script encoded into the scriptSig field, for
   * normal transactions, it's the scriptPubKey of the output you're signing for.
   * </p>
   *
   * @param inputIndex   input the signature is being calculated for. Tx
   *                     signatures are always relative to an input.
   * @param redeemScript the bytes that should be in the given input during
   *                     signing.
   * @param type         Should be SigHash.ALL
   * @param anyoneCanPay should be false.
   */
  public hashForSignature(
    inputIndex: number,
    redeemScript: Uint8Array,
    type: SigHash,
    anyoneCanPay: boolean
  ): Sha256Hash {
    const sigHashType = TransactionSignature.calcSigHashValue(
      type,
      anyoneCanPay
    );
    return this.hashForSignature3(inputIndex, redeemScript, sigHashType);
  }

  /**
   * <p>
   * Calculates a signature hash, that is, a hash of a simplified form of the
   * transaction. How exactly the transaction is simplified is specified by the
   * type and anyoneCanPay parameters.
   * </p>
   *
   * <p>
   * This is a low level API and when using the regular {@link Wallet} class you
   * don't have to call this yourself. When working with more complex transaction
   * types and contracts, it can be necessary. When signing a P2SH output the
   * redeemScript should be the script encoded into the scriptSig field, for
   * normal transactions, it's the scriptPubKey of the output you're signing for.
   * </p>
   *
   * @param inputIndex   input the signature is being calculated for. Tx
   *                     signatures are always relative to an input.
   * @param redeemScript the script that should be in the given input during
   *                     signing.
   * @param type         Should be SigHash.ALL
   * @param anyoneCanPay should be false.
   */
  public hashForSignature2(
    inputIndex: number,
    redeemScript: Script,
    type: SigHash,
    anyoneCanPay: boolean
  ): Sha256Hash {
    const sigHash = TransactionSignature.calcSigHashValue(type, anyoneCanPay);
    return this.hashForSignature3(
      inputIndex,
      redeemScript.getProgram(),
      sigHash
    );
  }

  // TODO check this, do signatures sign everything in the transaction?
  /**
   * This is required for signatures which use a sigHashType which cannot be
   * represented using SigHash and anyoneCanPay See transaction
   * c99c49da4c38af669dea436d3e73780dfdb6c1ecf9958baa52960e8baee30e73, which has
   * sigHashType 0
   */
  public hashForSignature3(
    inputIndex: number,
    connectedScript: Uint8Array,
    sigHashType: number
  ): Sha256Hash {
    if (!this.params) {
      throw new Error("Network parameters not set");
    }

    // This step has no purpose beyond being synchronized with Bitcoin Core's bugs.
    // OP_CODESEPARATOR is a legacy holdover from a previous, broken design of executing
    // scripts that shipped in Bitcoin 0.1. It was seriously flawed and would have let anyone
    // take anyone elses money. Later versions switched to the design we use today where 
    // scripts are executed independently but share a stack. This left the OP_CODESEPARATOR 
    // instruction having no purpose as it was only meant to be used internally, not actually
    // ever put into scripts. Deleting OP_CODESEPARATOR is a step that should never be 
    // required but if we don't do it, we could split off the main chain.
    connectedScript = Script.removeAllInstancesOfOp(connectedScript, ScriptOpCodes.OP_CODESEPARATOR);

    // Create a copy of this transaction to operate upon because we need
    // make changes to the inputs and outputs.
    // It would not be thread-safe to change the attributes of the
    // transaction object itself.
    const tx = this.params.getDefaultSerializer().makeTransaction(new Uint8Array(this.bitcoinSerialize()));

    // Clear input scripts in preparation for signing. If we're signing
    // a fresh transaction that step isn't very helpful, but it doesn't add much
    // cost relative to the actual EC math so we'll do it anyway.
    for (let i = 0; i < tx.inputs.length; i++) {
      tx.inputs[i].clearScriptBytes();
    }

    // Set the input to the script of its output. Bitcoin Core does this
    // but the step has no obvious purpose as the signature covers the hash 
    // of the prevout transaction which obviously includes the output script
    // already. Perhaps it felt safer to him in some way, or is another
    // leftover from how the code was written.
    const input = tx.inputs[inputIndex];
    input.setScriptBytes(connectedScript);

    if ((sigHashType & 0x1f) === 2) { // SIGHASH_NONE
      // SIGHASH_NONE means no outputs are signed at all - the
      // signature is effectively for a "blank cheque".
      tx.outputs = [];
      // The signature isn't broken by new versions of the transaction
      // issued by other parties.
      for (let i = 0; i < tx.inputs.length; i++)
        if (i !== inputIndex)
          tx.inputs[i].setSequenceNumber(0);
    } else if ((sigHashType & 0x1f) === 3) { // SIGHASH_SINGLE
      // SIGHASH_SINGLE means only sign the output at the same index
      // as the input (ie, my output).
      if (inputIndex >= tx.outputs.length) {
        // The input index is beyond the number of outputs, it's a
        // buggy signature made by a broken
        // Bitcoin implementation. Bitcoin Core also contains a bug
        // in handling this case:
        // any transaction output that is signed in this case will
        // result in both the signed output
        // and any future outputs to this public key being
        // steal-able by anyone who has
        // the resulting signature and the public key (both of which
        // are part of the signed tx input).

        // Bitcoin Core's bug is that SignatureHash was supposed to
        // return a hash and on this codepath it
        // actually returns the constant "1" to indicate an error,
        // which is never checked for. Oops.
        return Sha256Hash.wrapString("0100000000000000000000000000000000000000000000000000000000000000");
      }
      // In SIGHASH_SINGLE the outputs after the matching input index
      // are deleted, and the outputs before
      // that position are "nulled out". Unintuitively, the value in a
      // "null" transaction is set to -1.
      tx.outputs = tx.outputs.slice(0, inputIndex + 1);
      for (let i = 0; i < inputIndex; i++)
        tx.outputs[i] = new TransactionOutput(tx.params!, tx, CoinConstants.NEGATIVE_SATOSHI, new Uint8Array());
      // The signature isn't broken by new versions of the transaction
      // issued by other parties.
      for (let i = 0; i < tx.inputs.length; i++)
        if (i !== inputIndex)
          tx.inputs[i].setSequenceNumber(0);
    }

    if ((sigHashType & 0x80) !== 0) { // SIGHASH_ANYONECANPAY
      // SIGHASH_ANYONECANPAY means the signature in the input is not
      // broken by changes/additions/removals
      // of other inputs. For example, this is useful for building
      // assurance contracts.
      tx.inputs = [input];
    }

    // Serialize and hash the transaction
    const stream = new UnsafeByteArrayOutputStream(
      tx.length === (tx.constructor as any).UNKNOWN_LENGTH ? 256 : tx.length + 4
    );
    // Use the signature hash serialization method that includes additional fields
    tx.bitcoinSerializeForSignatureHash(stream);
    // We also have to write a hash type (sigHashType is actually an unsigned char)
    Utils.uint32ToByteStreamLE(sigHashType & 0x000000ff, stream);
    // Note that this is NOT reversed to ensure it will be signed
    // correctly. If it were to be printed out
    // however then we would expect that it is IS reversed.
    const hash = Sha256Hash.twiceOf(stream.toByteArray());

    return hash;
  }

  protected bitcoinSerializeForSignature(stream: any): void {
    Utils.uint32ToByteStreamLE(this.version, stream);
    stream.write(new VarInt(this.inputs.length).encode());
    for (const input of this.inputs) {
      input.bitcoinSerialize(stream);
    }
    stream.write(new VarInt(this.outputs.length).encode());
    for (const output of this.outputs) {
      output.bitcoinSerialize(stream);
    }
    Utils.uint32ToByteStreamLE(this.lockTime, stream);
  }

  protected bitcoinSerializeForSignatureHash(stream: any): void {
    Utils.uint32ToByteStreamLE(this.version, stream);
    stream.write(new VarInt(this.inputs.length).encode());
    for (const input of this.inputs) {
      input.bitcoinSerialize(stream);
    }
    stream.write(new VarInt(this.outputs.length).encode());
    for (const output of this.outputs) {
      output.bitcoinSerialize(stream);
    }
    Utils.uint32ToByteStreamLE(this.lockTime, stream);
    
    // Include additional fields that are part of the signature hash calculation
    // write dataClassName
    if (this.dataClassName == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.dataClassName.length, stream);
      stream.write(new TextEncoder().encode(this.dataClassName));
    }

    // write data
    if (this.data == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.data.length, stream);
      if (this.data.length > 0) {
        stream.write(this.data);
      }
    }

    // write toAddressInSubtangle
    if (this.toAddressInSubtangle == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.toAddressInSubtangle.length, stream);
      if (this.toAddressInSubtangle.length > 0) {
        stream.write(this.toAddressInSubtangle);
      }
    }

    // write memo
    if (this.memo == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      const membyte = new TextEncoder().encode(this.memo);
      Utils.uint32ToByteStreamLE(membyte.length, stream);
      stream.write(membyte);
    }

    // write dataSignature
    if (this.dataSignature == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.dataSignature.length, stream);
      if (this.dataSignature.length > 0) {
        stream.write(this.dataSignature);
      }
    }
  }

  public unsafeBitcoinSerialize(): Uint8Array {
    const stream = new UnsafeByteArrayOutputStream(this.length < 32 ? 32 : this.length + 32);
    this.bitcoinSerializeToStream(stream);
    return stream.toByteArray();
  }

  public unsafeBitcoinSerializeForSignature(): Uint8Array {
    const stream = new UnsafeByteArrayOutputStream(this.length < 32 ? 32 : this.length + 32);
    this.bitcoinSerializeForSignature(stream);
    return stream.toByteArray();
  }

  protected bitcoinSerializeToStream(stream: any): void {
    this.bitcoinSerializeForSignature(stream);
    // write dataClassName
    if (this.dataClassName == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      const classNameBytes = new TextEncoder().encode(this.dataClassName);
      Utils.uint32ToByteStreamLE(classNameBytes.length, stream);
      stream.write(classNameBytes);
    }

    // write data
    if (this.data == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.data.length, stream);
      if (this.data.length > 0) {
        stream.write(this.data);
      }
    }

    // write toAddressInSubtangle
    if (this.toAddressInSubtangle == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.toAddressInSubtangle.length, stream);
      if (this.toAddressInSubtangle.length > 0) {
        stream.write(this.toAddressInSubtangle);
      }
    }

    // write memo
    if (this.memo == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      const membyte = new TextEncoder().encode(this.memo);
      Utils.uint32ToByteStreamLE(membyte.length, stream);
      stream.write(membyte);
    }

    // write dataSignature
    if (this.dataSignature == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.dataSignature.length, stream);
      stream.write(this.dataSignature);
    }
  }

  /**
   * Transactions can have an associated lock time, specified either as a block
   * height or in seconds since the UNIX epoch. A transaction is not allowed to be
   * confirmed by miners until the lock time is reached, and since Bitcoin 0.8+ a
   * transaction that did not end its lock period (non final) is considered to be
   * non standard and won't be relayed or included in the memory pool either.
   */
  public getLockTime(): number {
    return this.lockTime;
  }

  /**
   * Transactions can have an associated lock time, specified either as a block
   * height or in seconds since the UNIX epoch. A transaction is not allowed to be
   * confirmed by miners until the lock time is reached, and since Bitcoin 0.8+ a
   * transaction that did not end its lock period (non final) is considered to be
   * non standard and won't be relayed or included in the memory pool either.
   */
  public setLockTime(lockTime: number): void {
    this.unCache();
    let seqNumSet = false;
    for (const input of this.inputs) {
      if (input.getSequenceNumber() != TransactionInput.NO_SEQUENCE) {
        seqNumSet = true;
        break;
      }
    }
    if (lockTime != 0 && (!seqNumSet || this.inputs.length == 0)) {
      // At least one input must have a non-default sequence number for
      // lock times to have any effect.
      // For instance one of them can be set to zero to make this feature
      // work.
      console.warn(
        "You are setting the lock time on a transaction but none of the inputs have non-default sequence numbers. This will not do what you expect!"
      );
    }
    this.lockTime = lockTime;
  }

  /**
   * Serialize the transaction excluding memo and dataSignature fields
   * This is used for calculating the transaction hash using positive counting approach.
   */
  private bitcoinSerializeWithoutMemoAndDataSignature(): Uint8Array {
    const stream = new UnsafeByteArrayOutputStream(this.length < 32 ? 32 : this.length);
    
    // Serialize all fields except memo and dataSignature (positive counting approach)
    Utils.uint32ToByteStreamLE(this.version, stream);
    stream.write(new VarInt(this.inputs.length).encode());
    for (const input of this.inputs) {
      input.bitcoinSerialize(stream);
    }
    stream.write(new VarInt(this.outputs.length).encode());
    for (const output of this.outputs) {
      output.bitcoinSerialize(stream);
    }
    Utils.uint32ToByteStreamLE(this.lockTime, stream);
    
    // write dataClassName
    if (this.dataClassName == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.dataClassName.length, stream);
      stream.write(new TextEncoder().encode(this.dataClassName));
    }

    // write data
    if (this.data == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.data.length, stream);
      if (this.data.length > 0) {
        stream.write(this.data);
      }
    }

    // write toAddressInSubtangle
    if (this.toAddressInSubtangle == null) {
      Utils.uint32ToByteStreamLE(0, stream);
    } else {
      Utils.uint32ToByteStreamLE(this.toAddressInSubtangle.length, stream);
      if (this.toAddressInSubtangle.length > 0) {
        stream.write(this.toAddressInSubtangle);
      }
    }

    // Note: memo and dataSignature are intentionally excluded entirely (not even lengths written)
    // This matches the Java implementation's positive counting approach

    return stream.toByteArray();
  }
}
