import {
    OP_0, OP_PUSHDATA1, OP_PUSHDATA2, OP_PUSHDATA4, OP_1NEGATE, OP_1, OP_16,
    getOpCodeName, getPushDataName
} from './ScriptOpCodes';
import { Utils } from '../utils/Utils';
import { ScriptUtils } from './ScriptUtils'; // Use ScriptUtils instead of Script
import { UnsafeByteArrayOutputStream } from '../core/UnsafeByteArrayOutputStream'; // For OutputStream equivalent

/**
 * A script element that is either a data push (signature, pubkey, etc) or a non-push (logic, numeric, etc) operation.
 */
export class ScriptChunk {
    /** Operation to be executed. Opcodes are defined in {@link ScriptOpCodes}. */
    readonly opcode: number;
    /**
     * For push operations, this is the vector to be pushed on the stack. For {@link ScriptOpCodes#OP_0}, the vector is
     * empty. Null for non-push operations.
     */
    readonly data: Uint8Array | null;
    private startLocationInProgram: number;

    constructor(opcode: number, data: Uint8Array | null, startLocationInProgram: number = -1) {
        this.opcode = opcode;
        this.data = data;
        this.startLocationInProgram = startLocationInProgram;
    }

    equalsOpCode(opcode: number): boolean {
        return opcode === this.opcode;
    }

    /**
     * Returns true if this opcode represents a small number (OP_0 to OP_16, OP_1NEGATE)
     */
    private isSmallNumOpCode(opcode: number): boolean {
        return opcode === OP_0 || 
               opcode === OP_1NEGATE || 
               (opcode >= OP_1 && opcode <= OP_16);
    }

    /**
     * If this chunk is a single byte of non-pushdata content (could be OP_RESERVED or some invalid Opcode)
     */
    isOpCode(): boolean {
        // Opcodes are any value that is not a pushdata operation and not a small number opcode
        return !this.isPushData();
    }

    /**
     * Returns true if this chunk is pushdata content, including the single-byte pushdatas.
     */
    isPushData(): boolean {
        // Valid push operations:
        // 1. OP_0, OP_1-OP_16, OP_1NEGATE (handled by isSmallNumOpCode)
        // 2. Single-byte push operations (1-75 bytes) - only for actual data pushes
        // 3. Explicit push data opcodes (OP_PUSHDATA1, OP_PUSHDATA2, OP_PUSHDATA4)
        
        // First, check if it's a small number opcode
        if (this.isSmallNumOpCode(this.opcode)) {
            return true;
        }
        
        // Check for explicit push data opcodes
        if (this.opcode === OP_PUSHDATA1 || 
            this.opcode === OP_PUSHDATA2 || 
            this.opcode === OP_PUSHDATA4) {
            return true;
        }
        
        // Check for single-byte push operations (1-75 bytes)
        // Only return true if this is an actual data push (data exists)
        if (this.opcode > 0 && this.opcode <= 75 && this.data !== null) {
            return true;
        }
        
        return false;
    }

    getStartLocationInProgram(): number {
        if (this.startLocationInProgram < 0) {
            throw new Error("startLocationInProgram is not set for this chunk.");
        }
        return this.startLocationInProgram;
    }

    /** If this chunk is an OP_N opcode returns the equivalent integer value. */
    decodeOpN(): number {
        if (!this.isOpCode()) {
            throw new Error("decodeOpN called on a non-opcode chunk.");
        }
        return ScriptUtils.decodeFromOpN(this.opcode);
    }

