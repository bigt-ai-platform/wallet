/**
 * Prediction-market service (docs/prediction-market.md, l1-prediction-server).
 *
 * Wraps the bigtangle-ts prediction helpers against the L1-prediction chain:
 * listing contract tokens (the events), reading positions, and submitting the
 * contract events (create/split/merge/resolve/dispute/redeem). Trading the
 * YES/collateral and NO/collateral pairs reuses the normal L1 order flow
 * (`orderOnLayer1`) once the prediction chain is selected.
 */

import {
  Wallet,
  Token,
  TokenKeyValues,
  TokenType,
  MultiSignAddress,
  MemoInfo,
  Utils,
  PQKey,
  ECKey,
  TestParams,
  MainNetParams,
  NetworkParameters,
  Transaction,
  PredictionAction,
  PredictionMarketConfig,
  PredictionMarketOrders,
  type BookLevel,
} from 'bigtangle-ts';
import { httpService } from './http';
import { orderOnLayer1 } from './transaction';
import { parseTokenAmount } from '@/lib/tokenformat';
import { IS_DEV } from '@/constants/app';

export const PREDICTION_CHAIN_ID = 'prediction';

/** The contract classname that marks a token as a prediction market. */
export const PREDICTION_CLASSNAME = 'net.bigtangle.server.service.PredictionContract';

export type PredictionOracle = 'committee' | 'staked';
/**
 * An outcome is identified either by one of its outcome token ids
 * (multi-outcome), or by the binary shorthand `yes`/`no`, or `invalid`.
 */
export type PredictionOutcome = string;

export interface PredictionEvent {
  contractTokenid: string;
  question: string;
  /** Total share supply S (each outcome is minted to S). */
  supply: bigint;
  collateralTokenid: string;
  /** ordered winner-take-all outcome token ids (N >= 2). */
  outcomes: string[];
  /** human-readable outcome labels, aligned with `outcomes` (may be empty). */
  outcomeNames: string[];
  /** binary convenience: outcome index 0 (== outcomes[0]). */
  yesTokenid: string;
  /** binary convenience: outcome index 1 (== outcomes[1]). */
  noTokenid: string;
  resolutionTimeSec: number;
  disputeWindowSec: number;
  autoInvalidSec: number;
  disputeBond: bigint;
  committee: string[];
  /** v2 oracle mode (phase 4); committee when absent. */
  oracle: PredictionOracle;
  /** staked mode: minimum collateral bond to propose/challenge. */
  proposalBond: bigint;
  /** staked mode: token-holder vote window (seconds). */
  voteWindowSec: number;
}

export interface PredictionPosition {
  event: PredictionEvent;
  /** outcome tokenid -> the user's confirmed balance. */
  shares: Record<string, bigint>;
  /** binary convenience: shares[yesTokenid] and shares[noTokenid]. */
  yes: bigint;
  no: bigint;
  /** the largest complete set (min balance across outcomes) the user can merge/redeem. */
  redeemable: bigint;
}

function getNetParams(): any {
  return IS_DEV || httpService.getUseTestnet() ? TestParams.get() : MainNetParams.get();
}

function predictionUrl(): string {
  const chain = httpService.getL1Chains().find((c) => c.chainId === PREDICTION_CHAIN_ID);
  return chain?.url ?? httpService.getL1Url();
}

function keyFromPrivate(privateKeyHex: string, keyType?: 'PQ' | 'EC'): ECKey | PQKey {
  let hex = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) raw[i / 2] = parseInt(hex.substr(i, 2), 16);
  if (keyType === 'EC') return ECKey.fromPrivate(raw, true);
  return PQKey.fromPrivateKey(raw);
}

async function predictionWallet(privateKeyHex: string, keyType?: 'PQ' | 'EC'): Promise<Wallet> {
  const wallet = await Wallet.fromKeysURL(getNetParams(), [keyFromPrivate(privateKeyHex, keyType)], predictionUrl());
  return wallet;
}

