import { Sha256Hash } from './Sha256Hash';
import { SpentBlock } from './SpentBlock';
import { JsonProperty } from "jackson-js";

export class ContractEventRecord extends SpentBlock {
    @JsonProperty()
    private collectinghash: Sha256Hash | null = null;
    @JsonProperty()
    private contractTokenid: string | null = null;
    @JsonProperty()
    private targetValue: bigint | null = null;
    @JsonProperty()
    private targetTokenid: string | null = null;
    @JsonProperty()
    private beneficiaryAddress: string | null = null;

    constructor(
        collectinghash?: Sha256Hash,
        contractTokenid?: string,
        targetValue?: bigint,
        targetTokenid?: string,
        beneficiaryAddress?: string,
        validFromTimeMilli?: number,
        validToTimeMilli?: number,
        spendBlockHash?: Sha256Hash,
        spendTxHash?: Sha256Hash,
        confirmed?: boolean,
        time?: number,
        spent?: boolean,
        spendPending?: boolean,
        spendPendingTime?: number,
        blockHashHex?: string,
        hashHex?: string,
        index?: number,
        coinbase?: boolean,
        address?: string,
        fromaddress?: string,
        tokenId?: string,
        minimumsign?: number,
        zero?: boolean,
        multiSig?: boolean,
        scriptHex?: string,
        blockHash?: Sha256Hash,
        confirmedTimeMilli?: number,
        domainName?: string
    ) {
        super();
        if (blockHash) this.setBlockHash(blockHash);
        if (collectinghash) this.collectinghash = collectinghash;
        if (confirmed !== undefined) this.setConfirmed(confirmed);
        if (spent !== undefined) this.setSpent(spent);
        if (blockHash) this.setSpenderBlockHash(blockHash);
        if (targetValue) this.targetValue = targetValue;
        if (targetTokenid) this.targetTokenid = targetTokenid;
        if (beneficiaryAddress) this.beneficiaryAddress = beneficiaryAddress;
        if (contractTokenid) this.contractTokenid = contractTokenid;
    }

    public static cloneOrderRecord(old: ContractEventRecord): ContractEventRecord {
        return new ContractEventRecord(
            old.getCollectinghash() || undefined,
            old.getContractTokenid() || undefined,
            old.getTargetValue() || undefined,
            old.getTargetTokenid() || undefined,
            old.getBeneficiaryAddress() || undefined,
            undefined, // validFromTimeMilli
            undefined, // validToTimeMilli
            undefined, // spendBlockHash
            undefined, // spendTxHash
            old.isConfirmed(),
            undefined, // time
            old.isSpent(),
            undefined, // spendPending
            undefined, // spendPendingTime
            undefined, // blockHashHex
            undefined, // hashHex
            undefined, // index
            undefined, // coinbase
            undefined, // address
            undefined, // fromaddress
            undefined, // tokenId
            undefined, // minimumsign
            undefined, // zero
            undefined, // multiSig
            undefined, // scriptHex
            old.getBlockHash() || undefined,
            undefined  // confirmedTimeMilli
            // domainName is omitted
        );
    }

    public getTargetValue(): bigint | null {
        return this.targetValue;
    }

    public setTargetValue(targetValue: bigint | null): void {
        this.targetValue = targetValue;
    }

    public getTargetTokenid(): string | null {
        return this.targetTokenid;
    }

    public setTargetTokenid(targetTokenid: string | null): void {
        this.targetTokenid = targetTokenid;
    }

    public getBeneficiaryAddress(): string | null {
        return this.beneficiaryAddress;
    }

    public setBeneficiaryAddress(beneficiaryAddress: string | null): void {
        this.beneficiaryAddress = beneficiaryAddress;
    }

    public getContractTokenid(): string | null {
        return this.contractTokenid;
    }

    public setContractTokenid(contractTokenid: string | null): void {
        this.contractTokenid = contractTokenid;
    }

    public getCollectinghash(): Sha256Hash | null {
        return this.collectinghash;
    }

    public setCollectinghash(collectinghash: Sha256Hash | null): void {
        this.collectinghash = collectinghash;
    }

    public toString(): string {
        return `ContractEventRecord [ beneficiaryAddress=${this.beneficiaryAddress}, collectinghash=${this.collectinghash}` +
               `, contractTokenid=${this.contractTokenid}, targetValue=${this.targetValue}, targetTokenid=${this.targetTokenid}` +
               `${super.toString()}]`;
    }
}
