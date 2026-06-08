import { MessageSerializer } from './MessageSerializer';
import { NetworkParameters } from '../params/NetworkParameters';
import { ProtocolException } from '../exception/Exceptions';
import { Message } from './Message';
import { Block } from './Block';
import { Transaction } from './Transaction';
import { AlertMessage } from './AlertMessage';
import { FilteredBlock } from './FilteredBlock';
import { HeadersMessage } from './HeadersMessage';
import { Sha256Hash } from './Sha256Hash';
import { Utils } from '../utils/Utils';
;

const MAX_MESSAGE_SIZE = 0x02000000; // 32MB
const COMMAND_LEN = 12;

export class BitcoinPacketHeader {
    /** The largest number of bytes that a header can represent */
    public static readonly HEADER_LENGTH = COMMAND_LEN + 4 + 4;

    public readonly header: Uint8Array;
    public readonly command: string;
    public readonly size: number;
    public readonly checksum: Uint8Array;

    constructor(inBuffer: Uint8Array, params: NetworkParameters) {
        // Check if the buffer is long enough to contain the header
        if (inBuffer.length < BitcoinPacketHeader.HEADER_LENGTH) {
            throw new ProtocolException(`Buffer too short to contain header: ${inBuffer.length} < ${BitcoinPacketHeader.HEADER_LENGTH}`);
        }
        
        this.header = new Uint8Array(BitcoinPacketHeader.HEADER_LENGTH);
        this.header.set(inBuffer.subarray(0, BitcoinPacketHeader.HEADER_LENGTH), 0);

        let cursor = 0;

        // The command is a NULL terminated string, unless the command fills all twelve bytes
        // in which case the termination is implicit.
        let commandEnd = 0;
        for (; commandEnd < COMMAND_LEN && this.header[commandEnd] !== 0; commandEnd++);
        this.command = new TextDecoder().decode(this.header.subarray(0, commandEnd));
        cursor = COMMAND_LEN;

        this.size = Utils.readUint32(this.header, cursor);
        cursor += 4;

        if (this.size > MAX_MESSAGE_SIZE || this.size < 0)
            throw new ProtocolException(`Message size too large: ${this.size}`);

        // Old clients don't send the checksum.
        this.checksum = new Uint8Array(4);
        // Note that the size read above includes the checksum bytes.
        this.checksum.set(this.header.subarray(cursor, cursor + 4), 0);
        cursor += 4;
    }
}

export class BitcoinSerializer extends MessageSerializer<NetworkParameters> {
    private static names: Map<Function, string> | null = null;

    private static getNames(): Map<Function, string> {
        if (BitcoinSerializer.names === null) {
            // Lazy initialization to avoid circular dependencies
            const { Block } = require('./Block');
            const { Transaction } = require('./Transaction');
            const { HeadersMessage } = require('./HeadersMessage');
            const { BloomFilter } = require('./BloomFilter');
            const { FilteredBlock } = require('./FilteredBlock');
            
            BitcoinSerializer.names = new Map<Function, string>([
                [Block, "block"],
                [Transaction, "tx"],
                [HeadersMessage, "headers"],
                [BloomFilter, "filterload"],
                [FilteredBlock, "merkleblock"]
            ]);
        }
        return BitcoinSerializer.names;
    }

    constructor(params: NetworkParameters, parseRetain: boolean) {
        super(params, parseRetain);
    }

    /**
     * Writes message to to the output stream.
     */
    public serialize(name: string, message: any, out: any, offset?: number, length?: number, hash?: Uint8Array | null): void {
        // Convert message to Buffer if it's not already
        let messageBuffer: Uint8Array;
        if (message && message.constructor && message.constructor.name === 'Buffer') {
            messageBuffer = new Uint8Array(message);
        } else if (message instanceof Uint8Array) {
            messageBuffer = message;
        } else {
            throw new Error("Message must be a Buffer or Uint8Array");
        }
        
        const header = new Uint8Array(4 + COMMAND_LEN + 4 + 4 /* checksum */);
        const packetMagic = this.params.getPacketMagic();
        header[0] = (packetMagic >>> 24) & 0xff;
        header[1] = (packetMagic >>> 16) & 0xff;
        header[2] = (packetMagic >>> 8) & 0xff;
        header[3] = packetMagic & 0xff;

        // The header array is initialized to zero by JavaScript so we don't have to worry about
        // NULL terminating the string here.
        for (let i = 0; i < name.length && i < COMMAND_LEN; i++) {
            header[4 + i] = name.charCodeAt(i) & 0xFF;
        }

        const len = messageBuffer.length;
        header[4 + COMMAND_LEN] = len & 0xff;
        header[4 + COMMAND_LEN + 1] = (len >>> 8) & 0xff;
        header[4 + COMMAND_LEN + 2] = (len >>> 16) & 0xff;
        header[4 + COMMAND_LEN + 3] = (len >>> 24) & 0xff;

        const hashResult = Sha256Hash.hashTwice(messageBuffer);
        header.set(hashResult.subarray(0, 4), 4 + COMMAND_LEN + 4);
        
        out.push(header);
        out.push(messageBuffer);
    }

    /**
     * Writes message to to the output stream.
     */
    public serializeMessage(message: Message, out: any): void {
        const name = BitcoinSerializer.getNames().get(message.constructor);
        if (name == null) {
            throw new Error(`BitcoinSerializer doesn't currently know how to serialize ${message.constructor.name}`);
        }
        this.serialize(name, message.unsafeBitcoinSerialize(), out, undefined, undefined, undefined);
    }

