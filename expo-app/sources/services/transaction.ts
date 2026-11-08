/**
 * Transaction Service for Bigtangle
 *
 * Handles transaction creation, signing, and broadcasting
 */

import { PQKey, ECKey, TestParams, MainNetParams, NetworkParameters, Utils, Address, Coin, Sha256Hash, Script, ScriptBuilder, Wallet, UTXO as SdkUTXO, FreeStandingTransactionOutput, PQConstants } from 'bigtangle-ts';
import i18n from '../lib/i18n';
// @ts-ignore
import { Transaction } from 'bigtangle-ts/dist/net/bigtangle/core/Transaction';
// @ts-ignore
import { TransactionInput } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionInput';
// @ts-ignore
import { TransactionOutput } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionOutput';
// @ts-ignore
import { TransactionOutPoint } from 'bigtangle-ts/dist/net/bigtangle/core/TransactionOutPoint';
// @ts-ignore
import { WalletUtil } from 'bigtangle-ts/dist/net/bigtangle/utils/WalletUtil';
import { httpService } from './http';
import { postBinary } from './binaryPost';
import { IS_DEV } from '@/constants/app';
import { withSlash } from 'chain-discovery';
import { rememberPeer } from '@/services/discovery';
import { ReqCmd } from '@/types/api';
import type { UTXO, ApiResponse } from '@/types/api';

/**
 * POST raw transaction bytes to a role endpoint, failing over across the
 * discovered L0 candidates. Returns the decoded response or a transport error.
 */
async function postRaw(endpoint: string, rawTx: string): Promise<{ response?: any; error?: string }> {
  let error = 'Unknown error';
  for (const base of httpService.l0Bases()) {
    try {
      // postBinary (not fetch): the Capacitor bridge corrupts binary bodies
      // before they reach the native layer — see services/binaryPost.ts.
      const res = await postBinary(`${withSlash(base)}${endpoint}`, hexToBytes(rawTx));
      if (res.status < 200 || res.status >= 300) {
        error = `HTTP ${res.status}`;
        httpService.reportDown('l0', base);
        continue;
      }
      rememberPeer('l0', base);
      const text = new TextDecoder().decode(res.data);
      return { response: text ? JSON.parse(text) : {} };
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error';
      httpService.reportDown('l0', base);
    }
  }
  return { error };
}

/**
 * Transaction creation parameters
 */
export interface SendTransactionParams {
  fromAddress: string;
  toAddress: string;
  amount: string;
  tokenId: string;
  privateKeyHex: string;
  /** Key algorithm of privateKeyHex: legacy EC (old .wallet import) or PQ (default). */
  keyType?: 'PQ' | 'EC';
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
 * Rebuild the signing key from the private key hex. Legacy EC (secp256k1)
 * wallets imported from an old .wallet file must use an ECKey — a PQKey built
 * from those bytes throws (truncated ML-DSA key) and would sign for the wrong
 * address anyway.
 */
function keyFromPrivateKey(privateKeyHex: string, keyType?: 'PQ' | 'EC'): ECKey | PQKey {
  const raw = hexToBytes(privateKeyHex);
  if (keyType === 'EC') {
    return ECKey.fromPrivate(raw, true);
  }
  return PQKey.fromPrivateKey(raw);
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
      keyType,
      memo,
      fee = '1000', // Default fee: 1000 satoshis
    } = params;

    // Convert amounts to BigInt
    const amountValue = BigInt(amount);
    const feeValue = BigInt(fee);

    // Fetch UTXOs for the wallet (server expects pubkey hashes, derived from
    // the private key).
    const utxosResponse = await httpService.getOutputs(privateKeyHex, keyType);
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

    // Create the signing key (EC for legacy wallets, PQ otherwise)
    const signKey = keyFromPrivateKey(privateKeyHex, keyType);

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