/** Read a token's config key-values into a plain map. */
function keyValueMap(token: any): Map<string, string> {
  const map = new Map<string, string>();
  const kv = token?.tokenKeyValues?.keyvalues ?? token?.keyvalues;
  if (Array.isArray(kv)) {
    for (const entry of kv) {
      if (entry?.key != null) map.set(String(entry.key), String(entry.value ?? ''));
    }
  }
  return map;
}

/** Parse a contract token into a PredictionEvent, or null when not a market. */
export function parsePredictionEvent(token: any): PredictionEvent | null {
  if (!token?.tokenid) return null;
  const map = keyValueMap(token);
  if (map.get('classname') !== PREDICTION_CLASSNAME) return null;
  const multi = (map.get('outcomeTokenids') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const yes = map.get('yesTokenid');
  const no = map.get('noTokenid');
  const outcomes = multi.length >= 2 ? multi : yes && no ? [yes, no] : [];
  if (outcomes.length < 2) return null;
  const names = (map.get('outcomeNames') ?? '').split(',').map((s) => s.trim());
  return {
    contractTokenid: String(token.tokenid),
    question: map.get('question') ?? '',
    supply: BigInt(map.get('S') ?? '0'),
    collateralTokenid: map.get('collateralTokenid') ?? NetworkParameters.BIGTANGLE_TOKENID_STRING,
    outcomes,
    outcomeNames: names,
    yesTokenid: outcomes[0],
    noTokenid: outcomes[1],
    resolutionTimeSec: Number(map.get('resolutionTimeSec') ?? '0'),
    disputeWindowSec: Number(map.get('disputeWindowSec') ?? '0'),
    autoInvalidSec: Number(map.get('autoInvalidSec') ?? '0'),
    disputeBond: BigInt(map.get('disputeBond') ?? '0'),
    committee: (map.get('committee') ?? '').split(',').filter((s) => s.length > 0),
    oracle: (map.get('oracle') === 'staked' ? 'staked' : 'committee') as PredictionOracle,
    proposalBond: BigInt(map.get('proposalBond') ?? map.get('disputeBond') ?? '0'),
    voteWindowSec: Number(map.get('voteWindowSec') ?? map.get('disputeWindowSec') ?? '0'),
  };
}

/** Fetch one contract token by id and parse it. */
export async function getEvent(contractTokenid: string): Promise<PredictionEvent | null> {
  const res = await httpService.requestL1ByChainId<any>(PREDICTION_CHAIN_ID, 'getTokenById', 'POST', {
    tokenid: contractTokenid,
  });
  const tokens = res.success ? res.data?.tokens ?? [] : [];
  return tokens.length > 0 ? parsePredictionEvent(tokens[0]) : null;
}

/**
 * List every prediction market on the chain. The dedicated
 * `searchContractTokens` endpoint returns the contract-type tokens; the ones
 * carrying the prediction classname are the markets.
 */
export async function listEvents(): Promise<PredictionEvent[]> {
  const res = await httpService.requestL1ByChainId<any>(PREDICTION_CHAIN_ID, 'searchContractTokens', 'POST', {});
  const tokens: any[] = res.success ? res.data?.tokens ?? [] : [];
  const events: PredictionEvent[] = [];
  for (const token of tokens) {
    const parsed = parsePredictionEvent(token);
    if (parsed) events.push(parsed);
  }
  return events;
}

/** Smallest-unit balance of a row: the raw server value when present, else the de-scaled display string. */
function balanceUnits(item: { raw?: string; confirmedBalance?: string; balance?: string; decimals?: number }): bigint {
  if (item.raw) return BigInt(item.raw);
  return parseTokenAmount(item.confirmedBalance || item.balance || '0', item.decimals ?? 0);
}

/** Read the user's per-outcome balances for every listed event. */
export async function getPositions(privateKeyHex: string, keyType?: 'PQ' | 'EC'): Promise<PredictionPosition[]> {
  const events = await listEvents();
  const balances = await httpService.getBalancesOn(predictionUrl(), privateKeyHex, keyType);
  const byToken = new Map<string, bigint>();
  if (balances.success && balances.data) {
    for (const item of balances.data) byToken.set(item.tokenid, balanceUnits(item));
  }
  return events.map((event) => {
    const shares: Record<string, bigint> = {};
    let redeemable: bigint | null = null;
    for (const outcome of event.outcomes) {
      const bal = byToken.get(outcome) ?? 0n;
      shares[outcome] = bal;
      redeemable = redeemable === null || bal < redeemable ? bal : redeemable;
    }
    return {
      event,
      shares,
      yes: shares[event.yesTokenid] ?? 0n,
      no: shares[event.noTokenid] ?? 0n,
      redeemable: redeemable ?? 0n,
    };
  });
}

// --- contract-event transactions -------------------------------------------

/**
 * Submit the domain (root-signer) multi-signature for a freshly created token
 * block. On the prediction chain a token block is not solid until the chain's
 * domain key signs it (`ServiceBaseCheck.checkFullTokenSolidity` throws
 * `MissingSignatureException` otherwise), so unlike a plain L0 token creation
 * this step is mandatory. Retries because the block's pending signature may not
 * be queryable immediately after `createToken`.
 */
async function multiSignCreatedToken(
  wallet: Wallet,
  tokenid: string,
  domainKey: PQKey,
  attempts = 10,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const signed = await wallet.multiSign(tokenid, domainKey, null);
    if (signed) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`prediction: token ${tokenid.slice(0, 12)}… never accepted the domain multisign`);
}

