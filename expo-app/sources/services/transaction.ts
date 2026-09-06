/**
 * Transaction Service for Bigtangle
 *
 * Handles transaction creation, signing, and broadcasting
 */

import { PQKey, TestParams, MainNetParams, Utils, Address, Coin, Sha256Hash, Script, ScriptBuilder, Wallet, UTXO as SdkUTXO, FreeStandingTransactionOutput, PQConstants } from 'bigtangle-ts';
import i18n from '../lib/i18n';
// @ts-ignore
import { Transaction } from 'bigtangle-ts/dist/net/bigtangle/core/Transaction';
// @ts-ignore
import { TransactionInput } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionInput';
// @ts-ignore
import { TransactionOutput } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionOutput';
// @ts-ignore
import { TransactionOutPoint } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionOutPoint';
import { httpService } from './http';
import { IS_DEV } from '@/constants/app';
import { ReqCmd } from '@/types/api';
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
 * Network parameters for the currently selected network (no caching — the
 * network can change at runtime via the settings testnet toggle). TestParams
 * in dev builds (local test infra) or testnet mode, MainNetParams otherwise.
 * The network also selects the base58 address prefix, so it must match the
 * addresses being created/parsed here.
 */
function getNetParams(): any {
  return IS_DEV || httpService.getUseTestnet() ? TestParams.get() : MainNetParams.get();
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
    const netParams = getNetParams();
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

    // Fetch UTXOs for the wallet (server expects pubkey hashes, derived from
    // the private key).
    const utxosResponse = await httpService.getOutputs(privateKeyHex);
    if (!utxosResponse.success || !utxosResponse.data) {
      return {
        success: false,
        error: i18n.t('errors.fetchUtxos'),
      };
    }

    // Select UTXOs
    const selected = selectUTXOs(utxosResponse.data, amountValue, feeValue);
    if (!selected) {
      return {
        success: false,
        error: i18n.t('errors.insufficientFunds'),
      };
    }

    // Create PQKey from private key
    const rawKey = hexToBytes(privateKeyHex);
    const pqKey = PQKey.fromPrivateKey(rawKey);

    // Create transaction
    const tx = new Transaction(netParams);

    // Convert token ID to bytes
    const tokenIdBytes = hexToBytes(tokenId);

    // Add inputs from selected UTXOs
    for (const utxo of selected.utxos) {
      const hash = Sha256Hash.wrap(hexToBytes(utxo.txhash));
      const outPoint = TransactionOutPoint.fromTransactionOutPoint4(netParams, utxo.index, Sha256Hash.ZERO_HASH, hash);

      const scriptBytes = utxo.script ? hexToBytes(utxo.script) : new Uint8Array(0);
      const input = TransactionInput.fromScriptBytes(netParams, tx, scriptBytes);
      tx.addInput(input);
    }

    // Add output to recipient
    const toAddr = Address.fromBase58(netParams, toAddress);
    const recipientCoin = new Coin(amountValue, tokenIdBytes);
    const recipientScript = ScriptBuilder.createOutputScript(toAddr);
    const recipientOutput = new TransactionOutput(netParams, tx, recipientCoin, recipientScript.getProgram());
    tx.addOutput(recipientOutput);

    // Add change output if needed
    if (selected.change > BigInt(0)) {
      const fromAddr = Address.fromBase58(netParams, fromAddress);
      const changeCoin = new Coin(selected.change, tokenIdBytes);
      const changeScript = ScriptBuilder.createOutputScript(fromAddr);
      const changeOutput = new TransactionOutput(netParams, tx, changeCoin, changeScript.getProgram());
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

      const signatureBundle = await pqKey.signWithAesKey(sigHashBytes, null);
      const scriptSig = ScriptBuilder.createInputScript(signatureBundle, pqKey);
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
      error: error instanceof Error ? error.message : i18n.t('errors.createTx'),
    };
  }
}

