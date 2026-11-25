import { AbstractResponse } from './AbstractResponse';
import { UTXO } from '../core/UTXO';
import { OutputsMulti } from '../core/OutputsMulti';
import { JsonProperty } from "jackson-js";

export class OutputsDetailsResponse extends AbstractResponse {
    @JsonProperty() private outputs: UTXO | null = null;
    @JsonProperty() private outputsMultis: OutputsMulti[] | null = null;

    public static create(outputs: UTXO): OutputsDetailsResponse;
    public static create(outputsMultis: OutputsMulti[]): OutputsDetailsResponse;
    public static create(arg: UTXO | OutputsMulti[]): OutputsDetailsResponse {
        const res = new OutputsDetailsResponse();
        if (Array.isArray(arg)) {
            res.outputsMultis = arg;
        } else {
            res.outputs = arg;
        }
        return res;
    }

    public getOutputs(): UTXO | null {
        return this.outputs;
    }

    public getOutputsMultis(): OutputsMulti[] | null {
        return this.outputsMultis;
    }
}
