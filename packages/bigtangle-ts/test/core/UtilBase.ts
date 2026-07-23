import { PQKey } from '../../src/net/bigtangle/crypto/pq/PQKey';
import { Utils } from '../../src/net/bigtangle/utils/Utils';

export class UtilBase {
    public static createTestKey(): PQKey {
        return PQKey.createNew();
    }

    public static createTestKeyFromBigInt(n: bigint): PQKey {
        const seed = new Uint8Array(64);
        let v = n;
        for (let i = 63; i >= 0 && v > 0n; i--) {
            seed[i] = Number(v & 0xffn);
            v >>= 8n;
        }
        return PQKey.fromKeyMaterial(seed);
    }

    public static createTestKeyFromHex(hex: string): PQKey {
        const bytes = new Uint8Array(Utils.HEX.decode(hex));
        if (bytes.length >= 64) return PQKey.fromKeyMaterial(bytes);
        const padded = new Uint8Array(64);
        padded.set(bytes, 0);
        return PQKey.fromKeyMaterial(padded);
    }
}
