import { AbstractResponse } from "./AbstractResponse";
import { OrderRecord } from "../core/OrderRecord";
import { Token } from "../core/Token";
import { JsonProperty, JsonClassType } from "jackson-js";
export class OrderdataResponse extends AbstractResponse {
  @JsonProperty()
  @JsonClassType({ type: () => [Array, [OrderRecord]] }) // OrderRecord[]
  allOrdersSorted: OrderRecord[] | null = null;
  @JsonProperty()
  @JsonClassType({ type: () => [Map, [String, Token]] }) // Map<string, Token>
  private tokennames: Map<string, Token> | null = null;

  public static createOrderRecordResponse(
    allOrdersSorted: OrderRecord[],
    tokennames: Map<string, Token>
  ): OrderdataResponse {
    const res = new OrderdataResponse();
    res.allOrdersSorted = allOrdersSorted;
    res.tokennames = tokennames;
    return res;
  }

  public getAllOrdersSorted(): OrderRecord[] | null {
    return this.allOrdersSorted;
  }

  public setAllOrdersSorted(allOrdersSorted: OrderRecord[] | null): void {
    this.allOrdersSorted = allOrdersSorted;
  }

  public getTokennames(): Map<string, Token> | null {
    return this.tokennames;
  }

  public setTokennames(tokennames: Map<string, Token> | null): void {
    this.tokennames = tokennames;
  }
}
