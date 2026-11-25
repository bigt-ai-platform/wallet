import { AbstractResponse } from "./AbstractResponse";
import { JsonProperty } from "jackson-js";
export class BooleanResponse extends AbstractResponse {
  @JsonProperty() private value: boolean | null = null;

  public static create(value: boolean): BooleanResponse {
    const res = new BooleanResponse();
    res.value = value;
    return res;
  }

  public getValue(): boolean | null {
    return this.value;
  }

  public setValue(value: boolean | null): void {
    this.value = value;
  }
}
