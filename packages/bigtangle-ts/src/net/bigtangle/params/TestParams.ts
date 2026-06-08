import { NetworkParameters } from './NetworkParameters.js';

export class TestParams extends NetworkParameters {
    private packetMagic: number = 0xfabfb5da;

    getP2SHHeader(): number {
        return 196; // Testnet P2SH header
    }

    getAddressHeader(): number {
        return 111; // Testnet address header
    }

    getAcceptableAddressCodes(): number[] {
        return [this.getAddressHeader(), this.getP2SHHeader()];
    }

    getId(): string {
        return 'test';
    }

    getPacketMagic(): number {
        return this.packetMagic;
    }

    getMaxTarget(): bigint {
        return BigInt("578960377169117509212217050695880916496095398817113098493422368414323410000");
    }

    
    getProtocolVersionNum(version: number): number {
        return version;
    }

    getBip32HeaderPub(): number {
        return 0x043587CF; // Testnet public key header
    }

    getBip32HeaderPriv(): number {
        return 0x04358394; // Testnet private key header
    }

    getDumpedPrivateKeyHeader(): number {
        return 239; // Testnet dumped private key header
    }

    serverSeeds(): string[] {
        return ["testseed1.bigtangle.org", "testseed2.bigtangle.org"];
    }

    getGenesisPub(): string {
        return "04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f";
    }

    static get(): TestParams {
        return new TestParams();
    }
}
