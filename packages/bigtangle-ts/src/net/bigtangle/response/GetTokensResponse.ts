import { AbstractResponse } from './AbstractResponse';
import { Token } from '../core/Token';
import { JsonProperty, JsonClassType } from "jackson-js";


export class GetTokensResponse extends AbstractResponse {
      @JsonProperty()
      @JsonClassType({ type: () => [Array, [Token]] }) // OrderRecord[]
    private tokens: Token[] | null = null;
      @JsonProperty()
  @JsonClassType({ type: () => [Map, [String, [String]]] }) // Map<string, string> to handle BigInteger as string
    private amountMap: Map<string, string> | null = null;

    public static create(tokens: Token[], amountMap?: Map<string, string>): GetTokensResponse {
        const res = new GetTokensResponse();
        res.tokens = tokens;
        if (amountMap) {
            res.amountMap = amountMap;
        }
        return res;
    }

    public getTokens(): Token[] | null {
        return this.tokens;
    }

    public getAmountMap(): Map<string, string> | null {
        return this.amountMap;
    }
}
