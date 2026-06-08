import { Message } from './Message';
import { Block } from './Block';
import { Transaction } from './Transaction';
import { AlertMessage } from './AlertMessage';
import { Gzip } from '../utils/Gzip';
;

/**
 * Generic interface for classes which serialize/deserialize messages.
 * Implementing classes should be immutable.
 */
export abstract class MessageSerializer<T> {
    protected params: T;
    protected parseRetain: boolean;

    constructor(params: T, parseRetain: boolean) {
        this.params = params;
        this.parseRetain = parseRetain;
    }

    /**
     * Reads a message from the given ByteBuffer and returns it.
     */
    public abstract deserialize(inBuffer: Uint8Array): Message;

    /**
     * Whether the serializer will produce cached mode Messages
     */
    public isParseRetainMode(): boolean {
        return this.parseRetain;
    }

    /**
     * Make an alert message from the payload. Extension point for alternative
     * serialization format support.
     */
    public abstract makeAlertMessage(payloadBytes: Uint8Array): AlertMessage;

    /**
     * Make a block from the payload, using an offset of zero and the payload length
     * as block length.
     */
    public makeBlock(payloadBytes: Uint8Array): Block;
    /**
     * Make a block from the payload, using an offset of zero and the provided
     * length as block length.
     */
    public makeBlock(payloadBytes: Uint8Array, length: number): Block;
    /**
     * Make a block from the payload, using an offset of zero and the provided
     * length as block length. Extension point for alternative serialization format
     * support.
     */
    public makeBlock(payloadBytes: Uint8Array, offset: number, length: number): Block;
    public makeBlock(...args: any[]): Block {
        if (args.length === 1) {
            return this.makeBlock(args[0], 0, args[0].length);
        } else if (args.length === 2) {
            return this.makeBlock(args[0], 0, args[1]);
        } else if (args.length === 3) {
            // This method should be implemented by subclasses
            throw new Error("Method not implemented.");
        } else {
            throw new Error("Not implemented");
        }
    }

    /**
     * Make a block from the zipped payload, using an offset of zero and the payload
     * length as block length.
     * 
     * @throws IOException
     */
    public async makeZippedBlock(payloadBytes: Uint8Array): Promise<Block> {
        // Assuming decompress is not implemented, use a placeholder or implement decompress in Gzip
        const unzippedUint8Array = await Gzip.decompress(payloadBytes);
        const unzipped = new Uint8Array(unzippedUint8Array);
        return this.makeBlock(unzipped, 0, unzipped.length);
    }

    /**
     * Make a block from the zipped payload, using an offset of zero and the payload
     * length as block length.
     * 
     * @throws IOException
     */
    public async makeZippedBlockStream(inputStream: any): Promise<Block | null> {
        if (inputStream === null) {
            return null; // Return null if no value available.
        }
        const unzippedUint8Array = await Gzip.decompress(inputStream);
        const unzipped = new Uint8Array(unzippedUint8Array);
        return this.makeBlock(unzipped, 0, unzipped.length);
       
    }

  
    /**
     * Make a transaction from the payload. Extension point for alternative
     * serialization format support.
     * 
     * @throws UnsupportedOperationException if this serializer/deserializer does
     *                                       not support deserialization. This can
     *                                       occur either because it's a dummy
     *                                       serializer (i.e. for messages with no
     *                                       network parameters), or because it does
     *                                       not support deserializing transactions.
     */
    public abstract makeTransaction(payloadBytes: Uint8Array): Transaction;

    /**
     * Make a transaction from the payload. Extension point for alternative
     * serialization format support.
     * 
     * @throws UnsupportedOperationException if this serializer/deserializer does
     *                                       not support deserialization. This can
     *                                       occur either because it's a dummy
     *                                       serializer (i.e. for messages with no
     *                                       network parameters), or because it does
     *                                       not support deserializing transactions.
     */
    public makeTransactionFromBytes(payloadBytes: Uint8Array): Transaction;
    public makeTransactionFromBytes(payloadBytes: Uint8Array, offset: number): Transaction;
    public makeTransactionFromBytes(payloadBytes: Uint8Array): Transaction;
    public makeTransactionFromBytes(payloadBytes: Uint8Array, offset: number): Transaction;
    public makeTransactionFromBytes(...args: any[]): Transaction {
        if (args.length === 1) {
            return this.makeTransaction(args[0]);
        } else if (args.length === 2) {
            return this.makeTransaction(args[0].slice(args[1]));
        } else {
            throw new Error("Not implemented");
        }
    }

    public abstract seekPastMagicBytes(inBuffer: Uint8Array): Uint8Array;

    /**
     * Writes message to to the output stream.
     * 
     * @throws UnsupportedOperationException if this serializer/deserializer does
     *                                       not support serialization. This can
     *                                       occur either because it's a dummy
     *                                       serializer (i.e. for messages with no
     *                                       network parameters), or because it does
     *                                       not support serializing the given
     *                                       message.
     */
    public abstract serialize(name: string, message: any, out: any, offset?: number, length?: number, hash?: Uint8Array | null): void;

    /**
     * Writes message to to the output stream.
     * 
     * @throws UnsupportedOperationException if this serializer/deserializer does
     *                                       not support serialization. This can
     *                                       occur either because it's a dummy
     *                                       serializer (i.e. for messages with no
     *                                       network parameters), or because it does
     *                                       not support serializing the given
     *                                       message.
     */
    public abstract serializeMessage(message: Message, out: any): void;
}
