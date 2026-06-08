import { DumpedPrivateKey } from '../../src/net/bigtangle/core/DumpedPrivateKey';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';

import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { describe, test, expect } from 'vitest';

// Minimal mock network parameters for testing
class MockNetworkParameters extends NetworkParameters {
    getP2SHHeader(): number { return 0; }
    getAddressHeader(): number { return 0; }
    // Implement getDumpedPrivateKeyHeader as required
    getDumpedPrivateKeyHeader(): number { return 128; }
    getAcceptableAddressCodes(): number[] { return [0]; }
    getId(): string { return 'mock'; }
    getMaxTarget(): bigint { return BigInt(0); }
    getDefaultSerializer(): any { return null; }
    getProtocolVersionNum(version: number): number { return version; }
    getBip32HeaderPub(): number { return 0; }
    getBip32HeaderPriv(): number { return 0; }
    serverSeeds(): string[] { return []; }
    getGenesisPub(): string { return ""; }
    
    // Implement all abstract methods from NetworkParameters
    getPort(): number { return 8080; }
    getPacketMagic(): number { return 0; }
    getInterval(): number { return 10; }
    getTargetTimespan(): number { return 1000; }
    getKeyPrefix(): string { return "mock"; }
    getUriScheme(): string { return "mock"; }
    getProofOfWorkLimit(): bigint { return BigInt(0); }
    getDNSSeeds(): string[] { return []; }
    getHttpSeeds(): string[] { return []; }
    getCheckpoints(): any[] { return []; }
    getSubsidyDecreaseBlockCount(): number { return 100000; }
    getSpendableCoinbaseDepth(): number { return 100; }
    getMaxBlockSize(): number { return 1000000; }
    getMaxBlockSizeLong(): bigint { return BigInt(1000000); }
    getAveragingWindowTimespan(): number { return 100; }
    getMinActualTimespan(): number { return 50; }
    getMaxActualTimespan(): number { return 200; }
    getRetargetTimespan(): number { return 100; }
    getRetargetTimespanV2(): number { return 100; }
    getMinDifficulty(): bigint { return BigInt(0); }
    getMaxDifficulty(): bigint { return BigInt(1000000); }
    getMaxMoney(): bigint { return BigInt(21000000); }
    getDefaultPort(): number { return 8080; }
    getDnsSeeds(): string[] { return []; }
    getHttpSeedsList(): string[] { return []; }
    getAddrSeeds(): any[] { return []; }
    getFirstGoodBlock(): number { return 0; }
    getFirstGoodBlockV2(): number { return 0; }
    getGenesisBlock(): any { return null; }
    getGenesisBlockInfo(): any { return null; }
    getGenesisPubkey(): string { return ""; }
    getGenesisBlockReward(): bigint { return BigInt(0); }
    getMajorityEnforceBlockUpgrade(): number { return 750; }
    getMajorityRejectBlockOutdated(): number { return 950; }
    getMajorityWindow(): number { return 1000; }
    getBip34Height(): number { return 0; }
    getBip34Hash(): string { return ""; }
    getRuleChangeActivationThreshold(): number { return 1916; }
    getMinerConfirmationWindow(): number { return 2016; }
    getDeploymentStableHeight(): number { return 0; }
    getDeploymentTestDummyHeight(): number { return 0; }
    getDeploymentCSVHeight(): number { return 0; }
    getDeploymentSegwitHeight(): number { return 0; }
    getDeploymentTestDummy(): any { return null; }
    getDeploymentCSV(): any { return null; }
    getDeploymentSegwit(): any { return null; }
    getCashAddrPrefix(): string { return "bitcoincash"; }
    getCashAddrPrefixSeparator(): string { return ":"; }
    getCashAddrChecksumLength(): number { return 8; }
    getCashAddrTypeBitsSize(): number { return 8; }
    getCashAddrHashBitsSize(): number { return 160; }
    getCashAddrMaxAddressLength(): number { return 54; }
    getCashAddrMinAddressLength(): number { return 14; }
    getCashAddrPadding(): string { return "q"; }
    getCashAddrAlphabet(): string { return "qpzry9x8gf2tvdw0s3jn54khce6mua7l"; }
    getCashAddrVersionByteBase(): number { return 0; }
    getCashAddrVersionByteP2KH(): number { return 0; }
    getCashAddrVersionByteP2SH(): number { return 8; }
    getCashAddrVersionByteTokenP2KH(): number { return 16; }
    getCashAddrVersionByteTokenP2SH(): number { return 24; }
    getCashAddrVersionByteSize(): number { return 8; }
    getCashAddrTypeBitsP2KH(): number { return 0; }
    getCashAddrTypeBitsP2SH(): number { return 8; }
    getCashAddrTypeBitsTokenP2KH(): number { return 16; }
    getCashAddrTypeBitsTokenP2SH(): number { return 24; }
}

describe('DumpedPrivateKeyTest', () => {
    const mockParams = new MockNetworkParameters();

    test('cloning', () => {
        const ecKey = ECKey.fromPrivate(BigInt('1'));
        // Get raw private key bytes without padding
        const privKeyBytes = ECKey.bigIntToBytes(ecKey.getPrivKey(), 32);
        const a = new DumpedPrivateKey(mockParams, new Uint8Array(privKeyBytes), true);
        const b = a.clone();

        expect(a).toEqual(b);
        expect(a).not.toBe(b);
    });

    test('roundtripBase58', () => {
        const base58 = '5HtUCLMFWNueqN9unpgX2DzjMg6SDNZyKRb8s3LJgpFg5ubuMrk';
        const key = DumpedPrivateKey.parseBase58(mockParams, base58);
        expect(key.toBase58()).toBe(base58);
    });
});
