import { AbstractResponse } from "./AbstractResponse";
import { Token } from "../core/Token";
import { UTXO } from "../core/UTXO";
import { JsonProperty } from "jackson-js";

export class GetOutputsResponse extends AbstractResponse {
  @JsonProperty() private outputs: UTXO[] | null = null;
  @JsonProperty()
  private tokennames: Record<string, Token> | null = null;

  public static create(
    outputs: UTXO[],
    tokennames: Record<string, Token>
  ): GetOutputsResponse {
    const res = new GetOutputsResponse();
    res.outputs = outputs;
    res.tokennames = tokennames;
    return res;
  }

  public getOutputs(): UTXO[] | null {
    return this.outputs;
  }

  public getTokennames(): Record<string, Token> | null {
    return this.tokennames;
  }

  public setTokennames(tokennames: Record<string, Token> | null): void {
    this.tokennames = tokennames;
  }
  public setOutputs(outputs: UTXO[] | null): void {
    this.outputs = outputs;
  }
}
