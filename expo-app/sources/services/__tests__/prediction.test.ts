import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  balances: vi.fn(),
  payContract: vi.fn(),
  payContractMulti: vi.fn(),
  fromKeysURL: vi.fn(),
  order: vi.fn(),
}));

vi.mock('bigtangle-ts', async () => {
  const { PredictionMarketOrders } = await import('../../../../packages/bigtangle-ts/src/net/bigtangle/apps/prediction/PredictionMarketOrders');
  return {
    PredictionMarketOrders,
    Wallet: { fromKeysURL: mocks.fromKeysURL },
    PQKey: { fromPrivateKey: () => ({ toAddressString: () => 'alice' }) },
    TestParams: { get: () => ({}) },
    NetworkParameters: { BIGTANGLE_TOKENID_STRING: 'bc' },
    PredictionAction: {
      split: () => JSON.stringify({ action: 'split' }),
      merge: () => JSON.stringify({ action: 'merge' }),
      redeem: () => JSON.stringify({ action: 'redeem' }),
      dispute: (outcome: string) => JSON.stringify({ action: 'dispute', outcome }),
      resolve: (outcome: string) => JSON.stringify({ action: 'resolve', outcome }),
      vote: (outcome: string) => JSON.stringify({ action: 'vote', outcome }),
    },
  };
});
vi.mock('../http', () => ({ httpService: {
  requestL1ByChainId: mocks.request,
  getBalancesOn: mocks.balances,
  getL1Chains: () => [{ chainId: 'prediction', url: 'http://prediction.test/' }],
} }));
vi.mock('../transaction', () => ({ orderOnLayer1: mocks.order }));
vi.mock('@/constants/app', () => ({ IS_DEV: true }));

import { disputeEvent, getActionAvailability, getOracleActionError, getPositions, getState, marketOrderOutcome, mergeShares, parsePredictionEvent, quoteOutcome, redeemShares, resolveEvent, splitShares, validateCreateEvent, voteEvent } from '../prediction';

const token = {
  tokenid: 'market',
  tokenKeyValues: { keyvalues: Object.entries({
    classname: 'net.bigtangle.server.service.PredictionContract',
    S: '1000', yesTokenid: 'yes-token', noTokenid: 'no-token', collateralTokenid: 'bc',
    disputeBond: '10', oracle: 'committee',
    resolutionTimeSec: String(Math.floor(Date.now() / 1000) + 86400), autoInvalidSec: '600',
  }).map(([key, value]) => ({ key, value })) },
};
const event = parsePredictionEvent(token)!;
const auth = { privateKeyHex: '00', event };
const shares = { 'yes-token': 100n, 'no-token': 25n };

function checkpoint(status = 'FINAL', outcome: string | null = 'yes-token') {
  return { success: true, data: {
    contractTokenid: 'market', confirmed: true, blockHash: 'ab'.repeat(32),
    state: { initialized: true, status, outcome },
  } };
}

beforeEach(() => {
  vi.resetAllMocks();
  const tx = { getHash: () => ({ toString: () => 'tx-hash' }) };
  mocks.fromKeysURL.mockResolvedValue({ payContract: mocks.payContract, payContractMulti: mocks.payContractMulti });
  mocks.payContract.mockResolvedValue(tx);
  mocks.payContractMulti.mockResolvedValue(tx);
  mocks.order.mockResolvedValue('order-hash');
  mocks.request.mockResolvedValue(checkpoint());
});

