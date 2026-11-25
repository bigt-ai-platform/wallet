import { DataClass } from './DataClass';
import { Uploadfile } from './Uploadfile';
import { JsonProperty, JsonClassType } from "jackson-js";

export class UploadfileInfo extends DataClass {
    @JsonProperty()
    @JsonClassType({type: () => [Array, [Uploadfile]]})
    private fUploadfiles: Uploadfile[] = [];

    public toByteArray(): Uint8Array {
        try {
            const jsonStr = JSON.stringify(this);
            return new TextEncoder().encode(jsonStr);
        } catch (e: any) {
            throw new Error(e);
        }
    }

    public parse(buf: Uint8Array): UploadfileInfo {
        const jsonStr = new TextDecoder('utf-8').decode(buf);
        const uploadfileInfo = JSON.parse(jsonStr);
        if (uploadfileInfo === null) {
            return this;
        }
        this.fUploadfiles = uploadfileInfo.getfUploadfiles();
        return this;
    }

    public getfUploadfiles(): Uploadfile[] {
        return this.fUploadfiles;
    }

    public setfUploadfiles(fUploadfiles: Uploadfile[]): void {
        this.fUploadfiles = fUploadfiles;
    }
}
