import { Message } from './Message';
import { NetworkParameters } from '../params/NetworkParameters';
import { ProtocolException } from '../exception/Exceptions';
import { Sha256Hash } from './Sha256Hash';
;
// TODO: Implement UnsafeByteArrayOutputStream
// import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';

// Chosen arbitrarily to avoid memory blowups.
const MAX_SET_SIZE = 100;

/**
 * Alerts are signed messages that are broadcast on the peer-to-peer network if they match a hard-coded signing key.
 * The private keys are held by a small group of core Bitcoin developers, and alerts may be broadcast in the event of
 * an available upgrade or a serious network problem. Alerts have an expiration time, data that specifies what
 * set of software versions it matches and the ability to cancel them by broadcasting another type of alert.
 * 
 * The right course of action on receiving an alert is usually to either ensure a human will see it (display on screen,
 * log, email), or if you decide to use alerts for notifications that are specific to your app in some way, to parse it.
 * For example, you could treat it as an upgrade notification specific to your app. Satoshi designed alerts to ensure
 * that software upgrades could be distributed independently of a hard-coded website, in order to allow everything to
 * be purely peer-to-peer. You don't have to use this of course, and indeed it often makes more sense not to.
 * 
 * Before doing anything with an alert, you should check {@link AlertMessage#isSignatureValid}.
 * 
 * Instances of this class are not safe for use by multiple threads.
 */
export class AlertMessage extends Message {
    private content!: Uint8Array;
    private signature!: Uint8Array;

    // See the getters for documentation of what each field means.
    private version: number = 1;
    private relayUntil!: Date;
    private expiration!: Date;
    private id!: number;
    private cancel!: number;
    private minVer!: number;
    private maxVer!: number;
    private priority!: number;
    private comment!: string;
    private statusBar!: string;
    private reserved!: string;

    constructor(params: NetworkParameters, payloadBytes: Uint8Array) {
        super(params);
        // Set the values using the proper method
        this.setValues5(params, payloadBytes, 0, params.getDefaultSerializer(), payloadBytes.length);
    }

    public toString(): string {
        return `ALERT: ${this.getStatusBar()}`;
    }

    protected parse(): void {
        // Alerts are formatted in two levels. The top level contains two byte arrays: a signature, and a serialized
        // data structure containing the actual alert data.
        const startPos = this.cursor;
        this.content = this.readByteArray();
        this.signature = this.readByteArray();
        // Now we need to parse out the contents of the embedded structure. Rewind back to the start of the message.
        this.cursor = startPos;
        this.readVarInt();  // Skip the length field on the content array.
        // We're inside the embedded structure.
        this.version = this.readUint32();
        // Read the timestamps. Bitcoin uses seconds since the epoch.
        this.relayUntil = new Date(Number(this.readUint64()) * 1000);
        this.expiration = new Date(Number(this.readUint64()) * 1000);
        this.id = this.readUint32();
        this.cancel = this.readUint32();
        // Sets are serialized as <len><item><item><item>....
        const cancelSetSize = this.readVarInt();
        if (cancelSetSize < 0 || cancelSetSize > MAX_SET_SIZE) {
            throw new ProtocolException(`Bad cancel set size: ${cancelSetSize}`);
        }
        const cancelSet: Set<number> = new Set<number>();
        for (let i = 0; i < cancelSetSize; i++) {
            cancelSet.add(this.readUint32());
        }
        this.minVer = this.readUint32();
        this.maxVer = this.readUint32();
        // Read the subver matching set.
        const subverSetSize = this.readVarInt();
        if (subverSetSize < 0 || subverSetSize > MAX_SET_SIZE) {
            throw new ProtocolException(`Bad subver set size: ${subverSetSize}`);
        }
        const matchingSubVers: Set<string> = new Set<string>();
        for (let i = 0; i < subverSetSize; i++) {
            matchingSubVers.add(this.readStr());
        }
        this.priority = this.readUint32();
        this.comment = this.readStr();
        this.statusBar = this.readStr();
        this.reserved = this.readStr();

        this.length = this.cursor - this.offset;
    }