/**
 * Broadcast a signed transaction to the network.
 *
 * The L0 server exposes the raw serialized transaction via the
 * `submitTransaction` endpoint (matching the bigtangle-ts Wallet SDK), so we
 * POST the raw bytes instead of a JSON wrapper.
 */
export async function broadcastTransaction(rawTx: string): Promise<ApiResponse<string>> {
  try {
    const serverUrl = httpService.getServerUrl();
    const url = `${serverUrl}${ReqCmd.SubmitTransaction}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: hexToBytes(rawTx) as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.error || (result.errorcode !== undefined && result.errorcode !== 0)) {
      return {
        success: false,
        error: result.message || result.error || i18n.t('errors.txRejected'),
      };
    }

    return {
      success: true,
      data: i18n.t('errors.txBroadcast'),
    };
  } catch (error) {
    console.error('[Transaction] Error broadcasting:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : i18n.t('errors.broadcast'),
    };
  }
}

/**
 * Broadcast a peg-in transaction to the L0 `processPegIn` endpoint (raw bytes,
 * same shape as `submitTransaction`).
 */
export async function broadcastPegIn(rawTx: string): Promise<ApiResponse<string>> {
  try {
    const serverUrl = httpService.getServerUrl();
    const url = `${serverUrl}${ReqCmd.ProcessPegIn}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      body: hexToBytes(rawTx) as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    if (result.error || (result.errorcode !== undefined && result.errorcode !== 0)) {
      return {
        success: false,
        error: result.message || result.error || 'Peg-in rejected',
      };
    }

    return {
      success: true,
      data: 'Peg-in submitted',
    };
  } catch (error) {
    console.error('[Transaction] Error submitting peg-in:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : i18n.t('errors.pegInFail'),
    };
  }
}

/**
 * Pay a token transfer on Layer 0.
 *
 * Builds and signs the transaction with the SDK crypto primitives (no SDK
 * Wallet HTTP layer — that uses Node's `http.Agent`/`jackson-js`, neither of
 * which works in the web bundle). UTXOs come from the app's own fetch-based
 * httpService (the server returns the Java UTXO JSON shape), and the raw tx is
 * broadcast via the app's fetch-based `broadcastTransaction`.
 */
export async function payOnLayer0(params: {
  privateKeyHex: string;
  toAddress: string;
  amount: bigint;
  tokenId: string;
  memo?: string;
}): Promise<string> {
  const { privateKeyHex, toAddress, amount, tokenId, memo } = params;
  const netParams = getNetParams();

  const pqKey = PQKey.fromPrivateKey(hexToBytes(privateKeyHex));
  const tokenBytes = hexToBytes(tokenId);

  // 1. Fetch spendable UTXOs (correct pubkey-hash format).
  const utxosResponse = await httpService.getOutputs(privateKeyHex);
  if (!utxosResponse.success || !utxosResponse.data) {
    throw new Error(i18n.t('errors.fetchUtxos'));
  }

  // 2. Select confirmed UTXOs of the target token to cover amount + fee.
  const fee = BigInt(1000);
  const needed = amount + fee;
  const utxos = (utxosResponse.data as any[])
    .filter((u) => (u.tokenId || u.value?.tokenHex) === tokenId && u.confirmed !== false)
    .map((u) => SdkUTXO.fromJSONObject(u))
    .sort((a, b) => {
      const av = a.getValue().getValue();
      const bv = b.getValue().getValue();
      return av < bv ? 1 : av > bv ? -1 : 0;
    });

  let total = BigInt(0);
  const selected: any[] = [];
  for (const u of utxos) {
    selected.push(u);
    total += u.getValue().getValue();
    if (total >= needed) break;
  }
  if (total < needed) {
    throw new Error(i18n.t('errors.insufficientFunds'));
  }

  // 3. Build the transaction (addInput2 wires the correct outpoint).
  const tx = new Transaction(netParams);
  if (memo) tx.setMemo(memo);

  for (const u of selected) {
    tx.addInput2(u.getBlockHash(), new FreeStandingTransactionOutput(netParams, u));
  }

  tx.addOutputAddress(new Coin(amount, tokenBytes), Address.fromBase58(netParams, toAddress));

  const change = total - needed;
  if (change > BigInt(0)) {
    tx.addOutputAddress(new Coin(change, tokenBytes), Address.fromKey(netParams, pqKey));
  }

  // 4. Sign each input.
  const inputs = tx.getInputs();
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const connected = input.getConnectedOutput();
    const scriptBytes = connected?.getScriptBytes() ?? new Uint8Array(0);
    const sigHashBytes = tx.hashForSignatureScript(i, new Script(scriptBytes), 1 as any, false);
    const signatureBundle = await pqKey.signWithAesKey(sigHashBytes, null);
    const scriptSig = ScriptBuilder.createInputScript(signatureBundle, pqKey);
    input.setScriptSig(scriptSig!);
  }

  // 5. Broadcast the raw transaction to the L0 server.
  const txHex = bytesToHex(tx.bitcoinSerialize());
  const broadcastResult = await broadcastTransaction(txHex);
  if (!broadcastResult.success) {
    throw new Error(broadcastResult.error || i18n.t('errors.broadcast'));
  }

  return tx.getHash().toString();
}