describe('prediction action safety', () => {
  it('rejects malformed confirmed deadlines and balances', async () => {
    for (const metadata of [{ disputeDeadlineSec: 'tomorrow' }, { vaultCollateral: '-1' }, { votes: [] }]) {
      const response = checkpoint('OPEN', null);
      Object.assign(response.data.state, metadata);
      mocks.request.mockResolvedValue(response);
      await expect(getState('market')).rejects.toThrow('invalid confirmed market metadata');
    }
  });
  it.each(['PENDING', 'VOTING', 'FINAL'])('rejects split and merge in %s before signing', async (status) => {
    mocks.request.mockResolvedValue(checkpoint(status));
    await expect(splitShares({ privateKeyHex: '00', contractTokenid: 'market', collateralTokenid: 'bc', amount: 1n }))
      .rejects.toThrow('not open');
    await expect(mergeShares({ ...auth, amount: 1n })).rejects.toThrow('not open');
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });

  it('checks positive amounts and vault capacity', async () => {
    const response = checkpoint('OPEN', null);
    Object.assign(response.data.state, { vaultStock: { 'yes-token': '20', 'no-token': '20' }, vaultCollateral: '10' });
    mocks.request.mockResolvedValue(response);
    await expect(mergeShares({ ...auth, amount: 0n })).rejects.toThrow('positive');
    await expect(mergeShares({ ...auth, amount: 11n })).rejects.toThrow('collateral');
    await expect(splitShares({ privateKeyHex: '00', contractTokenid: 'market', collateralTokenid: 'bc', amount: 21n }))
      .rejects.toThrow('vault shares');
    await mergeShares({ ...auth, amount: 5n });
    expect(mocks.payContractMulti.mock.calls[0][1]).toEqual(new Map([['yes-token', 5n], ['no-token', 5n]]));
  });

  it('uses status and deadlines to expose only timely actions', () => {
    const market = { ...event, resolutionTimeSec: 100, autoInvalidSec: 100 };
    expect(getActionAvailability(market, null, 50).split).toBe(false);
    expect(getActionAvailability(market, { initialized: true, status: 'OPEN', outcome: null }, 50))
      .toMatchObject({ split: true, merge: true, trade: true, resolve: false });
    expect(getActionAvailability(market, { initialized: true, status: 'OPEN', outcome: null }, 101))
      .toMatchObject({ split: false, trade: false, resolve: true });
    expect(getActionAvailability(market, { initialized: true, status: 'PENDING', outcome: null, disputeDeadlineSec: 120 }, 121).dispute).toBe(false);
  });

  it('rejects an expired OPEN checkpoint before burning split or merge inputs', async () => {
    const response = checkpoint('OPEN', null);
    Object.assign(response.data.state, { vaultStock: { 'yes-token': '20', 'no-token': '20' }, vaultCollateral: '20' });
    const expired = { ...token, tokenKeyValues: { keyvalues: token.tokenKeyValues.keyvalues.map((entry) =>
      entry.key === 'resolutionTimeSec' ? { ...entry, value: '1' } : entry) } };
    mocks.request.mockImplementation(async (_chain, endpoint) => endpoint === 'getTokenById'
      ? { success: true, data: { tokens: [expired] } } : response);
    await expect(splitShares({ privateKeyHex: '00', contractTokenid: 'market', collateralTokenid: 'bc', amount: 1n }))
      .rejects.toThrow('deadline');
    await expect(mergeShares({ ...auth, event: { ...event, resolutionTimeSec: 1 }, amount: 1n }))
      .rejects.toThrow('deadline');
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });
});

