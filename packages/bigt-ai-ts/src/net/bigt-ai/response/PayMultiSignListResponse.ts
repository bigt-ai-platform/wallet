import { AbstractResponse } from './AbstractResponse';
import { PayMultiSignExt } from '../core/PayMultiSignExt';
import { JsonProperty } from "jackson-js";

export class PayMultiSignListResponse extends AbstractResponse {
    @JsonProperty() private payMultiSigns: PayMultiSignExt[] | null = null;

    public static create(payMultiSigns: PayMultiSignExt[]): PayMultiSignListResponse {
        const res = new PayMultiSignListResponse();
        res.payMultiSigns = payMultiSigns;
        return res;
    }

    public getPayMultiSigns(): PayMultiSignExt[] | null {
        return this.payMultiSigns;
    }
}
