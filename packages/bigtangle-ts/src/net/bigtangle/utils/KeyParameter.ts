/**
 * Represents a key parameter for cryptographic operations.
 * Unified interface for both crypto and utils modules.
 */
export class KeyParameter {
    constructor(public key: Uint8Array) {}
}
