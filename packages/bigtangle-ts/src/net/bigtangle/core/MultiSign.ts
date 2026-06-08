import { Utils } from '../utils/Utils';
import { JsonProperty } from "jackson-js";

export class MultiSign {
    @JsonProperty() private id: string | null = null;
    @JsonProperty() private tokenid: string | null = null;
    @JsonProperty() private tokenindex: number = 0;
    @JsonProperty() public blockhashHex: string | null = null;
    @JsonProperty() private address: string | null = null;
    @JsonProperty() private sign: number = 0;

    public getBlockhashHex(): string {
        if (this.blockhashHex === null) {
            return "";
        }
        return this.blockhashHex;
    }
    
    public setBlockhashHex(blockhashHex: string | null): void {
        this.blockhashHex = blockhashHex;
    }
    
    public getBlockbytes(): Uint8Array | null {
        if (this.blockhashHex === null) {
            return null;
        }
        return Utils.HEX.decode(this.blockhashHex);
    }
    
    public setBlockbytes(blockbytes: Uint8Array | null): void {
        if (blockbytes === null) {
            this.blockhashHex = null;
        } else {
            this.blockhashHex = Utils.HEX.encode(blockbytes);
        }
    }

    public getSign(): number {
        return this.sign;
    }

    public setSign(sign: number): void {
        this.sign = sign;
    }

    public getId(): string | null {
        return this.id;
    }

    public setId(id: string | null): void {
        this.id = id;
    }

    public getTokenid(): string | null {
        return this.tokenid;
    }

    public setTokenid(tokenid: string | null): void {
        this.tokenid = tokenid;
    }

    public getTokenindex(): number {
        return this.tokenindex;
    }

    public setTokenindex(tokenindex: number): void {
        this.tokenindex = tokenindex;
    }

    public getAddress(): string | null {
        return this.address;
    }

    public setAddress(address: string | null): void {
        this.address = address;
    }

    public toString(): string {
        return `MultiSign [id=${this.id}, tokenid=${this.tokenid}, tokenindex=${this.tokenindex}, blockbytes=${this.blockhashHex ? this.blockhashHex : 'null'}, address=${this.address}, sign=${this.sign}]`;
    }
}