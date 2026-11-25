/*******************************************************************************
 *  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/

import { UTXO } from "../core/UTXO";
import { Sha256Hash } from "../core/Sha256Hash";
import { NetworkParameters } from "../params/NetworkParameters";
import { TransactionOutput } from "../core/TransactionOutput";
import { TransactionOutPoint } from "../core/TransactionOutPoint";
// Add missing import

export class FreeStandingTransactionOutput extends TransactionOutput {
  private output: UTXO;
  private networkParams: NetworkParameters; // Store params locally

  /**
   * Construct a free standing Transaction Output.
   *
   * @param params The network parameters.
   * @param output The stored output (free standing).
   */
  constructor(params: NetworkParameters, output: UTXO) {
    super(params, null, output.getValue(), output.getScript().getProgram());
    this.output = output;
    this.networkParams = params;
  }

  /**
   * Get the {@link UTXO}.
   *
   * @return The stored output.
   */
  public getUTXO(): UTXO {
    return this.output;
  }

  public getIndex(): number {
    return this.output.getIndex();
  }

  
    public  getParentTransactionHash() : Sha256Hash{
        return this.output.getTxHash();
    }
  // Use the parent class implementation for getValue and getScriptBytes
  // since we already set them properly in the constructor

  /**
   * Creates a TransactionOutPoint for this output.
   * @param blockHash The block hash.
   * @return A TransactionOutPoint referencing this output.
   */
  public getOutPointFor(blockHash: Sha256Hash): TransactionOutPoint {
    const txId = this.getParentTransactionHash();
    const outputIndex = this.getIndex();
    return TransactionOutPoint.fromTransactionOutPoint4(this.networkParams, outputIndex, blockHash, txId);
  }

  
}