      const signatureBundle = await signKey.signWithAesKey(sigHashBytes, null);
      const scriptSig = ScriptBuilder.createInputScript(signatureBundle, signKey);
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
    const { response, error } = await postRaw(ReqCmd.SubmitTransaction, rawTx);
    if (!response) {
      return { success: false, error: error || i18n.t('errors.broadcast') };
    }
    if (response.error || (response.errorcode !== undefined && response.errorcode !== 0)) {
      return {
        success: false,
        error: response.message || response.error || i18n.t('errors.txRejected'),
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
    const { response, error } = await postRaw(ReqCmd.ProcessPegIn, rawTx);
    if (!response) {
      return { success: false, error: error || i18n.t('errors.pegInFail') };
    }
    if (response.error || (response.errorcode !== undefined && response.errorcode !== 0)) {
      return {
        success: false,
        error: response.message || response.error || 'Peg-in rejected',
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

/** Sign every input of a locally built transfer with the wallet key. */
/** One key that can sign Bigtangle inputs (multi-key wallets pass several). */
export interface SigningKey {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
}

function keyId(key: SigningKey): string {
  return `${key.keyType ?? 'PQ'}:${key.privateKeyHex.toLowerCase()}`;
}

/** UTXOs of every key, each tagged with the key that owns it. */
async function fetchTaggedOutputs(
  keys: SigningKey[]
): Promise<Array<{ row: any; key: SigningKey }>> {
  const out: Array<{ row: any; key: SigningKey }> = [];
  for (const key of keys) {
    const res = await httpService.getOutputs(key.privateKeyHex, key.keyType);
    if (res.success && res.data) {
      for (const row of res.data as any[]) out.push({ row, key });
    }
  }
  return out;
}

/** Signs every input with the key that owns it (one owner per input). */
async function signInputsWithOwners(
  tx: any,
  owners: Array<ECKey | PQKey>
): Promise<void> {
  const inputs = tx.getInputs();
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const owner = owners[i];
    if (!owner) throw new Error(i18n.t('errors.createTx'));
    const connected = input.getConnectedOutput();
    const scriptBytes = connected?.getScriptBytes() ?? new Uint8Array(0);
    const sigHashBytes = tx.hashForSignatureScript(i, new Script(scriptBytes), 1 as any, false);
    const signatureBundle = await owner.signWithAesKey(sigHashBytes, null);
    const scriptSig = ScriptBuilder.createInputScript(signatureBundle, owner);
    input.setScriptSig(scriptSig!);
  }
}

/** Sign every input with the same key (single-key paths). */
async function signLocalInputs(tx: any, signKey: ECKey | PQKey): Promise<void> {
  const owners = tx.getInputs().map(() => signKey);
  await signInputsWithOwners(tx, owners);
}

/**
 * The BIG network fee for a **non-BIG** L0 transfer (Java
 * `Wallet.payToList` → `feeTransaction`): a separate transaction spends
 * unspent BIG, burns `Coin.FEE_DEFAULT` and returns the change to the wallet.
 * The BIG fee is paid no matter which token is transferred; a BIG transfer
 * instead subtracts it from its own change.
 *
 * Multi-key: BIG may sit on the legacy EC key while the sender wallet's primary
 * key is PQ, so it selects across every key and signs each input with its owner.
 * Change returns to the key that owned the first selected BIG input.
 */
async function submitBigFee(params: {
  netParams: NetworkParameters;
  tagged: Array<{ row: any; key: SigningKey }>;
}): Promise<string> {
  const { netParams, tagged } = params;
  const bigId = NetworkParameters.BIGTANGLE_TOKENID_STRING;
  const fee = Coin.FEE_DEFAULT.getValue();
  const candidates = tagged
    .filter(({ row }) => (row.tokenId || row.tokenHex || row.value?.tokenHex) === bigId && row.confirmed !== false)
    .map(({ row, key }) => ({ utxo: SdkUTXO.fromJSONObject(row), key }))
    .sort((a, b) => {
      const av = a.utxo.getValue().getValue();
      const bv = b.utxo.getValue().getValue();
      return av < bv ? 1 : av > bv ? -1 : 0;
    });

  let total = BigInt(0);
  const selected: Array<{ utxo: any; key: SigningKey }> = [];
  for (const candidate of candidates) {
    selected.push(candidate);
    total += candidate.utxo.getValue().getValue();
    if (total >= fee) break;
  }
  if (total < fee) {
    throw new Error(i18n.t('errors.insufficientBIGFee'));
  }

  const tx = new Transaction(netParams);
  tx.setMemo('fee');
  for (const { utxo } of selected) {
    tx.addInput2(utxo.getBlockHash(), new FreeStandingTransactionOutput(netParams, utxo));
  }
  const change = total - fee;
  const ownerKey = keyFromPrivateKey(selected[0].key.privateKeyHex, selected[0].key.keyType);
  // Java `Wallet.feeTransaction` always writes the change output (even zero):
  // it also makes the BIG output map carry the fee so the block check sees it.
  tx.addOutputAddress(new Coin(change, hexToBytes(bigId)), Address.fromKey(netParams, ownerKey));
  await signInputsWithOwners(
    tx,
    selected.map(({ key }) => keyFromPrivateKey(key.privateKeyHex, key.keyType))
  );

  const result = await broadcastTransaction(bytesToHex(tx.bitcoinSerialize()));
  if (!result.success) {
    throw new Error(result.error || i18n.t('errors.broadcast'));
  }
  return tx.getHash().toString();
}

/**
 * Pay a token transfer on Layer 0.
 *
 * The chain fee is always 1000 raw **BIG** (`Coin.FEE_DEFAULT`): a BIG transfer
 * pays it from the same inputs (`amount + fee`, recipient gets `amount`); any
 * other token's transfer is fee-free itself and pays the BIG fee in a separate
 * BIG transaction (Java `Wallet.payToList` → `feeTransaction`). This port used
 * to add 1000 raw of the *transferred* token instead, which neither paid the
 * BIG fee nor matched the node's fee rule.
 *
 * Multi-key: `keys` lets a dual-key wallet spend UTXOs of every key (e.g. an
 * old EC address that still holds BIG, plus the new PQ key). Each input is
 * signed with its owner and change returns to the first selected input's owner.
 */
export async function payOnLayer0(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  toAddress: string;
  amount: bigint;
  tokenId: string;
  memo?: string;
  /** Every key of the wallet; defaults to the single key above. */
  keys?: SigningKey[];
}): Promise<string> {
  const { privateKeyHex, keyType, toAddress, amount, tokenId, memo } = params;
  const netParams = getNetParams();

  const keys = params.keys?.length ? params.keys : [{ privateKeyHex, keyType }];
  const signers = new Map(keys.map((k) => [keyId(k), keyFromPrivateKey(k.privateKeyHex, k.keyType)]));
  const tokenBytes = hexToBytes(tokenId);
  const isBig = tokenId.trim().toLowerCase() === NetworkParameters.BIGTANGLE_TOKENID_STRING;

  // 1. Fetch spendable UTXOs of every key (correct pubkey-hash format).
  const tagged = await fetchTaggedOutputs(keys);
  if (tagged.length === 0) {
    throw new Error(i18n.t('errors.insufficientFunds'));
  }

  // 2. Select confirmed UTXOs of the target token to cover amount + fee.
  // Only a BIG spend carries the fee in the same token; other tokens are
  // transferred in full and the BIG fee is a separate transaction below.
  const fee = isBig ? Coin.FEE_DEFAULT.getValue() : BigInt(0);
  const needed = amount + fee;
  const candidates = tagged
    .filter(({ row }) => (row.tokenId || row.value?.tokenHex) === tokenId && row.confirmed !== false)
    .map(({ row, key }) => ({ utxo: SdkUTXO.fromJSONObject(row), key }))
    .sort((a, b) => {
      const av = a.utxo.getValue().getValue();
      const bv = b.utxo.getValue().getValue();
      return av < bv ? 1 : av > bv ? -1 : 0;
    });

  let total = BigInt(0);
  const selected: Array<{ utxo: any; key: SigningKey }> = [];
  for (const candidate of candidates) {
    selected.push(candidate);
    total += candidate.utxo.getValue().getValue();
    if (total >= needed) break;
  }
  if (total < needed) {
    throw new Error(i18n.t('errors.insufficientFunds'));
  }

  // 3. Build the transaction (addInput2 wires the correct outpoint).
  const tx = new Transaction(netParams);
  if (memo) tx.setMemo(memo);

  for (const { utxo } of selected) {
    tx.addInput2(utxo.getBlockHash(), new FreeStandingTransactionOutput(netParams, utxo));
  }

  tx.addOutputAddress(new Coin(amount, tokenBytes), Address.fromBase58(netParams, toAddress));

  const change = total - needed;
  const owners = selected.map(({ key }) => signers.get(keyId(key))!);
  if (change > BigInt(0)) {
    tx.addOutputAddress(new Coin(change, tokenBytes), Address.fromKey(netParams, owners[0]));
  }

  // 4. Sign each input with its owner.
  await signInputsWithOwners(tx, owners);

  // 5. Broadcast the raw transaction to the L0 server.
  const txHex = bytesToHex(tx.bitcoinSerialize());
  const broadcastResult = await broadcastTransaction(txHex);
  if (!broadcastResult.success) {
    throw new Error(broadcastResult.error || i18n.t('errors.broadcast'));
  }

  // 6. A non-BIG transfer still owes the BIG fee: submit it as its own tx.
  if (!isBig) {
    await submitBigFee({ netParams, tagged });
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
  keyType?: 'PQ' | 'EC';
  l1Address: string;
  tokenId: string;
  chainId: string;
}): Promise<string> {
  const { privateKeyHex, keyType, l1Address, tokenId, chainId } = params;
  const netParams = getNetParams();
  const signKey = keyFromPrivateKey(privateKeyHex, keyType);

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
  const utxosResponse = await httpService.getOutputs(privateKeyHex, keyType);
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
  const signatureBundle = await signKey.signWithAesKey(sighash, null);
  input.setScriptSig(ScriptBuilder.createInputScript(signatureBundle, signKey)!);

  // 4. Submit the raw transaction to processPegIn.
  const txHex = bytesToHex(tx.bitcoinSerialize());
  const broadcastResult = await broadcastPegIn(txHex);
  if (!broadcastResult.success) {
    throw new Error(broadcastResult.error || i18n.t('errors.pegInSubmit'));
  }

  return tx.getHash().toString();
}

function tokenIdsEqual(a: Uint8Array | string | undefined, b: Uint8Array): boolean {
  if (a === undefined) return false;
  const A = typeof a === 'string' ? Utils.HEX.decode(a) : a;
  return A.length === b.length && A.every((v, i) => v === b[i]);
}

/**
 * Anchor a signed `social.*` record on L1-SOCIAL from the wallet's own key —
 * the app-side port of services/p2p-engine `submitSocialRecord`. The record
 * rides in the tx's typed data (`dataclassname="SocialRecord"`); the tx is
 * funded with BIG inputs + zero-value self change (L1-SOCIAL is fee-free),
 * signed, and submitted to the social node's `submitTransaction`. Returns the
 * tx hash the engine confirms (`POST /orders` `verifyTx`).
 *
 * Throws when the wallet holds no BIG output on L1-SOCIAL — the seller must
 * peg in ≥1 BIG first (docs/p2p.md §11).
 */
export async function anchorSocialRecord(params: {
  key: PQKey;
  l1Url: string;
  record: unknown;
}): Promise<string> {
  const { key, l1Url, record } = params;
  const netParams = getNetParams();
  const url = l1Url.endsWith('/') ? l1Url : l1Url + '/';
  const wallet = await Wallet.fromKeysURL(netParams, [key], url);
  wallet.setFee(false);

  const coinList = await wallet.calculateAllSpendCandidates(null, false);
  const tx = new Transaction(netParams);
  tx.setData(new TextEncoder().encode(JSON.stringify(record)));
  tx.setDataClassName('SocialRecord');

  const BIG = NetworkParameters.getBIGTANGLE_TOKENID();
  let beneficiary: unknown = null;
  let amount = Coin.valueOf(0n, BIG).negate();
  for (const spendable of coinList) {
    const utxo = spendable.getUTXO();
    if (!utxo || !tokenIdsEqual(utxo.getValue().getTokenid(), BIG)) continue;
    beneficiary = await (wallet as unknown as { getECKey(a: unknown, b: unknown): Promise<unknown> }).getECKey(
      null,
      utxo.getAddress(),
    );
    amount = amount.add(utxo.getValue());
    tx.addInput2(utxo.getBlockHash(), spendable);
    if (!amount.isNegative()) {
      if (amount.isPositive()) tx.addOutputEckey(amount, beneficiary as never);
      break;
    }
  }
  if (beneficiary == null || amount.isNegative()) {
    throw new Error('anchorSocialRecord: no BIG output on L1-SOCIAL (peg in ≥1 BIG first)');
  }
  await (wallet as unknown as { signTransaction(t: Transaction, a: unknown, m: string): Promise<void> }).signTransaction(
    tx,
    null,
    'THROW',
  );
  await (wallet as unknown as { submitTransaction(t: Transaction): Promise<void> }).submitTransaction(tx);
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
  keyType?: 'PQ' | 'EC';
  l1Url: string;
  toAddress: string;
  amount: bigint;
  tokenId: string;
  memo?: string;
}): Promise<string> {
  const { privateKeyHex, keyType, l1Url, toAddress, amount, tokenId, memo } = params;
  const netParams = getNetParams();

  const signKey = keyFromPrivateKey(privateKeyHex, keyType);

  const wallet = await Wallet.fromKeysURL(netParams, [signKey], l1Url);
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
  keyType?: 'PQ' | 'EC';
  l1Url: string;
  tokenId: string;
  price: bigint;
  amount: bigint;
  baseToken: string;
  decimals: number;
}): Promise<string> {
  const { side, privateKeyHex, keyType, l1Url, tokenId, price, amount, baseToken, decimals } = params;
  const netParams = getNetParams();

  const signKey = keyFromPrivateKey(privateKeyHex, keyType);

  const wallet = await Wallet.fromKeysURL(netParams, [signKey], l1Url);
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
 * Cancel an open order on the L1 order chain. Builds a plain-key Wallet from
 * the unlocked key (mirroring orderOnLayer1) and posts a signed
 * BLOCKTYPE_ORDER_CANCEL block for the order's block hash.
 */
export async function cancelOrderOnLayer1(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  l1Url: string;
  initialBlockHashHex: string;
  address: string;
}): Promise<void> {
  const { privateKeyHex, keyType, l1Url, initialBlockHashHex, address } = params;
  const netParams = getNetParams();
  const signKey = keyFromPrivateKey(privateKeyHex, keyType);
  const wallet = await Wallet.fromKeysURL(netParams, [signKey], l1Url);
  wallet.setFee(false);
  await WalletUtil.cancelOrder(wallet, null, initialBlockHashHex, address, l1Url);
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
