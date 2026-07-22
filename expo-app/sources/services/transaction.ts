/**
 * Transaction Service for Bigtangle
 *
 * Handles transaction creation, signing, and broadcasting
 */

import { ECKey, TestParams, Utils, Address, Coin, Sha256Hash, Script, ScriptBuilder } from 'bigtangle-ts';
// @ts-ignore
import { Transaction } from 'bigtangle-ts/dist/net/bigtangle/core/Transaction';
// @ts-ignore
import { TransactionInput } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionInput';
// @ts-ignore
import { TransactionOutput } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionOutput';
// @ts-ignore
import { TransactionOutPoint } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionOutPoint';
// @ts-ignore
import { TransactionSignature } from 'bigtangle-ts/dist/net/bigtangle/crypto/TransactionSignature';

import { httpService } from './http';
import type { UTXO, ApiResponse } from '@/types/api';

/**
 * Transaction creation parameters
 */
export interface SendTransactionParams {
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenId: string;
  privateKeyHex: string;
  memo?: string;
  fee?: string;
}

/**
 * Transaction result
 */
export interface TransactionResult {
  txHash: string;
  rawTx: string;
}

/**
 * UTXO selection result
 */
interface SelectedUTXOs {
  utxos: UTXO[];
  totalValue: bigint;
  change: bigint;
}

/**
 * Get TestParams instance (lazy loaded and cached)
 */
let _testParams: any = null;
function getTestParams(): any {
  if (!_testParams) {
    _testParams = TestParams.get();
  }
  return _testParams;
}

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  if (hex.startsWith('0x')) {
    hex = hex.slice(2);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Select UTXOs for transaction
 * Uses a simple greedy algorithm - takes UTXOs until we have enough
 */
function selectUTXOs(
  utxos: UTXO[],
  requiredAmount: bigint,
  fee: bigint
): SelectedUTXOs | null {
  const totalNeeded = requiredAmount + fee;
  const spendableUtxos = utxos.filter((utxo) => utxo.spendable && utxo.confirmed);

  // Sort by value descending to minimize number of inputs
  spendableUtxos.sort((a, b) => {
    const aVal = BigInt(a.value);
    const bVal = BigInt(b.value);
    return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
  });

  let totalValue = BigInt(0);
  const selectedUtxos: UTXO[] = [];

  for (const utxo of spendableUtxos) {
    selectedUtxos.push(utxo);
    totalValue += BigInt(utxo.value);

    if (totalValue >= totalNeeded) {
      const change = totalValue - totalNeeded;
      return {
        utxos: selectedUtxos,
        totalValue,
        change,
      };
    }
  }

  // Not enough funds
  return null;
}

/**
 * Create and sign a transaction
 */
export async function createAndSignTransaction(
  params: SendTransactionParams
): Promise<ApiResponse<TransactionResult>> {
  try {
    const testParams = getTestParams();
    const {
      fromAddress,
      toAddress,
      amount,
      tokenId,
      privateKeyHex,
      memo,
      fee = '1000', // Default fee: 1000 satoshis
    } = params;

    // Convert amounts to BigInt
    const amountValue = BigInt(amount);
    const feeValue = BigInt(fee);

    // Fetch UTXOs for the address
    const utxosResponse = await httpService.getOutputs(fromAddress, tokenId);
    if (!utxosResponse.success || !utxosResponse.data) {
      return {
        success: false,
        error: 'Failed to fetch UTXOs',
      };
    }

    // Select UTXOs
    const selected = selectUTXOs(utxosResponse.data, amountValue, feeValue);
    if (!selected) {
      return {
        success: false,
        error: 'Insufficient funds',
      };
    }

    // Create ECKey from private key
    const bigintVal = BigInt('0x' + privateKeyHex);
    const ecKey = ECKey.fromPrivate(bigintVal);

    // Create transaction
    const tx = new Transaction(testParams);

    // Convert token ID to bytes
    const tokenIdBytes = hexToBytes(tokenId);

    // Add inputs from selected UTXOs
    for (const utxo of selected.utxos) {
      const hash = Sha256Hash.wrap(hexToBytes(utxo.txhash));
      const outPoint = TransactionOutPoint.fromTransactionOutPoint4(testParams, utxo.index, Sha256Hash.ZERO_HASH, hash);

      const scriptBytes = utxo.script ? hexToBytes(utxo.script) : new Uint8Array(0);
      const input = TransactionInput.fromScriptBytes(testParams, tx, scriptBytes);
      tx.addInput(input);
    }

    // Add output to recipient
    const toAddr = Address.fromBase58(testParams, toAddress);
    const recipientCoin = new Coin(amountValue, tokenIdBytes);
    const recipientScript = ScriptBuilder.createOutputScript(toAddr);
    const recipientOutput = new TransactionOutput(testParams, tx, recipientCoin, recipientScript.getProgram());
    tx.addOutput(recipientOutput);

    // Add change output if needed
    if (selected.change > BigInt(0)) {
      const fromAddr = Address.fromBase58(testParams, fromAddress);
      const changeCoin = new Coin(selected.change, tokenIdBytes);
      const changeScript = ScriptBuilder.createOutputScript(fromAddr);
      const changeOutput = new TransactionOutput(testParams, tx, changeCoin, changeScript.getProgram());
      tx.addOutput(changeOutput);
    }

    // Set memo if provided
    if (memo) {
      tx.setMemo(memo);
    }

    // Sign all inputs
    const numInputs = tx.getInputs().length;
    for (let i = 0; i < numInputs; i++) {
      const input = tx.getInput(i);
      const connectedOutput = selected.utxos[i];

      const scriptBytes = connectedOutput.script
        ? hexToBytes(connectedOutput.script)
        : new Uint8Array(0);

      const sigHashBytes = tx.hashForSignatureScript(i, new Script(scriptBytes), 1 as any, false);

      const ecdsaSignature = await ecKey.sign(sigHashBytes.getBytes());
      const txSig = new TransactionSignature(ecdsaSignature, 1 as any, false);
      const scriptSig = ScriptBuilder.createInputScript(txSig, ecKey);
      input.setScriptSig(scriptSig!);
    }

    // Serialize transaction
    const txBytes = tx.bitcoinSerialize();
    const txHex = bytesToHex(txBytes);

    // Calculate transaction hash
    const hash = tx.getHash();
    const txHash = hash.toString();

    return {
      success: true,
      data: {
        txHash,
        rawTx: txHex,
      },
    };
  } catch (error) {
    console.error('[Transaction] Error creating transaction:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create transaction',
    };
  }
}

/**
 * Broadcast a signed transaction to the network
 */
export async function broadcastTransaction(rawTx: string): Promise<ApiResponse<string>> {
  try {
    const serverUrl = httpService.getServerUrl();
    const url = `${serverUrl}broadcastTransaction`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        rawtx: rawTx,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.error) {
      return {
        success: false,
        error: result.error,
      };
    }

    return {
      success: true,
      data: result.txHash || 'Transaction broadcasted',
    };
  } catch (error) {
    console.error('[Transaction] Error broadcasting:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to broadcast transaction',
    };
  }
}