/** Poll until the wallet holds at least `amount` confirmed of every tokenid. */
async function waitForOutcomeSupply(
  wallet: Wallet,
  tokenids: string[],
  amount: bigint,
  attempts = 90,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const candidates = await wallet.calculateAllSpendCandidates(null, false);
    const ready = tokenids.every((tokenid) =>
      candidates.some((candidate: any) => {
        const utxo = candidate?.getUTXO?.();
        return utxo && utxo.getTokenId() === tokenid && utxo.getValue().getValue() >= amount;
      }),
    );
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('prediction: minted outcome supply never confirmed');
}

export async function splitShares(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  contractTokenid: string;
  collateralTokenid: string;
  amount: bigint;
}): Promise<string> {
  const { privateKeyHex, keyType, contractTokenid, collateralTokenid, amount } = params;
  const wallet = await predictionWallet(privateKeyHex, keyType);
  const burns = new Map<string, bigint>();
  burns.set(collateralTokenid, amount);
  const tx = await wallet.payContractMulti(null, burns, collateralTokenid, amount, null, null,
    contractTokenid, PredictionAction.split());
  return tx.getHash().toString();
}

export async function mergeShares(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  amount: bigint;
}): Promise<string> {
  const { privateKeyHex, keyType, event, amount } = params;
  const wallet = await predictionWallet(privateKeyHex, keyType);
  // a merge burns `amount` of EVERY outcome (a complete set) -> `amount` collateral
  const burns = new Map<string, bigint>();
  for (const outcome of event.outcomes) burns.set(outcome, amount);
  const tx = await wallet.payContractMulti(null, burns, event.outcomes[0], amount, null, null,
    event.contractTokenid, PredictionAction.merge());
  return tx.getHash().toString();
}

export async function resolveEvent(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  /** an outcome token id, or the binary shorthand `yes`/`no`/`invalid`. */
  outcome: PredictionOutcome;
  /** staked mode: collateral bond to burn (>= proposalBond). */
  bond?: bigint;
}): Promise<string> {
  const { privateKeyHex, keyType, event, outcome, bond } = params;
  const wallet = await predictionWallet(privateKeyHex, keyType);
  const burn = bond ?? 0n;
  let tx: Transaction;
  if (burn > 0n) {
    const burns = new Map<string, bigint>([[event.collateralTokenid, burn]]);
    tx = await wallet.payContractMulti(null, burns, event.collateralTokenid, burn, null, null,
      event.contractTokenid, PredictionAction.resolve(outcome));
  } else {
    // committee vote: no bond, only the recorded outcome matters
    tx = await wallet.payContract(null, event.collateralTokenid, 0n, null, null,
      event.contractTokenid, PredictionAction.resolve(outcome));
  }
  return tx.getHash().toString();
}

