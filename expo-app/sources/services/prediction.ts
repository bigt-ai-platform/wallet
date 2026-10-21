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
import { z } from 'zod';

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

export interface PredictionState {
  initialized: boolean;
  status: 'OPEN' | 'PENDING' | 'VOTING' | 'FINAL';
  outcome: string | null;
  disputeDeadlineSec?: number;
  voteDeadlineSec?: number;
  proposalOutcome?: string | null;
  challengeOutcome?: string | null;
  proposer?: string | null;
  challenger?: string | null;
  votes?: Record<string, string>;
  voteOutcomeByVoter?: Record<string, string>;
  vaultStock?: Record<string, string>;
  vaultCollateral?: string;
}

export interface PredictionPosition {
  event: PredictionEvent;
  state: PredictionState | null;
  /** outcome tokenid -> the user's confirmed balance. */
  shares: Record<string, bigint>;
  /** binary convenience: shares[yesTokenid] and shares[noTokenid]. */
  yes: bigint;
  no: bigint;
  /** Collateral redeemable against the confirmed final outcome, or zero. */
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
  if (!res.success) throw new Error('Prediction markets are unavailable');
  const tokens: any[] = res.success ? res.data?.tokens ?? [] : [];
  const events: PredictionEvent[] = [];
  for (const token of tokens) {
    const parsed = parsePredictionEvent(token);
    if (parsed) events.push(parsed);
  }
  return events;
}

export async function getState(contractTokenid: string): Promise<PredictionState | null> {
  const res = await httpService.requestL1ByChainId<any>(PREDICTION_CHAIN_ID, 'getPredictionState', 'POST', {
    contractTokenid,
  });
  const data = res.data;
  if (!res.success || data?.contractTokenid !== contractTokenid) {
    throw new Error('prediction: confirmed market state is unavailable');
  }
  if (data.confirmed === false && data.state === null) return null;
  const state = data.state;
  if (data.confirmed !== true || typeof data.blockHash !== 'string' || !/^[a-fA-F0-9]{64}$/.test(data.blockHash)
    || !state || typeof state.initialized !== 'boolean'
    || !['OPEN', 'PENDING', 'VOTING', 'FINAL'].includes(state.status)
    || !(state.outcome === null || typeof state.outcome === 'string')
    || (state.status === 'FINAL' && !state.outcome)) {
    throw new Error('prediction: invalid confirmed market state');
  }
  const metadata = z.object({
    disputeDeadlineSec: z.number().int().nonnegative().max(253402300799).optional(),
    voteDeadlineSec: z.number().int().nonnegative().max(253402300799).optional(),
    proposalOutcome: z.string().nullable().optional(), challengeOutcome: z.string().nullable().optional(),
    proposer: z.string().nullable().optional(), challenger: z.string().nullable().optional(),
    votes: z.record(z.string(), z.string()).optional(), voteOutcomeByVoter: z.record(z.string(), z.string()).optional(),
    vaultStock: z.record(z.string(), z.string().regex(/^\d+$/)).optional(),
    vaultCollateral: z.string().regex(/^\d+$/).optional(),
  }).safeParse(state);
  if (!metadata.success) throw new Error('prediction: invalid confirmed market metadata');
  return {
    initialized: state.initialized, status: state.status, outcome: state.outcome,
    ...metadata.data,
  };
}

export function getActionAvailability(event: PredictionEvent, state: PredictionState | null, nowSec = Math.floor(Date.now() / 1000)) {
  const ready = state?.initialized === true;
  const open = ready && state?.status === 'OPEN';
  const beforeResolution = nowSec < event.resolutionTimeSec;
  return {
    split: open && beforeResolution,
    merge: open && beforeResolution,
    trade: open && beforeResolution,
    resolve: open && !beforeResolution && nowSec < event.resolutionTimeSec + event.autoInvalidSec,
    dispute: ready && state?.status === 'PENDING' && nowSec < (state.disputeDeadlineSec ?? 0),
    vote: ready && event.oracle === 'staked' && state?.status === 'VOTING' && nowSec < (state.voteDeadlineSec ?? 0),
    redeem: ready && state?.status === 'FINAL',
  };
}