describe('prediction redemption', () => {
  it.each(['OPEN', 'PENDING', 'VOTING'])('never burns shares while %s', async (status) => {
    mocks.request.mockResolvedValue(checkpoint(status, null));
    await expect(redeemShares({ ...auth, shares })).rejects.toThrow('not finalized');
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });

  it.each([
    { success: false },
    { success: true, data: { contractTokenid: 'market', confirmed: false, state: null } },
    { success: true, data: { ...checkpoint().data, contractTokenid: 'other' } },
    { success: true, data: { ...checkpoint().data, confirmed: false } },
    { success: true, data: { ...checkpoint().data, blockHash: undefined } },
    checkpoint('FINAL', null),
    checkpoint('FINAL', 'foreign-outcome'),
  ])('fails closed for unavailable or invalid state %#', async (response) => {
    mocks.request.mockResolvedValue(response);
    await expect(redeemShares({ ...auth, shares })).rejects.toThrow();
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });

  it('burns only the winner and supports a winning-only position', async () => {
    await redeemShares({ ...auth, shares: { 'yes-token': 100n } });
    expect(mocks.payContractMulti.mock.calls[0][1]).toEqual(new Map([['yes-token', 100n]]));
    await redeemShares({ ...auth, shares });
    expect(mocks.payContractMulti.mock.calls[1][1]).toEqual(new Map([['yes-token', 100n]]));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenCalledWith('prediction', 'getPredictionState', 'POST', { contractTokenid: 'market' });
  });

  it('preserves unmatched shares when an invalid market redeems complete sets', async () => {
    mocks.request.mockResolvedValue(checkpoint('FINAL', 'invalid'));
    await redeemShares({ ...auth, shares });
    expect(mocks.payContractMulti.mock.calls[0][1]).toEqual(new Map([['yes-token', 25n], ['no-token', 25n]]));
  });

  it('uses every outcome for multi-outcome invalid redemption', async () => {
    mocks.request.mockResolvedValue(checkpoint('FINAL', 'invalid'));
    await redeemShares({ ...auth, event: { ...event, outcomes: [...event.outcomes, 'third-token'] },
      shares: { ...shares, 'third-token': 7n } });
    expect(mocks.payContractMulti.mock.calls[0][1]).toEqual(new Map([
      ['yes-token', 7n], ['no-token', 7n], ['third-token', 7n],
    ]));
  });

  it('does not burn incomplete invalid sets or losing-only holdings', async () => {
    await expect(redeemShares({ ...auth, shares: { 'no-token': 25n } })).rejects.toThrow();
    mocks.request.mockResolvedValue(checkpoint('FINAL', 'invalid'));
    await expect(redeemShares({ ...auth, shares: { 'yes-token': 100n } })).rejects.toThrow();
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });

  it.each([
    ['FINAL', 'yes-token', 100n],
    ['OPEN', null, 0n],
    ['FINAL', 'invalid', 0n],
  ])('reports correct UI redeemability for %s / %s', async (status, outcome, expected) => {
    mocks.request.mockImplementation(async (_chain, endpoint) => endpoint === 'searchContractTokens'
      ? { success: true, data: { tokens: [token] } } : checkpoint(status, outcome));
    mocks.balances.mockResolvedValue({ success: true, data: [{ tokenid: 'yes-token', raw: '100' }] });
    const positions = await getPositions('00');
    expect(positions[0].redeemable).toBe(expected);
    expect(positions[0].yes).toBe(100n);
  });

  it('keeps positions visible but disables redemption on state read failure', async () => {
    mocks.request.mockImplementation(async (_chain, endpoint) => endpoint === 'searchContractTokens'
      ? { success: true, data: { tokens: [token] } } : { success: false });
    mocks.balances.mockResolvedValue({ success: true, data: [{ tokenid: 'yes-token', raw: '100' }] });
    const positions = await getPositions('00');
    expect(positions[0]).toMatchObject({ yes: 100n, state: null, redeemable: 0n });
    await expect(getState('market')).rejects.toThrow('unavailable');
  });
});

