import { DataClass } from './DataClass';
import { Tokensums } from './Tokensums';
import { Sha256Hash } from './Sha256Hash';
import { Utils } from '../utils/Utils';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty, JsonClassType } from "jackson-js";

export class TokensumsMap extends DataClass {
    @JsonProperty()
    @JsonClassType({type: () => [Map, [String, Tokensums]]})
    private tokensumsMap: Map<string, Tokensums>;

    constructor() {
        super();
        this.tokensumsMap = new Map<string, Tokensums>();
    }

    public hash(): Sha256Hash {
        return Sha256Hash.of(new Uint8Array(this.toByteArray()));
    }

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            const superBytes = new Uint8Array(super.toByteArray());
            baos.writeBytes(superBytes, 0, superBytes.length);
            // Sort keys to ensure consistent serialization
            const sortedKeys = Array.from(this.tokensumsMap.keys()).sort((a, b) => a.localeCompare(b));
            for (const key of sortedKeys) {
                Utils.writeNBytesString(baos, key);
                const tokensumsBytes = new Uint8Array(this.tokensumsMap.get(key)!.toByteArray());
                baos.writeBytes(tokensumsBytes, 0, tokensumsBytes.length);
            }
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }

    public getTokensumsMap(): Map<string, Tokensums> {
        return this.tokensumsMap;
    }

    public setTokensumsMap(tokensumsMap: Map<string, Tokensums>): void {
        this.tokensumsMap = tokensumsMap;
    }
}
