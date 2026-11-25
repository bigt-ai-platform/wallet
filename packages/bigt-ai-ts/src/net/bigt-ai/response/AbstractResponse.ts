import { JsonProperty } from "jackson-js";

export abstract class AbstractResponse {
  @JsonProperty() errorcode: number | null = null;
  @JsonProperty() message: string | null = null;
  @JsonProperty() duration: number | null = null;

  public getMessage(): string | null {
    return this.message;
  }

  public setMessage(message: string | null): void {
    this.message = message;
  }

  public getErrorcode(): number | null {
    return this.errorcode;
  }

  public setErrorcode(errorcode: number | null): void {
    this.errorcode = errorcode;
  }

  public static createEmptyResponse(): AbstractResponse {
    return new Emptyness();
  }

  public getDuration(): number {
    return this.duration ?? 0;
  }

  public setDuration(duration: number | null): void {
    this.duration = duration;
  }
}

class Emptyness extends AbstractResponse {
  // No additional properties or methods needed for an empty response
}
