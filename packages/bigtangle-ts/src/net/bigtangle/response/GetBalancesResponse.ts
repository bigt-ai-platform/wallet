import { AbstractResponse } from './AbstractResponse';
import { Coin } from '../core/Coin';
import { Token } from '../core/Token';
import { UTXO } from '../core/UTXO';
import { JsonProperty } from 'jackson-js';

export class GetBalancesResponse extends AbstractResponse {
    @JsonProperty()
    private outputs: UTXO[] | null = null;
    @JsonProperty()
    private balance: Coin[] | null = null;
    @JsonProperty()
    private tokennames: Map<string, Token> | null = null;

    public static create(coinbalance: Coin[], outputs: UTXO[], tokennames: Map<string, Token>): GetBalancesResponse {
        const res = new GetBalancesResponse();
        res.outputs = outputs;
        res.balance = coinbalance;
        res.tokennames = tokennames;
        return res;
    }

    public getOutputs(): UTXO[] | null {
        return this.outputs;
    }

    public getBalance(): Coin[] | null {
        return this.balance;
    }

    public getTokennames(): Map<string, Token> | null {
        return this.tokennames;
    }

    public setTokennames(tokennames: Map<string, Token> | null): void {
        this.tokennames = tokennames;
    }

}