export async function disputeEvent(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  outcome: PredictionOutcome;
  /** staked mode: challenge bond to burn (>= proposalBond). */
  bond?: bigint;
}): Promise<string> {
  const { privateKeyHex, keyType, event, outcome, bond } = params;
  const wallet = await predictionWallet(privateKeyHex, keyType);
  const burn = bond ?? 0n;
  let tx: Transaction;
  if (burn > 0n) {
    const burns = new Map<string, bigint>([[event.collateralTokenid, burn]]);
    tx = await wallet.payContractMulti(null, burns, event.collateralTokenid, burn, null, null,
      event.contractTokenid, PredictionAction.dispute(outcome));
  } else {
    tx = await wallet.payContract(null, event.collateralTokenid, 0n, null, null,
      event.contractTokenid, PredictionAction.dispute(outcome));
  }
  return tx.getHash().toString();
}

/** staked mode: bond collateral backing the given outcome during the vote. */
export async function voteEvent(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  outcome: PredictionOutcome;
  bond: bigint;
}): Promise<string> {
  const { privateKeyHex, keyType, event, outcome, bond } = params;
  const wallet = await predictionWallet(privateKeyHex, keyType);
  const burns = new Map<string, bigint>([[event.collateralTokenid, bond]]);
  const tx = await wallet.payContractMulti(null, burns, event.collateralTokenid, bond, null, null,
    event.contractTokenid, PredictionAction.vote(outcome));
  return tx.getHash().toString();
}

/**
 * Redeem outcome shares against the vault once the market is FINAL. The engine
 * pays `min` complete sets for `invalid` (burn one of every outcome) and 1:1 for
 * a directional win (burn the winning outcome). `shares` is the per-outcome
 * amount the holder is redeeming; only positive entries are burned.
 */
export async function redeemShares(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  shares: Record<string, bigint>;
}): Promise<string> {
  const { privateKeyHex, keyType, event, shares } = params;
  const wallet = await predictionWallet(privateKeyHex, keyType);
  const burns = new Map<string, bigint>();
  let representative = 0n;
  let representativeToken = event.outcomes[0];
  for (const outcome of event.outcomes) {
    const amount = shares[outcome] ?? 0n;
    if (amount > 0n) {
      burns.set(outcome, amount);
      if (amount > representative) {
        representative = amount;
        representativeToken = outcome;
      }
    }
  }
  if (burns.size === 0) throw new Error('redeemShares: no positive share amounts to redeem');
  const tx = await wallet.payContractMulti(null, burns, representativeToken, representative, null, null,
    event.contractTokenid, PredictionAction.redeem());
  return tx.getHash().toString();
}

/**
 * One-tap market order on an outcome token: fetch the L1 order book for the
 * outcome/collateral pair, plan the crossing limit price
 * (`PredictionMarketOrders`), and submit a limit order at that price through the
 * normal L1 flow (`orderOnLayer1`). No scaling is applied — the book's raw long
 * price is fed straight back to the order API. `limitPrice` optionally caps
 * slippage. Returns the tx hash and the planned fill.
 */