async function requireOpenState(contractTokenid: string, amount: bigint): Promise<PredictionState> {
  if (amount <= 0n) throw new Error('prediction: amount must be positive');
  const state = await getState(contractTokenid);
  if (!state?.initialized || state.status !== 'OPEN') throw new Error('prediction: market is not open');
  return state;
}

export function getOracleActionError(
  action: 'resolve' | 'dispute' | 'vote', event: PredictionEvent, state: PredictionState | null,
  outcome: string, address: string, nowSec = Math.floor(Date.now() / 1000),
): string | null {
  const normalized = event.outcomes.length === 2 && (outcome === 'yes' || outcome === 'no')
    ? event.outcomes[outcome === 'yes' ? 0 : 1] : outcome;
  if (normalized !== 'invalid' && !event.outcomes.includes(normalized)) return 'Unknown outcome';
  if (!getActionAvailability(event, state, nowSec)[action]) return 'Action unavailable in the current market state';
  if (!address) return 'Unlock a wallet first';
  if (action === 'resolve' && event.oracle === 'committee' && !event.committee.includes(address)) {
    return 'Only committee members can resolve this market';
  }
  if (action === 'dispute') {
    const tally = new Map<string, number>();
    for (const vote of Object.values(state?.votes ?? {})) tally.set(vote, (tally.get(vote) ?? 0) + 1);
    const leading = event.oracle === 'staked' ? state?.proposalOutcome
      : [...tally].sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right))[0]?.[0];
    if (!leading || normalized === leading) return 'Choose an outcome different from the proposal';
    if (event.oracle === 'staked' && (state?.proposer === address || state?.challenger)) {
      return 'This wallet cannot challenge the proposal';
    }
  }
  if (action === 'vote') {
    if (![state?.proposalOutcome, state?.challengeOutcome].includes(normalized)) return 'Vote for a contested outcome';
    const previous = state?.voteOutcomeByVoter?.[address];
    if (previous && previous !== normalized) return 'A prior vote already backs another outcome';
  }
  return null;
}

async function requireOracleAction(
  action: 'resolve' | 'dispute' | 'vote', event: PredictionEvent, outcome: string,
  privateKeyHex: string, keyType?: 'PQ' | 'EC',
): Promise<void> {
  if (keyType === 'EC') throw new Error('Prediction contract actions require a PQ wallet');
  const state = await getState(event.contractTokenid);
  const address = keyFromPrivate(privateKeyHex, keyType).toAddressString(getNetParams());
  const error = getOracleActionError(action, event, state, outcome, address);
  if (error) throw new Error(error);
}

