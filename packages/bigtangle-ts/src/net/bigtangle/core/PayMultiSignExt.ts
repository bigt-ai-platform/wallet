import { PayMultiSign } from './PayMultiSign';
import { JsonProperty } from "jackson-js";

export class PayMultiSignExt extends PayMultiSign {
  
    @JsonProperty() private realSignnumber: number = 0;

    

    public getRealSignnumber(): number {
        return this.realSignnumber;
    }

    public setRealSignnumber(realSignnumber: number): void {
        this.realSignnumber = realSignnumber;
    }
}