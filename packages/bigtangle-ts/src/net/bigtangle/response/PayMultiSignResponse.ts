import { AbstractResponse } from './AbstractResponse';
import { JsonProperty } from "jackson-js";

export class PayMultiSignResponse extends AbstractResponse {
    @JsonProperty() private success: boolean = false;

    public static create(success: boolean): PayMultiSignResponse {
        const res = new PayMultiSignResponse();
        res.success = success;
        return res;
    }

    public isSuccess(): boolean {
        return this.success;
    }

    public setSuccess(success: boolean): void {
        this.success = success;
    }
}
