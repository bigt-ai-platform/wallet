
import { JsonProperty } from "jackson-js";

export class PayMultiSign {
    @JsonProperty() private orderid: string | null = null;
    @JsonProperty() private tokenid: string | null = null;
    @JsonProperty() private toaddress: string | null = null;
    @JsonProperty() private blockhashHex: string | null = null;
    @JsonProperty() private blockhash: Uint8Array | null = null;
    @JsonProperty() private amount: bigint | null = null;
    @JsonProperty() private minsignnumber: number = 0;
    @JsonProperty() private pubKeyHex: string | null = null;
    @JsonProperty() private outputHashHex: string | null = null;
    @JsonProperty() private outputindex: number = 0;
    @JsonProperty() private sign: number = 0;
    @JsonProperty() private signcount: number = 0;

    public getOutputHashHex(): string | null {
        return this.outputHashHex;
    }

    public setOutputHashHex(outputHashHex: string | null): void {
        this.outputHashHex = outputHashHex;
    }

    public getPubKeyHex(): string | null {
        return this.pubKeyHex;
    }

    public setPubKeyHex(pubKeyHex: string | null): void {
        this.pubKeyHex = pubKeyHex;
    }

    public getOrderid(): string | null {
        return this.orderid;
    }

    public setOrderid(orderid: string | null): void {
        this.orderid = orderid;
    }

    public getTokenid(): string | null {
        return this.tokenid;
    }

    public setTokenid(tokenid: string | null): void {
        this.tokenid = tokenid;
    }

    public getToaddress(): string | null {
        return this.toaddress;
    }

    public setToaddress(toaddress: string | null): void {
        this.toaddress = toaddress;
    }

    public getAmount(): bigint | null {
        return this.amount;
    }

    public setAmount(amount: bigint | null): void {
        this.amount = amount;
    }

    public getMinsignnumber(): number {
        return this.minsignnumber;
    }

    public setMinsignnumber(minsignnumber: number): void {
        this.minsignnumber = minsignnumber;
    }

    public getBlockhashHex(): string | null {
        return this.blockhashHex;
    }

    public setBlockhashHex(blockhashHex: string | null): void {
        this.blockhashHex = blockhashHex;
    }

    public getBlockhash(): Uint8Array | null {
        return this.blockhash;
    }

    public setBlockhash(blockhash: Uint8Array | null): void {
        this.blockhash = blockhash;
    }

    public getOutputindex(): number {
        return this.outputindex;
    }

    public setOutputindex(outputindex: number): void {
        this.outputindex = outputindex;
    }

    public getSign(): number {
        return this.sign;
    }

    public setSign(sign: number): void {
        this.sign = sign;
    }

    public getSigncount(): number {
        return this.signcount;
    }

    public setSigncount(signcount: number): void {
        this.signcount = signcount;
    }
}