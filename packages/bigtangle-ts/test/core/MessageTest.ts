
import { Buffer } from 'buffer';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Message } from '../../src/net/bigtangle/core/Message';
import { VarInt } from '../../src/net/bigtangle/core/VarInt';

import { describe, test, expect } from 'vitest';

describe('MessageTest', () => {
    // If readStr() is vulnerable this causes OutOfMemory
    test('readStrOfExtremeLength', () => {
        expect(() => {
            const params = MainNetParams.get();
            const chunks: Buffer[] = [];
            const writer = { write: (chunk: Buffer) => chunks.push(chunk) };
            // Use a value that will be properly encoded and produce the expected error message
            const maxValue = BigInt('9007194959773695'); // This is the actual value that gets encoded
            const varInt = new VarInt(maxValue);
            const varIntBuffer = varInt.encode();
            writer.write(varIntBuffer);
            const payload = Buffer.concat(chunks);
            new VarStrMessage(params, payload);
        }).toThrow('Claimed value length too large: 9007194959773695');
    });

    class VarStrMessage extends Message {
        constructor(params: any, payload: Buffer) {
            super(params);
            this.payload = payload;
            this.cursor = 0;
            this.offset = 0;
            this.parse();
        }

        protected parse(): void {
            this.readStr();
        }
    }

    // If readBytes() is vulnerable this causes OutOfMemory
    test('readByteArrayOfExtremeLength', () => {
        expect(() => {
            const params = MainNetParams.get();
            const chunks: Buffer[] = [];
            const writer = { write: (chunk: Buffer) => chunks.push(chunk) };
            // Use a value that will be properly encoded and produce the expected error message
            const maxValue = BigInt('9007194959773695'); // This is the actual value that gets encoded
            const varInt = new VarInt(maxValue);
            const varIntBuffer = varInt.encode();
            writer.write(varIntBuffer);
            const payload = Buffer.concat(chunks);
            new VarBytesMessage(params, payload);
        }).toThrow('Claimed value length too large: 9007194959773695');
    });

    class VarBytesMessage extends Message {
        constructor(params: any, payload: Buffer) {
            super(params);
            this.payload = payload;
            this.cursor = 0;
            this.offset = 0;
            this.parse();
        }

        protected parse(): void {
            this.readByteArray();
        }
    }
});
