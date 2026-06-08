import { ECKey } from '../../src/net/bigtangle/core/ECKey';

export class UtilBase {
    /**
     * Creates a new ECKey with both private and public keys for testing purposes.
     * This avoids the "Public key is not available" errors in serialization tests.
     */
    public static createTestKey(): ECKey {
        // Create a new key with both private and public keys
        return ECKey.createNewKey(true);
    }
}