/**
 * Bridge (peg-in) tokens from L0 to an L1 order chain.
 *
 * Ports the Java {@code PegInTool} / {@code BridgeServiceTest.createRealVault}:
 * builds a SIGNED 1-input/1-output transaction that locks a whole confirmed,
 * unspent UTXO of the token to the vault script 1:1, declares the L1
 * beneficiary (toAddressInSubtangle) and the destination chain id
 * ({@code PegInInfo{chainId}}), then POSTs the raw tx to L0
 * {@code processPegIn}. The vault script comes from the L0 {@code getBridgeInfo}
 * endpoint (single source of truth for what "the vault" is).
 */
export async function pegInToL1(params: {
  privateKeyHex: string;
  l1Address: string;
  tokenId: string;
  chainId: string;
}): Promise<string> {
  const { privateKeyHex, l1Address, tokenId, chainId } = params;
  const netParams = getNetParams();
  const pqKey = PQKey.fromPrivateKey(hexToBytes(privateKeyHex));

  const bridge = await httpService.getBridgeInfo();
  if (!bridge.success || !bridge.data) {
    throw new Error(i18n.t('errors.bridgeInfo'));
  }
  if (!bridge.data.active) {
    throw new Error(i18n.t('errors.bridgeInactive'));
  }
  const vaultScriptHex = bridge.data.vaultScriptHex;
  if (!vaultScriptHex) {
    throw new Error(i18n.t('errors.noVault'));
  }

  // 1. Fetch spendable UTXOs and pick one confirmed, unspent UTXO of the token
  //    to lock 1:1 (processPegIn requires exactly one input and one output).
  const utxosResponse = await httpService.getOutputs(privateKeyHex);
  if (!utxosResponse.success || !utxosResponse.data) {
    throw new Error(i18n.t('errors.fetchUtxos'));
  }
  const candidates = (utxosResponse.data as any[])
    .filter((u) => (u.tokenId || u.value?.tokenHex) === tokenId
      && u.confirmed !== false && !u.spent && !u.spendPending)
    .map((u) => SdkUTXO.fromJSONObject(u))
    .sort((a, b) => {
      const av = a.getValue().getValue();
      const bv = b.getValue().getValue();
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
  if (candidates.length === 0) {
    throw new Error(i18n.t('errors.noBridgeUtxo'));
  }
  const source = candidates[0];

  // 2. Build the peg-in transaction (version 2 = PQ witness data).
  const tx = new Transaction(netParams);
  tx.version = PQConstants.TX_PQ_VERSION;
  tx.setToAddressInSubtangle(Address.fromBase58(netParams, l1Address).getHash160());
  tx.setDataClassName('PegInInfo');
  tx.setData(new TextEncoder().encode(JSON.stringify({ chainId })));
  tx.addInput2(source.getBlockHash(), new FreeStandingTransactionOutput(netParams, source));
  tx.addOutputScript(source.getValue(), new Script(hexToBytes(vaultScriptHex)));

  // 3. Sign the single input with the UTXO owner's key.
  const input = tx.getInput(0);
  const connected = input.getConnectedOutput();
  const scriptBytes = connected?.getScriptBytes() ?? new Uint8Array(0);
  const sighash = tx.hashForSignatureScript(0, new Script(scriptBytes), 1 as any, false);
  const signatureBundle = await pqKey.signWithAesKey(sighash, null);
  input.setScriptSig(ScriptBuilder.createInputScript(signatureBundle, pqKey)!);

  // 4. Submit the raw transaction to processPegIn.
  const txHex = bytesToHex(tx.bitcoinSerialize());
  const broadcastResult = await broadcastPegIn(txHex);
  if (!broadcastResult.success) {
    throw new Error(broadcastResult.error || i18n.t('errors.pegInSubmit'));
  }

  return tx.getHash().toString();
}

/**
 * Pay a token transfer on an L1 (order) chain.
 *
 * Uses the bigtangle-ts SDK Wallet pointed at the given L1 server URL, so the
 * transaction is created, signed and submitted via the L1 server's
 * `submitTransaction` endpoint (the L1 server inherits it from
 * BaseDispatcherController). Returns the transaction hash on success.
 */
export async function payOnLayer1(params: {
  privateKeyHex: string;
  l1Url: string;
  toAddress: string;
  amount: bigint;
  tokenId: string;
  memo?: string;
}): Promise<string> {
  const { privateKeyHex, l1Url, toAddress, amount, tokenId, memo } = params;
  const netParams = getNetParams();

  const rawKey = hexToBytes(privateKeyHex);
  const pqKey = PQKey.fromPrivateKey(rawKey);

  const wallet = await Wallet.fromKeysURL(netParams, [pqKey], l1Url);
  wallet.setFee(false);

  const giveMoneyResult = new Map<string, bigint>();
  giveMoneyResult.set(toAddress, amount);

  const tx = await wallet.payToList(
    null,
    giveMoneyResult,
    hexToBytes(tokenId),
    memo || ''
  );
  if (!tx) {
    throw new Error(i18n.t('errors.createL1Tx'));
  }
  return tx.getHash().toString();
}

/**
 * Place a buy/sell order on an L1 (order) chain using the bigtangle-ts SDK
 * Wallet pointed at the given L1 server URL. The SDK builds the OrderOpen
 * transaction, signs it with the wallet key, and submits it to the L1 server's
 * `submitTransaction` endpoint. Returns the submitted transaction hash.
 */
export async function orderOnLayer1(params: {
  side: 'buy' | 'sell';
  privateKeyHex: string;
  l1Url: string;
  tokenId: string;
  price: bigint;
  amount: bigint;
  baseToken: string;
  decimals: number;
}): Promise<string> {
  const { side, privateKeyHex, l1Url, tokenId, price, amount, baseToken, decimals } = params;
  const netParams = getNetParams();

  const rawKey = hexToBytes(privateKeyHex);
  const pqKey = PQKey.fromPrivateKey(rawKey);

  const wallet = await Wallet.fromKeysURL(netParams, [pqKey], l1Url);
  wallet.setFee(false);

  const tx = side === 'buy'
    ? await wallet.buyOrder(null, tokenId, price, amount, null, null, baseToken, true)
    : await wallet.sellOrder(null, tokenId, price, amount, null, null, baseToken, true);

  if (!tx) {
    throw new Error(i18n.t('errors.createOrderTx'));
  }
  return tx.getHash().toString();
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
      error: createResult.error || i18n.t('errors.createTx'),
    };
  }

  // Broadcast transaction
  const broadcastResult = await broadcastTransaction(createResult.data.rawTx);
  if (!broadcastResult.success) {
    return {
      success: false,
      error: broadcastResult.error || i18n.t('errors.broadcast'),
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
