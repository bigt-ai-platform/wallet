import { AbstractResponse } from './AbstractResponse';
import { TXReward } from '../core/TXReward';
import { JsonProperty } from "jackson-js";

export class GetTXRewardListResponse extends AbstractResponse {
    @JsonProperty() private txReward: TXReward[] | null = null;

    public static create(txReward: TXReward[]): GetTXRewardListResponse {
        const res = new GetTXRewardListResponse();
        res.txReward = txReward;
        return res;
    }

    public getTxReward(): TXReward[] | null {
        return this.txReward;
    }

    public setTxReward(txReward: TXReward[] | null): void {
        this.txReward = txReward;
    }
}