    /**
     * Reads a message from the given Buffer and returns it.
     */
    public deserialize(inBuffer: Uint8Array): Message {
        // A Bitcoin protocol message has the following format.
        //
        //   - 4 byte magic number: 0xfabfb5da for the testnet or
        //                          0xf9beb4d9 for production
        //   - 12 byte command in ASCII
        //   - 4 byte payload size
        //   - 4 byte checksum
        //   - Payload data
        //
        // The checksum is the first 4 bytes of a SHA256 hash of the message payload. It isn't
        // present for all messages, notably, the first one on a connection.
        //
        // Bitcoin Core ignores garbage before the magic header bytes. We have to do the same because
        // sometimes it sends us stuff that isn't part of any message.
        const newBuffer = this.seekPastMagicBytes(inBuffer);
        const header = new BitcoinPacketHeader(newBuffer, this.params);
        // Now try to read the whole message.
        return this.deserializePayload(header, newBuffer.subarray(BitcoinPacketHeader.HEADER_LENGTH));
    }

    /**
     * Deserialize payload only.  You must provide a header, typically obtained by calling
     * {@link BitcoinSerializer#deserializeHeader}.
     */
    public deserializePayload(header: BitcoinPacketHeader, inBuffer: Uint8Array): Message {
        const payloadBytes = new Uint8Array(header.size);
        payloadBytes.set(inBuffer.subarray(0, header.size), 0);

        // Verify the checksum.
        const hash = Sha256Hash.hashTwice(payloadBytes);
        if (header.checksum[0] !== hash[0] || header.checksum[1] !== hash[1] ||
                header.checksum[2] !== hash[2] || header.checksum[3] !== hash[3]) {
            const hashHex = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');
            const checksumHex = Array.from(header.checksum).map(b => b.toString(16).padStart(2, '0')).join('');
            throw new ProtocolException(`Checksum failed to verify, actual ${hashHex} vs ${checksumHex}`);
        }

        try {
            const payloadHex = Array.from(payloadBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            return this.makeMessage(header.command, header.size, payloadBytes, hash, header.checksum);
        } catch (e) {
            const payloadHex = Array.from(payloadBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            throw new ProtocolException(`Error deserializing message ${payloadHex}\n`);
        }
    }

    private makeMessage(command: string, length: number, payloadBytes: Uint8Array, hash: Uint8Array, checksum: Uint8Array): Message {
        // We use an if ladder rather than reflection because reflection is very slow.
        let message: Message;
        if (command === "block") {
            message = this.makeBlock(payloadBytes);
        } else if (command === "tx") {
            message = this.makeTransaction(payloadBytes);
        } else if (command === "alert") {
            return this.makeAlertMessage(payloadBytes);
        }  else if (command === "merkleblock") {
            return this.makeFilteredBlock(payloadBytes);
        } else if (command === "headers") {
            return this.makeHeadersMessage(payloadBytes);
        } else {
            throw new ProtocolException(`No support for deserializing message with name ${command}`);
        }
        return message;
    }

    /**
     * Get the network parameters for this serializer.
     */
    public getParameters(): NetworkParameters {
        return this.params;
    }

    /**
     * Make an alert message from the payload. Extension point for alternative
     * serialization format support.
     */
    public makeAlertMessage(payloadBytes: Uint8Array): AlertMessage {
        return new AlertMessage(this.params, payloadBytes);
    }

    /**
     * Make a block from the payload. Extension point for alternative
     * serialization format support.
     */
    public makeBlock(payloadBytes: Uint8Array): Block {
        return Block.setBlock5(this.params, payloadBytes,0, this, payloadBytes.length);
    }

    /**
     * Make a filtered block from the payload. Extension point for alternative
     * serialization format support.
     */
    public makeFilteredBlock(payloadBytes: Uint8Array): FilteredBlock {
        return new FilteredBlock(this.params, payloadBytes);
    }

    /**
     * Make a headers message from the payload. Extension point for alternative
     * serialization format support.
     */
    public makeHeadersMessage(payloadBytes: Uint8Array): HeadersMessage {
        return new HeadersMessage(this.params, payloadBytes);
    }

    /**
     * Make a transaction from the payload. Extension point for alternative
     * serialization format support.
     */
    public makeTransaction(payloadBytes: Uint8Array): Transaction {
        return Transaction.fromTransaction6(this.params, payloadBytes, 0, null, this, payloadBytes.length);
    }

    public seekPastMagicBytes(inBuffer: Uint8Array): Uint8Array {
        let magicCursor = 3;  // Which byte of the magic we're looking for currently.
        let position = 0;
        const packetMagic = this.params.getPacketMagic();
        
        while (position < inBuffer.length) {
            const b = inBuffer[position];
            // We're looking for a run of bytes that is the same as the packet magic but we want to ignore partial
            // magics that aren't complete. So we keep track of where we're up to with magicCursor.
            const expectedByte = (packetMagic >>> (magicCursor * 8)) & 0xFF;
            if (b === expectedByte) {
                magicCursor--;
                position++;
                if (magicCursor < 0) {
                    // We found the magic sequence.
                    return inBuffer.subarray(position);
                } else {
                    // We still have further to go to find the next message.
                }
            } else {
                magicCursor = 3;
                position++;
            }
        }
        throw new ProtocolException("Magic bytes not found");
    }

    /**
     * Whether the serializer will produce cached mode Messages
     */
    public isParseRetainMode(): boolean {
        return this.parseRetain;
    }

}
