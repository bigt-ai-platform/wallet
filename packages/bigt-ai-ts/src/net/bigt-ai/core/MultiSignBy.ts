import { JsonProperty } from "jackson-js";

export class MultiSignBy {
    @JsonProperty() private tokenid: string | null = null;
    @JsonProperty() private tokenindex: number = 0;
    @JsonProperty() private address: string | null = null;
    @JsonProperty() private publickey: string | null = null;
    @JsonProperty() private signature: string | null = null;

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

    constructor() {
    }

    public getPublickey(): string | null {
        return this.publickey;
    }

    public setPublickey(publickey: string | null): void {
        this.publickey = publickey;
    }

    public getSignature(): string | null {
        return this.signature;
    }

    public setSignature(signature: string | null): void {
        this.signature = signature;
    }

    public toString(): string {
        return `MultiSignBy [tokenid=${this.tokenid}, tokenindex=${this.tokenindex}, address=${this.address}` +
               `, publickey=${this.publickey}, signature=${this.signature}]`;
    }
}