export async function marketOrderOutcome(params: {
  side: 'buy' | 'sell';
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  outcomeTokenid: string;
  amount: bigint;
  /** optional slippage cap in raw book units. */
  limitPrice?: bigint;
}): Promise<{ txHash: string; price: bigint; filled: bigint; complete: boolean }> {
  const { side, privateKeyHex, keyType, event, outcomeTokenid, amount, limitPrice } = params;
  const { asks, bids } = await fetchOutcomeBook(outcomeTokenid);
  const plan = side === 'buy'
    ? PredictionMarketOrders.planBuy(asks, amount)
    : PredictionMarketOrders.planSell(bids, amount);
  if (plan.price <= 0n || plan.filled <= 0n) {
    throw new Error(`prediction market: no liquidity for ${outcomeTokenid}`);
  }
  if (limitPrice !== undefined) {
    if (side === 'buy' && plan.price > limitPrice) throw new Error('prediction market: price moved above your limit');
    if (side === 'sell' && plan.price < limitPrice) throw new Error('prediction market: price moved below your limit');
  }
  const txHash = await orderOnLayer1({
    side,
    privateKeyHex,
    keyType,
    l1Url: predictionUrl(),
    tokenId: outcomeTokenid,
    price: plan.price,
    amount: plan.filled,
    baseToken: event.collateralTokenid,
    decimals: 0,
  });
  return { txHash, price: plan.price, filled: plan.filled, complete: plan.complete };
}

/** Split the prediction-chain order book for an outcome into ask/bid ladders. */
async function fetchOutcomeBook(outcomeTokenid: string): Promise<{ asks: BookLevel[]; bids: BookLevel[] }> {
  const res = await httpService.requestL1ByChainId<any>(PREDICTION_CHAIN_ID, 'getOrders', 'POST', {
    tokenid: outcomeTokenid,
  });
  const orders: any[] = res.success ? res.data?.allOrdersSorted ?? res.data?.orders ?? [] : [];
  const asks: BookLevel[] = [];
  const bids: BookLevel[] = [];
  for (const o of orders) {
    const price = BigInt(o.price ?? 0);
    if (price <= 0n) continue;
    const side = String(o.side ?? '').toUpperCase();
    const offersOutcome = o.offerTokenid === outcomeTokenid;
    const wantsOutcome = o.targetTokenid === outcomeTokenid;
    const isSell = side === 'SELL' || (side !== 'BUY' && offersOutcome);
    if (isSell && offersOutcome) {
      asks.push({ price, amount: BigInt(o.offerValue ?? 0) });
    } else if (!isSell && wantsOutcome) {
      bids.push({ price, amount: BigInt(o.targetValue ?? 0) });
    }
  }
  return { asks, bids };
}

/**
 * Create a new prediction market: mint fixed-supply share tokens to the issuer,
 * create the contract token (config key-values), then submit the `create` event
 * that escrows the full share supply of every outcome into the vault. The issuer
 * must hold BC for fees and be permitted to sign the domain (multisign).
 *
 * `outcomeNames` selects the number of outcomes (default binary YES/NO); the
 * first two are also exposed as the legacy `yesTokenid`/`noTokenid`.
 */
