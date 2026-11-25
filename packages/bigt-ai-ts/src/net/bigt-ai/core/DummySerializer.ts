import { MessageSerializer } from './MessageSerializer';
import { Message } from './Message';
import { Block } from './Block';
import { Transaction } from './Transaction';
import { AlertMessage } from './AlertMessage';
import { BloomFilter } from './BloomFilter';
;

/**
 * Dummy serializer used ONLY for objects which do not have network parameters
 * set.
 */
export class DummySerializer extends MessageSerializer<null> {
    public serializeMessage(message: Message, out: any): void {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }
    public static readonly DEFAULT = new DummySerializer();

    private static readonly DEFAULT_EXCEPTION_MESSAGE = "Dummy serializer cannot serialize/deserialize objects as it does not know which network they belong to.";

    constructor() {
        super(null, false); // Pass null for params and false for parseRetain as it's a dummy
    }

    deserialize(inBuffer: Uint8Array): Message {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }

    makeAlertMessage(payloadBytes: Uint8Array): AlertMessage {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }

    makeBlock(payloadBytes: Uint8Array): Block;
    makeBlock(payloadBytes: Uint8Array, length: number): Block;
    makeBlock(payloadBytes: Uint8Array, offset: number, length: number): Block;
    makeBlock(payloadBytes: Uint8Array, arg2?: number, arg3?: number): Block {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }

    makeBloomFilter(payloadBytes: Uint8Array): BloomFilter {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }

    makeTransaction(payloadBytes: Uint8Array, offset: number = 0, length: number = payloadBytes.length, hash: Uint8Array | null = null): Transaction {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }

    seekPastMagicBytes(inBuffer: Uint8Array): Uint8Array {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }

    serialize(message: Message): Uint8Array;
    serialize(name: string, message: Uint8Array): Uint8Array;
    serialize(...args: any[]): Uint8Array {
        throw new Error(DummySerializer.DEFAULT_EXCEPTION_MESSAGE);
    }
}
