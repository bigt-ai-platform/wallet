import { sha256 } from '@noble/hashes/sha256';
import {
    OP_0, OP_1NEGATE, OP_1, OP_16
} from './ScriptOpCodes';

/**
 * Utilities for script operations
 */
export class ScriptUtils {
    /**
     * Decodes an OP_N opcode to its numeric value.
     * @param opcode The opcode to decode
     * @returns The numeric value represented by the opcode
     */
    static decodeFromOpN(opcode: number): number {
        if (opcode === OP_0) return 0;
        if (opcode >= OP_1 && opcode <= OP_16) return opcode - (OP_1 - 1);
        if (opcode === OP_1NEGATE) return -1;
        throw new Error("decodeFromOpN called on non OP_N opcode: " + opcode);
    }

    /** Maximum allowed size for a script element in bytes */
    static readonly MAX_SCRIPT_ELEMENT_SIZE = 520;

    /**
     * Magic prefix byte for PQ pubkeys on the script stack.
     * 0x05 avoids conflict with SEC1 EC key prefixes (0x02/0x03/0x04).
     */
    static readonly PQ_PUBKEY_PREFIX = 0x05;

    /** True if the first byte of the pubkey stack item is the PQ prefix. */
    static isPQPubkey(pubkey: Uint8Array): boolean {
        return pubkey != null && pubkey.length > 1 && pubkey[0] === ScriptUtils.PQ_PUBKEY_PREFIX;
    }

    /**
     * Compute a domain-separated hash: SHA-256(domain || base).
     */
    static domainSeparatedHash(base: Uint8Array, domain: string): Uint8Array {
        const domainBytes = new TextEncoder().encode(domain);
        const combined = new Uint8Array(domainBytes.length + base.length);
        combined.set(domainBytes, 0);
        combined.set(base, domainBytes.length);
        return sha256(combined);
    }
}
