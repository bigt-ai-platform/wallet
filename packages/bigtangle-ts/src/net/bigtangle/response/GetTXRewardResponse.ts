import { AbstractResponse } from './AbstractResponse';
import { TXReward } from '../core/TXReward';
import { JsonProperty } from "jackson-js";

export class GetTXRewardResponse extends AbstractResponse {
    @JsonProperty() private txReward: TXReward | null = null;

    public static create(txReward: TXReward): GetTXRewardResponse {
        const res = new GetTXRewardResponse();
        res.txReward = txReward;
        return res;
    }

    public getTxReward(): TXReward | null {
        return this.txReward;
    }

    public setTxReward(txReward: TXReward | null): void {
        this.txReward = txReward;
    }
}
