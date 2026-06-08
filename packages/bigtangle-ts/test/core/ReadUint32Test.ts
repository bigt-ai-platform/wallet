import { Buffer } from 'buffer';
import { describe, test, expect } from 'vitest';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Message } from '../../src/net/bigtangle/core/Message';

describe('ReadUint32Test', () => {
    class TestMessage extends Message {
        constructor(params: any, payload: Buffer) {
            super(params);
            this.payload = payload;
            this.cursor = 0;
            this.offset = 0;
            this.length = payload.length;
        }

        protected parse(): void {
            // This will try to read a uint32 from an empty buffer
            this.readUint32();
        }

        public testReadUint32(): number {
            return this.readUint32();
        }
    }

    test('testReadUint32FromEmptyBuffer', () => {
        const params = MainNetParams.get();
        const emptyPayload = Buffer.alloc(0);
        const message = new TestMessage(params, emptyPayload);
        
        expect(() => {
            message.testReadUint32();
        }).toThrow(); // Should throw an error because there are no bytes to read
    });

    test('testReadUint32FromBufferWithInsufficientBytes', () => {
        const params = MainNetParams.get();
        // Create a buffer with only 3 bytes (need 4 for uint32)
        const shortPayload = Buffer.from([0x01, 0x02, 0x03]);
        const message = new TestMessage(params, shortPayload);
        
        expect(() => {
            message.testReadUint32();
        }).toThrow(); // Should throw an error because there aren't enough bytes
    });
});