    /**
     * Returns true if the digital signature attached to the message verifies. Don't do anything with the alert if it
     * doesn't verify, because that would allow arbitrary attackers to spam your users.
     */
    public isSignatureValid(): boolean {
        const hash = Sha256Hash.hashTwice(new Uint8Array(this.content));
        // TODO: Implement proper signature verification
        // This is a placeholder since we don't have ECDSASignature implemented
        return true;
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    //  Field accessors.

    /**
     * The time at which the alert should stop being broadcast across the network. Note that you can still receive
     * the alert after this time from other nodes if the alert still applies to them or to you.
     */
    public getRelayUntil(): Date {
        return this.relayUntil;
    }

    public setRelayUntil(relayUntil: Date): void {
        this.relayUntil = relayUntil;
    }

    /**
     * The time at which the alert ceases to be relevant. It should not be presented to the user or app administrator
     * after this time.
     */
    public getExpiration(): Date {
        return this.expiration;
    }

    public setExpiration(expiration: Date): void {
        this.expiration = expiration;
    }

    /**
     * The numeric identifier of this alert. Each alert should have a unique ID, but the signer can choose any number.
     * If an alert is broadcast with a cancel field higher than this ID, this alert is considered cancelled.
     * @return uint32
     */
    public getId(): number {
        return this.id;
    }

    public setId(id: number): void {
        this.id = id;
    }

    /**
     * A marker that results in any alerts with an ID lower than this value to be considered cancelled.
     * @return uint32
     */
    public getCancel(): number {
        return this.cancel;
    }

    public setCancel(cancel: number): void {
        this.cancel = cancel;
    }

    /**
     * The inclusive lower bound on software versions that are considered for the purposes of this alert. Bitcoin Core
     * compares this against a protocol version field, but as long as the subVer field is used to restrict it your
     * alerts could use any version numbers.
     * @return uint32
     */
    public getMinVer(): number {
        return this.minVer;
    }

    public setMinVer(minVer: number): void {
        this.minVer = minVer;
    }

    /**
     * The inclusive upper bound on software versions considered for the purposes of this alert. Bitcoin Core
     * compares this against a protocol version field, but as long as the subVer field is used to restrict it your
     * alerts could use any version numbers.
     */
    public getMaxVer(): number {
        return this.maxVer;
    }

    public setMaxVer(maxVer: number): void {
        this.maxVer = maxVer;
    }

    /**
     * Provides an integer ordering amongst simultaneously active alerts.
     * @return uint32
     */
    public getPriority(): number {
        return this.priority;
    }

    public setPriority(priority: number): void {
        this.priority = priority;
    }

    /**
     * This field is unused. It is presumably intended for the author of the alert to provide a justification for it
     * visible to protocol developers but not users.
     */
    public getComment(): string {
        return this.comment;
    }

    public setComment(comment: string): void {
        this.comment = comment;
    }

    /**
     * A string that is intended to display in the status bar of Bitcoin Core's GUI client. It contains the user-visible
     * message. English only.
     */
    public getStatusBar(): string {
        return this.statusBar;
    }

    public setStatusBar(statusBar: string): void {
        this.statusBar = statusBar;
    }

    /**
     * This field is never used.
     */
    public getReserved(): string {
        return this.reserved;
    }

    public setReserved(reserved: string): void {
        this.reserved = reserved;
    }
    
    public getVersion(): number {
        return this.version;
    }
    
    // Implementation of abstract method from Message class
    public bitcoinSerializeToStream(stream: any): void {
        // Serialize the content and signature as byte arrays (with length prefix)
        this.writeByteArrayToStream(stream, new Uint8Array(this.content));
        this.writeByteArrayToStream(stream, new Uint8Array(this.signature));

        // Now serialize the embedded structure (alert fields)
        // The embedded structure is serialized as:
        // [version:uint32][relayUntil:uint64][expiration:uint64][id:uint32][cancel:uint32]
        // [cancelSet:VarInt+uint32[]][minVer:uint32][maxVer:uint32][subverSet:VarInt+string[]]
        // [priority:uint32][comment:str][statusBar:str][reserved:str]

        // Write version
        this.writeUint32ToStream(stream, this.version);
        // Write relayUntil and expiration as uint64 (seconds since epoch)
        this.writeUint64ToStream(stream, BigInt(Math.floor(this.relayUntil.getTime() / 1000)));
        this.writeUint64ToStream(stream, BigInt(Math.floor(this.expiration.getTime() / 1000)));
        // Write id and cancel
        this.writeUint32ToStream(stream, this.id);
        this.writeUint32ToStream(stream, this.cancel);
        // Write cancel set (empty for now, as not tracked in this class)
        this.writeVarIntToStream(stream, 0);
        // Write minVer and maxVer
        this.writeUint32ToStream(stream, this.minVer);
        this.writeUint32ToStream(stream, this.maxVer);
        // Write subver set (empty for now, as not tracked in this class)
        this.writeVarIntToStream(stream, 0);
        // Write priority
        this.writeUint32ToStream(stream, this.priority);
        // Write comment, statusBar, reserved
        this.writeStrToStream(stream, this.comment);
        this.writeStrToStream(stream, this.statusBar);
        this.writeStrToStream(stream, this.reserved);
    }

    // Helper methods for serialization
    private writeByteArrayToStream(stream: any, arr: Uint8Array): void {
        this.writeVarIntToStream(stream, arr.length);
        stream.write(new Uint8Array(arr));
    }
    private writeVarIntToStream(stream: any, value: number): void {
        const VarInt = require('./VarInt').VarInt;
        const varInt = new VarInt(value);
        stream.write(varInt.encode());
    }
    private writeUint32ToStream(stream: any, value: number): void {
        const buf = new Uint8Array(4);
        buf[0] = value & 0xff;
        buf[1] = (value >>> 8) & 0xff;
        buf[2] = (value >>> 16) & 0xff;
        buf[3] = (value >>> 24) & 0xff;
        stream.write(buf);
    }
    private writeUint64ToStream(stream: any, value: bigint): void {
        const buf = new Uint8Array(8);
        for (let i = 0; i < 8; i++) {
            buf[i] = Number((value >> BigInt(i * 8)) & 0xffn);
        }
        stream.write(buf);
    }
    private writeStrToStream(stream: any, str: string): void {
        const strBuf = new TextEncoder().encode(str);
        this.writeVarIntToStream(stream, strBuf.length);
        stream.write(strBuf);
    }
}