/**
 * Send a transaction (create, sign, and broadcast)
 */
export async function sendTransaction(
  params: SendTransactionParams
): Promise<ApiResponse<string>> {
  // Create and sign transaction
  const createResult = await createAndSignTransaction(params);
  if (!createResult.success || !createResult.data) {
    return {
      success: false,
      error: createResult.error || 'Failed to create transaction',
    };
  }

  // Broadcast transaction
  const broadcastResult = await broadcastTransaction(createResult.data.rawTx);
  if (!broadcastResult.success) {
    return {
      success: false,
      error: broadcastResult.error || 'Failed to broadcast transaction',
    };
  }

  return {
    success: true,
    data: createResult.data.txHash,
  };
}

/**
 * Estimate transaction fee
 */
export function estimateTransactionFee(numInputs: number, numOutputs: number): bigint {
  // Simple fee estimation: base fee + per input/output fee
  const baseFee = BigInt(1000); // 1000 satoshis base
  const perInputFee = BigInt(500); // 500 satoshis per input
  const perOutputFee = BigInt(300); // 300 satoshis per output

  return baseFee + perInputFee * BigInt(numInputs) + perOutputFee * BigInt(numOutputs);
}

/**
 * Calculate total available balance from UTXOs
 */
export function calculateAvailableBalance(utxos: UTXO[]): bigint {
  return utxos
    .filter((utxo) => utxo.spendable && utxo.confirmed)
    .reduce((sum, utxo) => sum + BigInt(utxo.value), BigInt(0));
}

/**
 * Export singleton instance (if needed)
 */
export const transactionService = {
  createAndSignTransaction,
  broadcastTransaction,
  sendTransaction,
  estimateTransactionFee,
  calculateAvailableBalance,
};
