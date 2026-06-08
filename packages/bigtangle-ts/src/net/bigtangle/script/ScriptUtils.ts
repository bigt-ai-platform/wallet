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
}
