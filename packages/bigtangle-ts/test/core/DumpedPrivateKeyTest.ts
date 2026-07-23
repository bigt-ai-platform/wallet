import { PQKey } from '../../src/net/bigtangle/crypto/pq/PQKey';

import { describe, test, expect } from 'vitest';

describe('PQKeyTest', () => {
    test('cloning via createNew', () => {
        const key = PQKey.createNew();
        expect(key).toBeDefined();
        expect(key.hasPrivateKey()).toBe(true);
        expect(key.getPublicKeyBytes().length).toBeGreaterThan(0);
    });

    test('deterministic key', () => {
        const seed = new Uint8Array(64);
        seed[63] = 1;
        const key = PQKey.fromKeyMaterial(seed);
        expect(key).toBeDefined();
        expect(key.hasPrivateKey()).toBe(true);
    });
});
