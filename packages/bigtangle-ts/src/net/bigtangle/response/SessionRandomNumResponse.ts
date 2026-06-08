import { AbstractResponse } from './AbstractResponse';
import { JsonProperty } from "jackson-js";

export class SessionRandomNumResponse extends AbstractResponse {
    @JsonProperty() private verifyHex: string | null = null;

    public static create(verifyHex: string): SessionRandomNumResponse {
        const res = new SessionRandomNumResponse();
        res.verifyHex = verifyHex;
        return res;
    }

    public getVerifyHex(): string | null {
        return this.verifyHex;
    }

    public setVerifyHex(verifyHex: string | null): void {
        this.verifyHex = verifyHex;
    }
}
