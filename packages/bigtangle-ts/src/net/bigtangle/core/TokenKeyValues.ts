import { KeyValue } from './KeyValue';
import { JsonProperty } from 'jackson-js';

export class TokenKeyValues {
    @JsonProperty()
    private keyvalues: KeyValue[] | null = null;

    public addKeyvalue(kv: KeyValue): void {
        this.keyvalues ??= [];
        this.keyvalues.push(kv);
    }

    public toByteArray(): Uint8Array {
        try {
            const jsonStr = JSON.stringify(this);
            return new TextEncoder().encode(jsonStr);
        } catch (e: any) {
            throw new Error(e);
        }
    }

    public static parse(buf: Uint8Array): TokenKeyValues {
        const jsonStr = new TextDecoder('utf-8').decode(buf);
        return JSON.parse(jsonStr);
    }

    public getKeyvalues(): KeyValue[] | null {
        return this.keyvalues;
    }
}
