import { AbstractResponse } from './AbstractResponse';
import { JsonProperty } from "jackson-js";

export class GetBlockListResponse extends AbstractResponse {
    @JsonProperty() private blockbytelist: Uint8Array[] | null = null;

    public static create(blockbytelist: Uint8Array[]): GetBlockListResponse {
        const res = new GetBlockListResponse();
        res.blockbytelist = blockbytelist;
        return res;
    }

    public getBlockbytelist(): Uint8Array[] | null {
        return this.blockbytelist;
    }

    public setBlockbytelist(blockbytelist: Uint8Array[] | null): void {
        this.blockbytelist = blockbytelist;
    }
}
