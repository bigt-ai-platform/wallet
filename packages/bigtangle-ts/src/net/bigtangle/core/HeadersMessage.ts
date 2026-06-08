import { Message } from './Message';
import { Block } from './Block';
import { NetworkParameters } from '../params/NetworkParameters';
import { ProtocolException } from '../exception/Exceptions';
import { VarInt } from './VarInt';
;

/**
 * <p>A protocol message that contains a repeated series of block headers, sent in response to the "getheaders" command.
 * This is useful when you want to traverse the chain but know you don't care about the block contents, for example,
 * because you have a freshly created wallet with no keys.</p>
 * 
 * <p>Instances of this class are not safe for use by multiple threads.</p>
 */
export class HeadersMessage extends Message {
    public static readonly MAX_HEADERS = 2000;

    private blockHeaders: Block[];

    constructor(params: NetworkParameters, payload: Uint8Array);
    constructor(params: NetworkParameters, headers: Block[]);
    constructor(params: NetworkParameters, arg: Uint8Array | Block[]) {
        super(params);
        if (Array.isArray(arg)) {
            this.blockHeaders = arg;
        } else {
            this.blockHeaders = [];
            this.payload = arg;
            this.parse();
        }
    }

    public bitcoinSerializeToStream(stream: any): void {
        const varInt = new VarInt(this.blockHeaders.length);
        const varIntBuffer = varInt.encode();
        stream.write(varIntBuffer);
        for (const header of this.blockHeaders) {
            const headerBuffer = header.unsafeBitcoinSerialize();
            stream.write(headerBuffer); // Serialize header and write to stream
            stream.write(new Uint8Array([0])); // Trailing null byte
        }
    }

    protected parse(): void {
        if (this.payload === null) {
            throw new ProtocolException("Payload is null");
        }
        let cursor = 0;
        const varInt = VarInt.fromBuffer(new Uint8Array(this.payload), cursor);
        const numHeaders = Number(varInt.value);
        cursor += varInt.getOriginalSizeInBytes();

        if (numHeaders > HeadersMessage.MAX_HEADERS) {
            throw new ProtocolException(`Too many headers: got ${numHeaders} which is larger than ${HeadersMessage.MAX_HEADERS}`);
        }

        this.blockHeaders = [];
        const serializer = this.params!.getDefaultSerializer();

        for (let i = 0; i < numHeaders; ++i) {
            // Extract the block header data from the payload starting at cursor position
            const blockHeaderData = this.payload.subarray(cursor);
            const newBlockHeader = serializer.makeBlock(new Uint8Array(blockHeaderData));
    
            cursor += newBlockHeader.getMessageSize(); // Assuming getMessageSize returns optimalEncodingMessageSize
            this.blockHeaders.push(newBlockHeader);
        }

        if (this.length === Message.UNKNOWN_LENGTH) {
            this.length = cursor - this.offset;
        }
    }

    public getBlockHeaders(): Block[] {
        return this.blockHeaders;
    }
}
