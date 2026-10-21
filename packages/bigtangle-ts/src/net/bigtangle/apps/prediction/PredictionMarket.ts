import { KeyValue } from '../../core/KeyValue';
import { TokenKeyValues } from '../../core/TokenKeyValues';

/**
 * Prediction-market helpers: action JSON carried in
 * `ContractEventInfo.offerSystem` and the contract token's config
 * `TokenKeyValues`. Mirrors the Java engine contract
 * (`net.bigtangle.server.service.PredictionContract`, docs/prediction-market.md).
 *
 * Oracle modes:
 *  - `committee` (v1): an M-of-N resolver committee + bonded disputes.
 *  - `staked` (v2, phase 4): permissionless optimistic proposal with a bond,
 *    bonded challenge, token-holder vote, slash the liar.
 */
export type PredictionOracle = 'committee' | 'staked';

export interface PredictionConfigInput {
  supply: bigint;
  collateralTokenid: string;
  /**
   * Multi-outcome markets (phase 5): N >= 2 ordered winner-take-all outcome
   * token ids. When present it supersedes the legacy `yesTokenid`/`noTokenid`
   * pair and is written as the comma-separated `outcomeTokenids` key-value.
   */
  outcomeTokenids?: string[];
  outcomeNames?: string[];
  /** binary market: outcome index 0. */
  yesTokenid?: string;
  /** binary market: outcome index 1. */
  noTokenid?: string;
  question: string;
  resolutionTimeSec: number;
  disputeWindowSec: number;
  autoInvalidSec: number;
  disputeBond: bigint;
  /** committee mode: resolver addresses. Leave empty for a staked market. */
  committeeAddresses?: string[];
  /** default: 'committee' when committeeAddresses is non-empty, else 'staked'. */
  oracle?: PredictionOracle;
  /** staked mode: minimum collateral bond to propose/challenge. */
  proposalBond?: bigint;
  /** staked mode: token-holder vote length after a challenge (seconds). */
  voteWindowSec?: number;
}

export class PredictionAction {
  static create(): string {
    return JSON.stringify({ action: 'create' });
  }

  static split(): string {
    return JSON.stringify({ action: 'split' });
  }

  static merge(): string {
    return JSON.stringify({ action: 'merge' });
  }

  /** committee+witness: a committee member posts, or (staked) anyone proposes, an outcome. */
  static resolve(outcome: string): string {
    return JSON.stringify({ action: 'resolve', outcome });
  }

  /** staked alias for resolve — a bonded optimistic proposal. */
  static propose(outcome: string): string {
    return JSON.stringify({ action: 'resolve', outcome });
  }

  /** anyone: bonded challenge to a live proposal / committee outcome. */
  static dispute(outcome: string): string {
    return JSON.stringify({ action: 'dispute', outcome });
  }

  /** staked mode: bond collateral backing one of the two live outcomes. */
  static vote(outcome: string): string {
    return JSON.stringify({ action: 'vote', outcome });
  }

  static redeem(): string {
    return JSON.stringify({ action: 'redeem' });
  }

  /** Liveness heartbeat: push resolutionTimeSec forward. */
  static heartbeat(resolutionTimeSec: number): string {
    return JSON.stringify({ action: 'heartbeat', resolutionTimeSec });
  }
}

export class PredictionMarketConfig {
  static CONTRACT_CLASSNAME = 'net.bigtangle.server.service.PredictionContract';

  /** Config key-values for the contract token (no amount/token keys — the engine ignores them). */
  static keyValues(input: PredictionConfigInput): TokenKeyValues {
    const committee = input.committeeAddresses ?? [];
    const oracle = input.oracle ?? (committee.length > 0 ? 'committee' : 'staked');
    const tkv = new TokenKeyValues();
    const add = (key: string, value: string) => {
      const kv = new KeyValue();
      kv.setKey(key);
      kv.setValue(value);
      tkv.addKeyvalue(kv);
    };
    add('classname', PredictionMarketConfig.CONTRACT_CLASSNAME);
    add('S', input.supply.toString());
    add('collateralTokenid', input.collateralTokenid);
    const outcomes =
      input.outcomeTokenids ??
      (input.yesTokenid && input.noTokenid ? [input.yesTokenid, input.noTokenid] : undefined);
    if (!outcomes || outcomes.length < 2) {
      throw new Error('prediction market: need at least 2 outcome tokens (outcomeTokenids or yesTokenid+noTokenid)');
    }
    if (input.outcomeNames) {
      if (input.outcomeNames.length !== outcomes.length || input.outcomeNames.some((name) => !name.trim() || name.includes(','))) {
        throw new Error('prediction market: outcome names must match the tokens and cannot contain commas');
      }
      add('outcomeNames', input.outcomeNames.map((name) => name.trim()).join(','));
    }
    if (input.outcomeTokenids) {
      add('outcomeTokenids', outcomes.join(','));
    } else {
      add('yesTokenid', outcomes[0]);
      add('noTokenid', outcomes[1]);
    }
    add('question', input.question);
    add('resolutionTimeSec', String(input.resolutionTimeSec));
    add('disputeWindowSec', String(input.disputeWindowSec));
    add('autoInvalidSec', String(input.autoInvalidSec));
    add('disputeBond', input.disputeBond.toString());
    add('oracle', oracle);
    if (oracle === 'committee') {
      add('committee', committee.join(','));
    } else {
      add('proposalBond', (input.proposalBond ?? input.disputeBond).toString());
      add('voteWindowSec', String(input.voteWindowSec ?? input.disputeWindowSec));
    }
    return tkv;
  }
}