export async function createEvent(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  question: string;
  supply: bigint;
  collateralTokenid: string;
  resolutionTimeSec: number;
  disputeWindowSec: number;
  autoInvalidSec: number;
  disputeBond: bigint;
  committeeAddresses: string[];
  /** default: ['YES','NO']; N >= 2 winner-take-all outcomes. */
  outcomeNames?: string[];
  /** default: 'staked' when committeeAddresses is empty (phase 4). */
  oracle?: PredictionOracle;
  proposalBond?: bigint;
  voteWindowSec?: number;
}): Promise<{ contractTokenid: string; outcomes: string[]; yesTokenid: string; noTokenid: string }> {
  const {
    privateKeyHex, keyType, question, supply, collateralTokenid,
    resolutionTimeSec, disputeWindowSec, autoInvalidSec, disputeBond,
    committeeAddresses, outcomeNames, oracle, proposalBond, voteWindowSec,
  } = params;

  const names = outcomeNames && outcomeNames.length >= 2 ? outcomeNames : ['YES', 'NO'];
  const issuer = keyFromPrivate(privateKeyHex, keyType) as PQKey;
  const wallet = await predictionWallet(privateKeyHex, keyType);

  const outcomeKeys: PQKey[] = [];
  const outcomes: string[] = [];
  for (let i = 0; i < names.length; i++) {
    const key = PQKey.createNew();
    outcomeKeys.push(key);
    outcomes.push(key.getPublicKeyAsHex());
  }
  const contractKey = PQKey.createNew();
  const contractTokenid = contractKey.getPublicKeyAsHex();

  for (const key of outcomeKeys) wallet.importKey(key);
  wallet.importKey(contractKey);

  const mintShare = async (key: PQKey, tokenid: string, name: string) => {
    const token = new Token();
    token.setTokenid(tokenid);
    token.setTokenname(name);
    token.setDescription(question);
    token.setDecimals(0);
    token.setAmount(supply);
    token.setTokenstop(true);
    token.setTokentype(TokenType.token);
    // The token's own key signs the create; the domain (issuer) key then
    // multi-signs it — signing with `issuer` while declaring `key` as the
    // token's multi-sign address desyncs the signature check.
    await wallet.createToken(key, '', false, token,
      [new MultiSignAddress(tokenid, '', Utils.HEX.encode(key.getPrefixedPublicKeyBytes()))],
      key.getPubKey(), new MemoInfo('coinbase'));
    await multiSignCreatedToken(wallet, tokenid, issuer);
  };
  for (let i = 0; i < outcomes.length; i++) await mintShare(outcomeKeys[i], outcomes[i], names[i]);

  const keyValues: TokenKeyValues = PredictionMarketConfig.keyValues({
    supply,
    collateralTokenid,
    outcomeTokenids: outcomes,
    question,
    resolutionTimeSec,
    disputeWindowSec,
    autoInvalidSec,
    disputeBond,
    committeeAddresses,
    oracle,
    proposalBond,
    voteWindowSec,
  });
  const contractToken = new Token();
  contractToken.setTokenid(contractTokenid);
  contractToken.setTokenname('PREDICT');
  contractToken.setDescription(question);
  contractToken.setDecimals(0);
  contractToken.setAmount(0n);
  contractToken.setTokenstop(true);
  contractToken.setTokentype(TokenType.contract);
  contractToken.setTokenKeyValues(keyValues);
  await wallet.createToken(contractKey, '', false, contractToken,
    [new MultiSignAddress(contractTokenid, '', Utils.HEX.encode(contractKey.getPrefixedPublicKeyBytes()))],
    contractKey.getPubKey(), new MemoInfo('coinbase'));
  await multiSignCreatedToken(wallet, contractTokenid, issuer);

  // Escrow the full share supply of every outcome (create). The wallet key that
  // holds the shares is the beneficiary recorded on the event.
  const createBurns = new Map<string, bigint>();
  for (const outcome of outcomes) createBurns.set(outcome, supply);
  const w = await Wallet.fromKeysURL(getNetParams(), [...outcomeKeys, contractKey, issuer], predictionUrl());
  for (const key of outcomeKeys) w.importKey(key);
  w.importKey(contractKey);
  w.importKey(issuer);
  // The minted outcome blocks must confirm before the create can spend them,
  // else payContractMulti throws InsufficientMoneyException.
  await waitForOutcomeSupply(w, outcomes, supply);
  await w.payContractMulti(null, createBurns, outcomes[0], supply, null, null,
    contractTokenid, PredictionAction.create());

  return { contractTokenid, outcomes, yesTokenid: outcomes[0], noTokenid: outcomes[1] };
}

export const predictionService = {
  PREDICTION_CHAIN_ID,
  PREDICTION_CLASSNAME,
  predictionUrl,
  parsePredictionEvent,
  getEvent,
  listEvents,
  getPositions,
  createEvent,
  splitShares,
  mergeShares,
  resolveEvent,
  disputeEvent,
  voteEvent,
  redeemShares,
  marketOrderOutcome,
};
