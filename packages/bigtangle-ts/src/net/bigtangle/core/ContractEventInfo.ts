import { DataClass } from './DataClass';

import { Utils } from '../utils/Utils';
import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty } from "jackson-js";
export class ContractEventInfo extends DataClass {
    @JsonProperty()
    private beneficiaryAddress: string | null = null;
    @JsonProperty()
    private offerValue: bigint | null = null;
    @JsonProperty()
    private offerTokenid: string | null = null;
    @JsonProperty()
    private contractTokenid: string | null = null;
    @JsonProperty()
    private offerSystem: string | null = null;

    constructor(
        contractTokenid?: string,
        offerValue?: any,
        offerTokenid?: string,
        beneficiaryAddress?: string,
        validToTimeMilli?: number,
        validFromTimeMilli?: number,
        offerSystem?: string
    ) {
        super();
        if (contractTokenid) this.contractTokenid = contractTokenid;
        if (beneficiaryAddress) this.beneficiaryAddress = beneficiaryAddress;
        if (offerValue) this.offerValue = BigInt(offerValue);
        if (offerTokenid) this.offerTokenid = offerTokenid;
        if (offerSystem) this.offerSystem = offerSystem;
    }

    public toByteArray(): Uint8Array {
        const baos = new UnsafeByteArrayOutputStream();
        try {
            const superBytes = new Uint8Array(super.toByteArray());
            baos.writeBytes(superBytes, 0, superBytes.length);
            baos.writeNBytesString(this.beneficiaryAddress);
            baos.writeNBytesString(this.offerTokenid);
            baos.writeNBytesString(this.contractTokenid);
            baos.writeNBytesString(this.offerSystem);
            // Java ContractEventInfo writes offerValue with Utils.writeNBytes
            // (present flag + int length + BigInteger two's-complement bytes),
            // NOT a fixed 32-byte buffer — a fixed buffer desyncs the server
            // parse (MalformedTransactionDataException).
            baos.writeNBytes(Utils.bigIntToBytes(this.offerValue ?? 0n));
            baos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return baos.toByteArray();
    }

    public parseDIS(dis: DataInputStream): this {
        super.parseDIS(dis);
        this.beneficiaryAddress = dis.readNBytesString();
        this.offerTokenid = dis.readNBytesString();
        this.contractTokenid = dis.readNBytesString();
        this.offerSystem = dis.readNBytesString();
        // Mirrors Java Utils.readNBytes: present flag + int length + bytes.
        if (dis.readBoolean()) {
            const length = dis.readInt();
            this.offerValue = Utils.bytesToBigInt(dis.readBytes(length));
        } else {
            this.offerValue = null;
        }
        return this;
    }

    public parse(buf: Uint8Array): ContractEventInfo {
        const bain = new DataInputStream(new Uint8Array(buf));
        try {
            this.parseDIS(bain);
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return this;
    }

    public parseChecked(buf: Uint8Array): ContractEventInfo {
        try {
            return this.parse(buf);
        } catch (e: any) {
            throw new Error(e);
        }
    }

    public getBeneficiaryAddress(): string | null {
        return this.beneficiaryAddress;
    }

    public setBeneficiaryAddress(beneficiaryAddress: string | null): void {
        this.beneficiaryAddress = beneficiaryAddress;
    }

    public getOfferValue(): bigint | null {
        return this.offerValue;
    }

    public setOfferValue(offerValue: bigint | null): void {
        this.offerValue = offerValue;
    }

    public getOfferTokenid(): string | null {
        return this.offerTokenid;
    }

    public setOfferTokenid(offerTokenid: string | null): void {
        this.offerTokenid = offerTokenid;
    }

    public getContractTokenid(): string | null {
        return this.contractTokenid;
    }

    public setContractTokenid(contractTokenid: string | null): void {
        this.contractTokenid = contractTokenid;
    }

    public getOfferSystem(): string | null {
        return this.offerSystem;
    }

    public setOfferSystem(offerSystem: string | null): void {
        this.offerSystem = offerSystem;
    }

    public toString(): string {
        return `ContractEventInfo [beneficiaryAddress=${this.beneficiaryAddress}, offerValue=${this.offerValue}` +
               `, offerTokenid=${this.offerTokenid}, contractTokenid=${this.contractTokenid}, offerSystem=${this.offerSystem}]`;
    }
}