describe('prediction disputes and order books', () => {
  beforeEach(() => {
    const response = checkpoint('PENDING', null);
    Object.assign(response.data.state, { disputeDeadlineSec: Math.floor(Date.now() / 1000) + 300,
      proposalOutcome: 'yes-token', proposer: 'bob', votes: { bob: 'yes-token', carol: 'yes-token' } });
    mocks.request.mockResolvedValue(response);
  });

  it('blocks premature proposals and votes before creating a wallet', async () => {
    await expect(resolveEvent({ ...auth, outcome: 'yes' })).rejects.toThrow('unavailable');
    await expect(voteEvent({ ...auth, outcome: 'yes', bond: 10n })).rejects.toThrow('unavailable');
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });

  it('checks committee membership and competing outcomes', () => {
    const market = { ...event, resolutionTimeSec: 100, autoInvalidSec: 200, committee: ['bob', 'carol'] };
    expect(getOracleActionError('resolve', market, { initialized: true, status: 'OPEN', outcome: null }, 'yes', 'alice', 110))
      .toContain('committee');
    expect(getOracleActionError('dispute', market, { initialized: true, status: 'PENDING', outcome: null,
      disputeDeadlineSec: 200, votes: { bob: 'yes-token', carol: 'yes-token' } }, 'yes', 'alice', 110))
      .toContain('different');
    expect(getOracleActionError('vote', { ...market, oracle: 'staked' }, { initialized: true, status: 'VOTING', outcome: null,
      voteDeadlineSec: 200, proposalOutcome: 'yes-token', challengeOutcome: 'no-token', voteOutcomeByVoter: { alice: 'yes-token' } }, 'no', 'alice', 110))
      .toContain('prior vote');
  });

  it('defaults committee disputes to the required dispute bond', async () => {
    await disputeEvent({ ...auth, outcome: 'no' });
    expect(mocks.payContractMulti.mock.calls[0][1]).toEqual(new Map([['bc', 10n]]));
    expect(mocks.payContract).not.toHaveBeenCalled();
  });

  it('defaults staked challenges to the proposal bond and rejects underpayment', async () => {
    const staked = { ...event, oracle: 'staked' as const, proposalBond: 20n };
    await disputeEvent({ ...auth, event: staked, outcome: 'no' });
    expect(mocks.payContractMulti.mock.calls[0][1]).toEqual(new Map([['bc', 20n]]));
    await expect(disputeEvent({ ...auth, outcome: 'no', bond: 0n })).rejects.toThrow('minimum');
    expect(mocks.payContractMulti).toHaveBeenCalledTimes(1);
  });

  it.each(['buy', 'sell'] as const)('ignores other quote currencies for %s', async (side) => {
    const book = { success: true, data: { orders: [
      { side: 'SELL', offerTokenid: 'yes-token', targetTokenid: 'usd', price: '1', offerValue: '100' },
      { side: 'SELL', offerTokenid: 'yes-token', targetTokenid: 'bc', price: '50', offerValue: '10' },
      { side: 'BUY', offerTokenid: 'usd', targetTokenid: 'yes-token', price: '999', targetValue: '100' },
      { side: 'BUY', offerTokenid: 'bc', targetTokenid: 'yes-token', price: '40', targetValue: '10' },
    ] } };
    mocks.request.mockImplementation(async (_chain, endpoint) => endpoint === 'getOrders' ? book : checkpoint('OPEN', null));
    const result = await marketOrderOutcome({ ...auth, side, outcomeTokenid: 'yes-token', amount: 15n });
    expect(result).toMatchObject({ price: side === 'buy' ? 50n : 40n, filled: 10n, complete: false });
    expect(mocks.order).toHaveBeenCalledWith(expect.objectContaining({ baseToken: 'bc', amount: 10n }));
  });

  it('does not submit when only another currency has liquidity', async () => {
    const book = { success: true, data: { orders: [
      { side: 'SELL', offerTokenid: 'yes-token', targetTokenid: 'usd', price: '1', offerValue: '100' },
    ] } };
    mocks.request.mockImplementation(async (_chain, endpoint) => endpoint === 'getOrders' ? book : checkpoint('OPEN', null));
    await expect(marketOrderOutcome({ ...auth, side: 'buy', outcomeTokenid: 'yes-token', amount: 1n }))
      .rejects.toThrow('no liquidity');
    expect(mocks.order).not.toHaveBeenCalled();
  });

  it('rejects invalid preview sizes without submitting and enforces the price cap', async () => {
    await expect(quoteOutcome({ event, side: 'buy', outcomeTokenid: 'yes-token', amount: 0n })).rejects.toThrow('positive');
    mocks.request.mockImplementation(async (_chain, endpoint) => endpoint === 'getOrders'
      ? { success: true, data: { orders: [{ side: 'SELL', offerTokenid: 'yes-token', targetTokenid: 'bc', price: '51', offerValue: '10' }] } }
      : checkpoint('OPEN', null));
    await expect(marketOrderOutcome({ ...auth, side: 'buy', outcomeTokenid: 'yes-token', amount: 1n, limitPrice: 50n }))
      .rejects.toThrow('above your limit');
    expect(mocks.order).not.toHaveBeenCalled();
  });
});

describe('prediction creation validation', () => {
  const valid = { privateKeyHex: '00', question: 'Who wins?', supply: 1000n, collateralTokenid: 'bc',
    resolutionTimeSec: Math.floor(Date.now() / 1000) + 86400, disputeWindowSec: 300, autoInvalidSec: 600,
    disputeBond: 10n, committeeAddresses: [], outcomeNames: ['Home', 'Draw', 'Away'] };

  it('normalizes labels and selects a staked oracle without a committee', () => {
    expect(validateCreateEvent({ ...valid, question: ' Who wins? ' })).toMatchObject({ question: 'Who wins?', oracle: 'staked' });
  });

  it.each([
    { supply: 0n }, { question: ' ' }, { resolutionTimeSec: 1 }, { disputeWindowSec: NaN },
    { voteWindowSec: 0 }, { outcomeNames: ['Home', 'home'] }, { outcomeNames: ['Only'] },
    { outcomeNames: ['Home,draw', 'Away'] }, { oracle: 'committee' as const, committeeAddresses: ['aa'] },
    { oracle: 'committee' as const, committeeAddresses: ['aa', 'aa'] }, { proposalBond: 0n },
  ])('rejects invalid creation settings %# before minting', (partial) => {
    expect(() => validateCreateEvent({ ...valid, ...partial })).toThrow();
    expect(mocks.fromKeysURL).not.toHaveBeenCalled();
  });
});