import { BasicKeyChain } from '../../src/net/bigtangle/wallet/BasicKeyChain';
import { ECKey } from '../../src/net/bigtangle/core/ECKey';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import { describe, test, expect, beforeEach } from 'vitest';

describe('BasicKeyChainTest', () => {
    let chain: BasicKeyChain;

    beforeEach(() => {
        chain = new BasicKeyChain({
            getAddressHeader: () => 0,
            getP2SHHeader: () => 5,
            getDefaultSerializer: () => null,
            getProtocolVersionNum: () => 1,
            getMaxMessageSize: () => 1000000,
            getPacketMagic: () => 0,
        } as any);
    });

    test('importKeys', () => {
        Utils.setMockClock();
        const now = Utils.currentTimeSeconds();
        const key1 = ECKey.fromPrivate(BigInt('1'));
        Utils.rollMockClock(now);
        const key2 = ECKey.fromPrivate(BigInt('2'));
        const keys = [key1, key2];

        expect(chain.importKeys(...keys)).toBe(2);
        expect(chain.numKeys()).toBe(2);
        expect(chain.getEarliestKeyCreationTime()).toBe(now);

        const newKey = ECKey.fromPrivate(BigInt('3'));
        keys.push(newKey);
        expect(chain.importKeys(...keys)).toBe(1);
        expect(chain.importKeys(...keys)).toBe(0);

        expect(chain.hasKey(key1)).toBe(true);
        expect(chain.hasKey(key2)).toBe(true);
        expect(chain.findKeyFromPubHash(key1.getPubKeyHash())).toEqual(key1);
        expect(chain.findKeyFromPubKey(key2.getPubKey())).toEqual(key2);
        expect(chain.findKeyFromPubKey(key2.getPubKeyHash())).toBeNull();
    });

    test('removeKey', () => {
        const key = ECKey.fromPrivate(BigInt('1'));
        chain.importKeys(key);
        expect(chain.numKeys()).toBe(1);
        expect(chain.removeKey(key)).toBe(true);
        expect(chain.numKeys()).toBe(0);
        expect(chain.removeKey(key)).toBe(false);
    });

    // Removed encryption-related tests as they're not supported by BasicKeyChain

    test('watching', () => {
        const key1 = ECKey.createNewKey();
        const pub = ECKey.fromPublic(key1.getPubKey());
        chain.importKeys(pub);
        expect(chain.numKeys()).toBe(1);
        expect(chain.findKeyFromPubKey(pub.getPubKey())?.isPubKeyOnly()).toBe(true);
    });

    test('bloom', () => {
        const key1 = ECKey.createNewKey();
        const key2 = ECKey.createNewKey();
        chain.importKeys(key1, key2);
        expect(chain.numKeys()).toBe(2);
        expect(chain.numBloomFilterEntries()).toBe(4);
        // Use a larger filter to reduce false positives
        const filter = chain.getFilter(100, 0.000001, 100);
        expect(filter.contains(key1.getPubKey())).toBe(true);
        expect(filter.contains(key1.getPubKeyHash())).toBe(true);
        expect(filter.contains(key2.getPubKey())).toBe(true);
        expect(filter.contains(key2.getPubKeyHash())).toBe(true);
        const key3 = ECKey.createNewKey();
        expect(filter.contains(key3.getPubKey())).toBe(false);
    });

    test('keysBeforeAndAfter', () => {
        const now = Utils.currentTimeSeconds();
        const key1 = ECKey.createNewKey();
        key1.setCreationTimeSeconds(now);
        const key1Creation = key1.getCreationTimeSeconds();
        const key2 = ECKey.createNewKey();
        key2.setCreationTimeSeconds(now + 86400);
        const key2Creation = key2.getCreationTimeSeconds();
        const keys = [key1, key2];
        expect(chain.importKeys(...keys)).toBe(2);

        expect(chain.findOldestKeyAfter(key2Creation + 1)).toBeNull();
        expect(chain.findOldestKeyAfter(key1Creation - 1)?.getCreationTimeSeconds()).toEqual(key1.getCreationTimeSeconds());
        expect(chain.findOldestKeyAfter(key2Creation - 1)?.getCreationTimeSeconds()).toEqual(key2.getCreationTimeSeconds());

        expect(chain.findKeysBefore(now + 86400 * 2).length).toBe(2);
        expect(chain.findKeysBefore(key1Creation + 1).length).toBe(1);
        expect(chain.findKeysBefore(key2Creation - 1).length).toBe(1);
        expect(chain.findKeysBefore(key2Creation + 1).length).toBe(2);
        expect(chain.findKeysBefore(now - 1).length).toBe(0);
    });
});