export function getRedeemableShares(
  event: PredictionEvent,
  state: PredictionState | null,
  shares: Record<string, bigint>,
): Record<string, bigint> {
  if (!state?.initialized || state.status !== 'FINAL') return {};
  if (state.outcome === 'invalid') {
    let amount = shares[event.outcomes[0]] ?? 0n;
    for (const outcome of event.outcomes) {
      const balance = shares[outcome] ?? 0n;
      if (balance < amount) amount = balance;
    }
    return amount > 0n ? Object.fromEntries(event.outcomes.map((outcome) => [outcome, amount])) : {};
  }
  const winner = state.outcome;
  if (!winner || !event.outcomes.includes(winner) || (shares[winner] ?? 0n) <= 0n) return {};
  return { [winner]: shares[winner] };
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
  return Promise.all(events.map(async (event) => {
    const state = await getState(event.contractTokenid).catch(() => null);
    const shares: Record<string, bigint> = {};
    for (const outcome of event.outcomes) {
      const bal = byToken.get(outcome) ?? 0n;
      shares[outcome] = bal;
    }
    const redeemableShares = getRedeemableShares(event, state, shares);
    const redeemable = Object.values(redeemableShares).reduce((amount, value) => value > amount ? value : amount, 0n);
    return {
      event,
      state,
      shares,
      yes: shares[event.yesTokenid] ?? 0n,
      no: shares[event.noTokenid] ?? 0n,
      redeemable,
    };
  }));
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
  const state = await requireOpenState(contractTokenid, amount);
  if (!state.vaultStock || Object.values(state.vaultStock).some((stock) => BigInt(stock) < amount)
    || Object.keys(state.vaultStock).length < 2) throw new Error('prediction: insufficient vault shares');
  const event = await getEvent(contractTokenid);
  if (!event || event.contractTokenid !== contractTokenid || event.collateralTokenid !== collateralTokenid) {
    throw new Error('prediction: market configuration is unavailable or mismatched');
  }
  if (!getActionAvailability(event, state).split) throw new Error('prediction: split deadline has passed');
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
  const state = await requireOpenState(event.contractTokenid, amount);
  if (!getActionAvailability(event, state).merge) throw new Error('prediction: merge deadline has passed');
  if (state.vaultCollateral === undefined || BigInt(state.vaultCollateral) < amount) {
    throw new Error('prediction: insufficient vault collateral');
  }
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
  await requireOracleAction('resolve', event, outcome, privateKeyHex, keyType);
  const minimumBond = event.oracle === 'staked' ? event.proposalBond : 0n;
  const burn = bond ?? minimumBond;
  if (burn < minimumBond || (event.oracle === 'committee' && burn !== 0n)) throw new Error('Invalid resolution bond');
  const wallet = await predictionWallet(privateKeyHex, keyType);
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
  await requireOracleAction('dispute', event, outcome, privateKeyHex, keyType);
  const minimumBond = event.oracle === 'staked' ? event.proposalBond : event.disputeBond;
  const burn = bond ?? minimumBond;
  if (burn < minimumBond) throw new Error('prediction: dispute bond is below the required minimum');
  const wallet = await predictionWallet(privateKeyHex, keyType);
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
  if (bond <= 0n) throw new Error('Vote bond must be positive');
  await requireOracleAction('vote', event, outcome, privateKeyHex, keyType);
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
 * available amount; only winning shares or equal complete sets are burned.
 */
export async function redeemShares(params: {
  privateKeyHex: string;
  keyType?: 'PQ' | 'EC';
  event: PredictionEvent;
  shares: Record<string, bigint>;
}): Promise<string> {
  const { privateKeyHex, keyType, event, shares } = params;
  const state = await getState(event.contractTokenid);
  if (!state?.initialized || state.status !== 'FINAL') {
    throw new Error('prediction: market is not finalized');
  }
  const redeemableShares = getRedeemableShares(event, state, shares);
  const burns = new Map<string, bigint>();
  let representative = 0n;
  let representativeToken = event.outcomes[0];
  for (const outcome of event.outcomes) {
    const amount = redeemableShares[outcome] ?? 0n;
    if (amount > 0n) {
      burns.set(outcome, amount);
      if (amount > representative) {
        representative = amount;
        representativeToken = outcome;
      }
    }
  }
  if (burns.size === 0) throw new Error('redeemShares: no positive share amounts to redeem');
  const wallet = await predictionWallet(privateKeyHex, keyType);
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
  const state = await getState(event.contractTokenid);
  if (!getActionAvailability(event, state).trade) throw new Error('Trading is closed for this market');
  const plan = await quoteOutcome({ side, event, outcomeTokenid, amount });
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
export async function fetchOutcomeBook(outcomeTokenid: string, collateralTokenid: string): Promise<{ asks: BookLevel[]; bids: BookLevel[] }> {
  const res = await httpService.requestL1ByChainId<any>(PREDICTION_CHAIN_ID, 'getOrders', 'POST', {
    tokenid: outcomeTokenid,
  });
  if (!res.success) throw new Error('Prediction order book is unavailable');
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
    if (isSell && offersOutcome && o.targetTokenid === collateralTokenid) {
      const amount = BigInt(o.offerValue ?? 0);
      if (amount > 0n) asks.push({ price, amount });
    } else if (!isSell && wantsOutcome && o.offerTokenid === collateralTokenid) {
      const amount = BigInt(o.targetValue ?? 0);
      if (amount > 0n) bids.push({ price, amount });
    }
  }
  asks.sort((left, right) => left.price < right.price ? -1 : left.price > right.price ? 1 : 0);
  bids.sort((left, right) => left.price > right.price ? -1 : left.price < right.price ? 1 : 0);
  return { asks, bids };
}

export async function quoteOutcome(params: {
  side: 'buy' | 'sell'; event: PredictionEvent; outcomeTokenid: string; amount: bigint;
}) {
  const { side, event, outcomeTokenid, amount } = params;
  if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Enter a positive, safe integer amount');
  if (!event.outcomes.includes(outcomeTokenid)) throw new Error('Unknown outcome');
  const { asks, bids } = await fetchOutcomeBook(outcomeTokenid, event.collateralTokenid);
  const plan = side === 'buy' ? PredictionMarketOrders.planBuy(asks, amount) : PredictionMarketOrders.planSell(bids, amount);
  if (plan.price > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Order price exceeds the supported range');
  return { ...plan, quotedAt: Date.now() };
}

export function validateCreateEvent(params: Parameters<typeof createEvent>[0]) {
  const positiveSeconds = z.number().int().positive().max(315360000);
  const parsed = z.object({
    question: z.string().trim().min(1).max(500),
    supply: z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)),
    collateralTokenid: z.string().trim().regex(/^[a-fA-F0-9]+$/),
    resolutionTimeSec: z.number().int().safe().refine((time) => time > Math.floor(Date.now() / 1000), 'Resolution must be in the future'),
    disputeWindowSec: positiveSeconds,
    autoInvalidSec: positiveSeconds,
    disputeBond: z.bigint().nonnegative().max(BigInt(Number.MAX_SAFE_INTEGER)),
    committeeAddresses: z.array(z.string().trim().toLowerCase().regex(/^[a-f0-9]+$/)),
    outcomeNames: z.array(z.string().trim().min(1).max(40).refine((name) => !name.includes(','), 'Outcome labels cannot contain commas'))
      .min(2).max(16).default(['YES', 'NO'])
      .refine((names) => new Set(names.map((name) => name.toLowerCase())).size === names.length, 'Outcome labels must be unique'),
    oracle: z.enum(['committee', 'staked']).default(params.committeeAddresses.length ? 'committee' : 'staked'),
    proposalBond: z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER)).optional(),
    voteWindowSec: positiveSeconds.optional(),
  }).superRefine((value, context) => {
    if (value.oracle === 'committee' && (value.committeeAddresses.length < 2
      || new Set(value.committeeAddresses).size !== value.committeeAddresses.length)) {
      context.addIssue({ code: 'custom', message: 'Committee needs at least two distinct addresses', path: ['committeeAddresses'] });
    }
    if (value.oracle === 'staked' && (value.proposalBond ?? value.disputeBond) <= 0n) {
      context.addIssue({ code: 'custom', message: 'Staked markets require a positive proposal bond', path: ['proposalBond'] });
    }
  }).parse(params);
  return { ...params, ...parsed };
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
  } = validateCreateEvent(params);

  const names = outcomeNames && outcomeNames.length >= 2 ? outcomeNames : ['YES', 'NO'];
  if (keyType === 'EC') throw new Error('Prediction market creation requires a PQ wallet');
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
    outcomeNames: names,
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
  getState,
  getRedeemableShares,
  getActionAvailability,
  getOracleActionError,
  fetchOutcomeBook,
  quoteOutcome,
  validateCreateEvent,
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