    /**
     * Called on a pushdata chunk, returns true if it uses the smallest possible way (according to BIP62) to push the data.
     */
    isShortestPossiblePushData(): boolean {
        if (!this.isPushData()) {
            throw new Error("isShortestPossiblePushData called on a non-pushdata chunk.");
        }
        if (this.data === null) {
            return true;   // OP_N
        }
        if (this.data.length === 0) {
            return this.opcode === OP_0;
        }
        if (this.data.length === 1) {
            const b = this.data[0];
            if (b >= 0x01 && b <= 0x10) {
                return this.opcode === OP_1 + b - 1;
            }
            if ((b & 0xFF) === 0x81) {
                return this.opcode === OP_1NEGATE;
            }
        }
        if (this.data.length < OP_PUSHDATA1) {
            return this.opcode === this.data.length;
        }
        if (this.data.length < 256) {
            return this.opcode === OP_PUSHDATA1;
        }
        if (this.data.length < 65536) {
            return this.opcode === OP_PUSHDATA2;
        }

        // can never be used, but implemented for completeness
        return this.opcode === OP_PUSHDATA4;
    }

    write(stream: UnsafeByteArrayOutputStream): void {
        if (this.isOpCode()) {
            if (this.data !== null) {
                throw new Error("Opcode chunk should not have data.");
            }
            stream.writeByte(this.opcode);
        } else if (this.data !== null) {
            if (this.opcode < OP_PUSHDATA1) {
                if (this.data.length !== this.opcode) {
                    throw new Error("Data length mismatch for small pushdata opcode.");
                }
                stream.writeByte(this.opcode);
            } else if (this.opcode === OP_PUSHDATA1) {
                if (this.data.length > 0xFF) {
                    throw new Error("Data length too large for OP_PUSHDATA1.");
                }
                stream.writeByte(OP_PUSHDATA1);
                stream.writeByte(this.data.length);
            } else if (this.opcode === OP_PUSHDATA2) {
                if (this.data.length > 0xFFFF) {
                    throw new Error("Data length too large for OP_PUSHDATA2.");
                }
                stream.writeByte(OP_PUSHDATA2);
                stream.writeByte(this.data.length & 0xFF);
                stream.writeByte((this.data.length >> 8) & 0xFF);
            } else if (this.opcode === OP_PUSHDATA4) {
                if (this.data.length > ScriptUtils.MAX_SCRIPT_ELEMENT_SIZE) { // Use ScriptUtils.MAX_SCRIPT_ELEMENT_SIZE
                    throw new Error("Data length too large for OP_PUSHDATA4.");
                }
                stream.writeByte(OP_PUSHDATA4);
                Utils.uint32ToByteStreamLE(this.data.length, stream);
            } else {
                // Handle any other opcodes by writing the opcode byte and then the data
                stream.writeByte(this.opcode);
            }
            stream.write(new Uint8Array(this.data));
        } else if (this.isSmallNumOpCode(this.opcode)) {
            // This case is for small numbers (OP_0, OP_1 to OP_16, OP_1NEGATE) where data is null
            stream.writeByte(this.opcode);
        } else {
            // Handle any other opcodes that don't have data and aren't small numbers
            stream.writeByte(this.opcode);
        }
    }

    toString(): string {
        let buf = "";
        if (this.isOpCode()) {
            buf += getOpCodeName(this.opcode);
        } else if (this.isSmallNumOpCode(this.opcode)) {
            // Small num (e.g., OP_0, OP_1, OP_1NEGATE)
            buf += ScriptUtils.decodeFromOpN(this.opcode).toString();
        } else if (this.data !== null) {
            // Data chunk
            buf += getPushDataName(this.opcode) + "[" + Utils.HEX.encode(this.data) + "]";
        } else {
            // This case shouldn't happen with properly constructed chunks
            buf += getPushDataName(this.opcode);
        }
        return buf;
    }

    equals(o: any): boolean {
        if (this === o) return true;
        if (o == null || !(o instanceof ScriptChunk)) return false;
        const other = o as ScriptChunk;
        return this.opcode === other.opcode && this.startLocationInProgram === other.startLocationInProgram
            && Utils.arraysEqual(this.data || new Uint8Array(), other.data || new Uint8Array()); // Handle null data
    }

    hashCode(): number {
        return (this.opcode * 31 + this.startLocationInProgram) * 31 + Utils.hashCode(this.data || new Uint8Array());
    }
}
