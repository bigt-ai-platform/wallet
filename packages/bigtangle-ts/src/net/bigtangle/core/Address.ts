;
import { Utils } from './Utils.js';
import { NetworkParameters } from '../params/NetworkParameters';
import { Sha256Hash } from './Sha256Hash.js';
import { AddressFormatException } from '../exception/AddressFormatException';
import { WrongNetworkException } from '../exception/WrongNetworkException';
import { ECKey } from './ECKey';
import { Script } from '../script/Script';

export class Address {
    private readonly params: NetworkParameters;
    private readonly version: number;
    private readonly hash160: Uint8Array;

    public static fromKey(params: NetworkParameters, key: ECKey): Address {
        return Address.fromP2PKH(params, new Uint8Array(key.getPubKeyHash()));
    }

    constructor(params: NetworkParameters, version: number, hash160: Uint8Array) {
        this.params = params;
        this.version = version;
        this.hash160 = hash160;
    }

    public static fromP2SHHash(params: NetworkParameters, hash160: Uint8Array): Address {
        return new Address(params, params.getP2SHHeader(), hash160);
    }

    public static fromP2PKH(params: NetworkParameters, hash160: Uint8Array): Address {
        return new Address(params, params.getAddressHeader(), hash160);
    }

    public getVersion(): number {
        return this.version;
    }

    public getHash160(): Uint8Array {
        return this.hash160;
    }

    public isP2SHAddress(): boolean {
        return this.version === this.params.getP2SHHeader();
    }

    public static fromBase58(params: NetworkParameters, base58: string): Address {
        let bytes: Uint8Array;
        try {
            bytes = Utils.base58ToBytes(base58);
        } catch (e) {
            throw new AddressFormatException(e instanceof Error ? e.message : String(e));
        }
        if (bytes.length < 5) {
            throw new AddressFormatException('Address is too short');
        }

        const version = bytes[0] & 0xFF;
        const hash160 = bytes.slice(1, bytes.length - 4);

        if (!Address.isAcceptableVersion(params, version)) {
            throw new WrongNetworkException(version, params.getAcceptableAddressCodes());
        }

        const checksum = Sha256Hash.hashTwice(new Uint8Array(bytes.slice(0, bytes.length - 4))) .subarray(0, 4);
        if (!Utils.arraysEqual(new Uint8Array(bytes.slice(bytes.length - 4)), checksum)) {
            throw new AddressFormatException('Checksum does not validate');
        }

        return new Address(params, version, new Uint8Array(hash160));
    }

    public toBase58(): string {
        const bytes = new Uint8Array(21);
        bytes[0] = this.version;
        bytes.set(this.hash160.subarray(0, 20), 1);

        const checksum = Sha256Hash.hashTwice(bytes) .slice(0, 4);
        const combined = new Uint8Array(bytes.length + checksum.length);
        combined.set(bytes);
        combined.set(checksum, bytes.length);
        return Utils.bytesToBase58(combined);
    }

    private static isAcceptableVersion(params: NetworkParameters, version: number): boolean {
        return params.getAcceptableAddressCodes().includes(version);
    }

    public toString(): string {
        return this.toBase58();
    }

    public equals(other: Address): boolean {
        return this.params === other.params && 
               this.version === other.version && 
               Utils.arraysEqual(this.hash160, other.hash160);
    }
  compareTo(other: Address): number {
    const thisBytes = this.getHash160();
    const otherBytes = other.getHash160();
    for (let i = 0; i < Math.min(thisBytes.length, otherBytes.length); i++) {
        if (thisBytes[i] !== otherBytes[i]) {
            return thisBytes[i] - otherBytes[i];
        }
    }
    return thisBytes.length - otherBytes.length;
  }

  static fromP2PKHScript(params: NetworkParameters, script: Uint8Array): Address | null {
    try {
        const scriptObj = new Script(script);
        if (scriptObj.isSentToAddress()) {
            const pubKeyHash = scriptObj.getPubKeyHash();
            return Address.fromP2PKH(params, new Uint8Array(pubKeyHash));
        }
        return null;
    } catch (e) {
        return null;
    }
  }
}
