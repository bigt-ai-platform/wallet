import { NetworkParameters } from './NetworkParameters.js';

export class MainNetParams extends NetworkParameters {
    private packetMagic: number = 0xf9beb4d9;

    getP2SHHeader(): number {
        return 5;
    }

    getAddressHeader(): number {
        return 0;
    }

    getAcceptableAddressCodes(): number[] {
        return [this.getAddressHeader(), this.getP2SHHeader()];
    }
    
    getId(): string {
        return NetworkParameters.ID_MAINNET;
    }

    getPacketMagic(): number {
        return this.packetMagic;
    }

    getMaxTarget(): bigint {
        return BigInt("578960377169117509212217050695880916496095398817113098493422368414323410");
    }
 
    getProtocolVersionNum(version: number): number {
        return version;
    }

    getBip32HeaderPub(): number {
        return 0x0488B21E;
    }

    getBip32HeaderPriv(): number {
        return 0x0488ADE4;
    }

    getDumpedPrivateKeyHeader(): number {
        return 128;
    }

    serverSeeds(): string[] {
        return ["seed1.bigtangle.org", "seed2.bigtangle.org"];
    }

    getGenesisPub(): string {
        return "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f";
    }

    static get(): MainNetParams {
        return new MainNetParams();
    }
}
