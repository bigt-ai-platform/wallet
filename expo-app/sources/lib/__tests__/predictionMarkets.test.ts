import { describe, expect, it } from 'vitest';
import { filterPredictionEvents, hasPredictionPosition } from '../predictionMarkets';
import type { PredictionEvent, PredictionPosition, PredictionState } from '@/services/prediction';

const base: PredictionEvent = {
  contractTokenid: 'aaa111', question: 'Will BTC close above 100k?', supply: 1000n,
  collateralTokenid: 'bc', outcomes: ['yes1', 'no1'], outcomeNames: ['YES', 'NO'],
  yesTokenid: 'yes1', noTokenid: 'no1', resolutionTimeSec: 1, disputeWindowSec: 300,
  autoInvalidSec: 86400, disputeBond: 0n, committee: [], oracle: 'staked',
  proposalBond: 1000n, voteWindowSec: 300,
};
const events: PredictionEvent[] = [
  base,
  { ...base, contractTokenid: 'bbb222', question: 'Rain in Berlin tomorrow?', collateralTokenid: 'usdt99', outcomeNames: ['Rain', 'Dry'] },
  { ...base, contractTokenid: 'ccc333', question: 'Election winner', outcomeNames: ['Alice', 'Bob', 'Carol'], outcomes: ['a', 'b', 'c'] },
  { ...base, contractTokenid: 'ddd444', question: 'Final market' },
  { ...base, contractTokenid: 'eee555', question: 'Loading market' },
];
const st = (status: PredictionState['status']): PredictionState => ({ initialized: true, status, outcome: null });
const states: Record<string, PredictionState | null> = {
  aaa111: st('OPEN'), bbb222: st('PENDING'), ccc333: st('VOTING'), ddd444: st('FINAL'),
  eee555: { initialized: false, status: 'OPEN', outcome: null },
};
const position = (event: PredictionEvent, shares: Record<string, bigint>, redeemable = 0n): PredictionPosition =>
  ({ event, state: null, shares, yes: 0n, no: 0n, redeemable });
const positions = {
  aaa111: position(base, { yes1: 0n, no1: 5n }),
  bbb222: position(events[1], { yes1: 0n }),
  ddd444: position(events[3], {}, 7n),
};
const ids = (list: PredictionEvent[]) => list.map((event) => event.contractTokenid);

describe('filterPredictionEvents', () => {
  it('groups markets by initialized lifecycle status', () => {
    expect(ids(filterPredictionEvents(events, states, positions, 'all', ''))).toEqual(ids(events));
    expect(ids(filterPredictionEvents(events, states, positions, 'open', ''))).toEqual(['aaa111']);
    expect(ids(filterPredictionEvents(events, states, positions, 'resolving', ''))).toEqual(['bbb222', 'ccc333']);
    expect(ids(filterPredictionEvents(events, states, positions, 'final', ''))).toEqual(['ddd444']);
  });

  it('shows only markets with shares or redeemable collateral under mine', () => {
    expect(ids(filterPredictionEvents(events, states, positions, 'mine', ''))).toEqual(['aaa111', 'ddd444']);
    expect(hasPredictionPosition(events[1], positions.bbb222)).toBe(false);
    expect(hasPredictionPosition(events[2], undefined)).toBe(false);
  });

  it('matches every search term across question, outcomes, collateral and id', () => {
    expect(ids(filterPredictionEvents(events, states, positions, 'all', '  btc BIG yes '))).toEqual(['aaa111']);
    expect(ids(filterPredictionEvents(events, states, positions, 'all', 'carol'))).toEqual(['ccc333']);
    expect(ids(filterPredictionEvents(events, states, positions, 'all', 'USDT99 dry'))).toEqual(['bbb222']);
    expect(ids(filterPredictionEvents(events, states, positions, 'all', 'eee5'))).toEqual(['eee555']);
    expect(filterPredictionEvents(events, states, positions, 'open', 'berlin')).toEqual([]);
  });
});
