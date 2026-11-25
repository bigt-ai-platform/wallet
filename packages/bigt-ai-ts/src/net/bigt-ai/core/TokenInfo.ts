import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { Token } from './Token';
import { MultiSignAddress } from './MultiSignAddress';

export class TokenInfo {
    private token: Token | null = null;
    private multiSignAddresses: MultiSignAddress[] = [];

    constructor() {
        this.multiSignAddresses = [];
    }

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        if (this.token != null) {
            const tokenBytes = this.token.toByteArray();
            baos.writeInt(tokenBytes.length);
            baos.writeBytes(new Uint8Array(tokenBytes), 0, tokenBytes.length);
        } else {
            baos.writeInt(0);
        }
        baos.writeInt(this.multiSignAddresses.length);
        for (const addr of this.multiSignAddresses) {
            const addrBytes = addr.toByteArray();
            baos.writeInt(addrBytes.length);
            baos.writeBytes(new Uint8Array(addrBytes), 0, addrBytes.length);
        }
        baos.close();
        return baos.toByteArray();
    }

    public parse(buf: Uint8Array): TokenInfo {
        const dis = new DataInputStream(buf);
        const tokenLen = dis.readInt();
        if (tokenLen > 0) {
            const tokenBytes = dis.readBytes(tokenLen);
            this.token = new Token().parse(tokenBytes);
        }
        const numAddresses = dis.readInt();
        this.multiSignAddresses = [];
        for (let i = 0; i < numAddresses; i++) {
            const addrLen = dis.readInt();
            const addrBytes = dis.readBytes(addrLen);
            this.multiSignAddresses.push(MultiSignAddress.parse(addrBytes));
        }
        dis.close();
        return this;
    }

    public parseChecked(buf: Uint8Array): TokenInfo {
        try {
            return this.parse(buf);
        } catch (e: any) {
            throw new Error(e);
        }
    }

    public getToken(): Token | null {
        return this.token;
    }

    public setToken(token: Token | null): void {
        this.token = token;
    }

    public getMultiSignAddresses(): MultiSignAddress[] {
        return this.multiSignAddresses;
    }

    public setMultiSignAddresses(multiSignAddresses: MultiSignAddress[]): void {
        this.multiSignAddresses = multiSignAddresses;
    }

    public toString(): string {
        return `TokenInfo [tokens=${this.token}, multiSignAddresses=${this.multiSignAddresses}]`;
    }
}
