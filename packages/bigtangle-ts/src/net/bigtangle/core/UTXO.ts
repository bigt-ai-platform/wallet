import { Coin } from './Coin';
import { Script } from '../script/Script';
import { Sha256Hash } from './Sha256Hash';
import { MemoInfo } from './MemoInfo';
import { Utils } from '../utils/Utils';
import { SpentBlock } from './SpentBlock';
import { JsonProperty } from "jackson-js";

/**
 * A UTXO message contains the information necessary to check a spending
 * transaction.
 */
export class UTXO extends SpentBlock {
    @JsonProperty()
    private value: Coin = new Coin(); // Default to empty coin instead of null
    @JsonProperty()
    private script: Script = new Script(new Uint8Array()); // Default to empty script
    @JsonProperty()
    private hash: Sha256Hash =   Sha256Hash.ZERO_HASH; // Default to empty hash
    @JsonProperty()
    private index: number = 0;
    @JsonProperty()
    private coinbase: boolean = false;
    @JsonProperty()
    private address: string = ""; // Default to empty string instead of null
    @JsonProperty()
    private fromaddress: string = ""; // Default to empty string instead of null
    @JsonProperty()
    private spendPending: boolean = false;
    @JsonProperty()
    private spendPendingTime: number = 0;
    @JsonProperty()
    private tokenId: string = ""; // Default to empty string instead of null
    @JsonProperty()
    private minimumsign: number = 0;
    @JsonProperty()
    private memo: string = ""; // Default to empty string instead of null
   
    constructor(
        hash?: Sha256Hash,
        index?: number,
        value?: Coin,
        coinbase?: boolean,
        script?: Script,
        address?: string,
        blockhash?: Sha256Hash,
        fromaddress?: string,
        memo?: string,
        tokenid?: string,
        spent?: boolean,
        confirmed?: boolean,
        spendPending?: boolean,
        minimumsign?: number,
        spendPendingTime?: number,
        time?: number,
        spenderBlockHash?: Sha256Hash
    ) {
        super();
        this.value = value ?? new Coin();
        this.script = script ?? new Script(new Uint8Array());
        this.hash = hash ?? Sha256Hash.ZERO_HASH;
        this.index = index ?? 0;
        this.coinbase = coinbase ?? false;
        this.address = address ?? "";
        this.fromaddress = fromaddress ?? "";
        this.spendPending = spendPending ?? false;
        this.spendPendingTime = spendPendingTime ?? 0;
        this.tokenId = tokenid ?? "";
        this.minimumsign = minimumsign ?? 0;
        this.memo = memo ?? "";

        // Set properties from superclass if provided
        if (blockhash) this.setBlockHash(blockhash);
        if (spent !== undefined) this.setSpent(spent);
        if (spenderBlockHash) this.setSpenderBlockHash(spenderBlockHash);
        if (confirmed !== undefined) this.setConfirmed(confirmed);
        if (time !== undefined) this.setTime(time);
    }

    public keyAsString(): string {
        return `${this.getBlockHashHex()}-${Utils.HEX.encode(this.hash.getBytes())}-${this.index}`;
    }

    public getSpendPendingTime(): number {
        return this.spendPendingTime;
    }

    public isZero(): boolean {
        return this.value.isZero();
    }

    public setSpendPendingTime(spendPendingTime: number): void {
        this.spendPendingTime = spendPendingTime;
    }

    public setScriptHex(scriptHex: string): void {
        this.script = new Script(Utils.HEX.decode(scriptHex));
    }

    public setHashHex(hashHex: string): void {
        const hash = Sha256Hash.wrap(new Uint8Array(Utils.HEX.decode(hashHex)));
        if (hash !== null) {
            this.hash = hash;
        }
    }

    public setValue(value: Coin): void {
        this.value = value;
    }

    public setHash(hash: Sha256Hash): void {
        this.hash = hash;
    }

    public setIndex(index: number): void {
        this.index = index;
    }

    public setCoinbase(coinbase: boolean): void {
        this.coinbase = coinbase;
    }

    public setAddress(address: string): void {
        this.address = address;
    }

    public isMultiSig(): boolean {
        return this.minimumsign > 1;
    }

    public getTokenId(): string {
        return this.tokenId;
    }

    public setTokenid(tokenid: string): void {
        this.tokenId = tokenid;
    }

    public getTokenidBuf(): Uint8Array {
        return this.tokenId ? Utils.HEX.decode(this.tokenId) : new Uint8Array();
    }

    public getFromaddress(): string {
        return this.fromaddress;
    }

    public setFromaddress(fromaddress: string): void {
        this.fromaddress = fromaddress;
    }

    public memoToString(): string {
        return this.memo ? MemoInfo.parseToString(this.memo) : "";
    }

    public getValue(): Coin {
        return this.value;
    }

    public getScript(): Script {
        return this.script;
    }

    public setScript(script: Script): void {
        this.script = script;
    }

    public getScriptHex(): string {
        return Utils.HEX.encode(this.script.getProgram());
    }

    public getTxHash(): Sha256Hash {
        return this.hash;
    }

    public getHashHex(): string {
        return Utils.HEX.encode(this.hash.getBytes());
    }

    public getIndex(): number {
        return this.index;
    }

    public isCoinbase(): boolean {
        return this.coinbase;
    }

    public getAddress(): string {
        return this.address;
    }

    public toStringShort(): string {
        return `UTXO ${this.value} (${this.hash}:${this.index})`;
    }

    public toString(): string {
        return `UTXO [value=${this.value}, \n script=${this.script}, \n hash=${this.hash}, \n index=${this.index}` +
               `, coinbase=${this.coinbase}, \n address=${this.address}, \n fromaddress=${this.fromaddress}` +
               `, \n time=${Utils.dateTimeFormat(this.getTime() * 1000)}` +
               `, \n memo=${this.memo} \n confirmed=${this.isConfirmed()}` +
               `, \n spent=${this.isSpent()} \n spendPending=${this.spendPending}` +
               `, \n spendPendingTime=${this.spendPendingTime}` +
               `, \n spenderBlockHash=${this.getSpenderBlockHash()} \n tokenId=${this.tokenId}` +
               `, \n minimumsign=${this.minimumsign} \n ]`;
    }

    public hashCode(): number {
        let result = 17;
        result = 31 * result + this.index;
        result = 31 * result + this.hash.hashCode();
        result = 31 * result + (this.getBlockHash()?.hashCode() ?? 0);
        return result;
    }

    public equals(o: any): boolean {
        if (this === o) return true;
        if (o === null || !(o instanceof UTXO)) return false;
        const other = o as UTXO;
        const thisBlockHash = this.getBlockHash();
        const otherBlockHash = other.getBlockHash();
        
        return this.getIndex() === other.getIndex() &&
               this.getTxHash().equals(other.getTxHash()) &&
               (thisBlockHash === otherBlockHash || 
                (thisBlockHash !== null && otherBlockHash !== null && thisBlockHash.equals(otherBlockHash)));
    }

    public getMemo(): string {
        return this.memo;
    }

    public setMemo(memo: string): void {
        this.memo = memo;
    }

    public isSpendPending(): boolean {
        return this.spendPending;
    }

    public setSpendPending(spendPending: boolean): void {
        this.spendPending = spendPending;
    }

    public getMinimumsign(): number {
        return this.minimumsign;
    }

    public setMinimumsign(minimumsign: number): void {
        this.minimumsign = minimumsign;
    }

    public static fromJSONObject(data: any): UTXO {
      //  console.log("Creating UTXO from JSON:", JSON.stringify(data, null, 2));
        const utxo = new UTXO();
        Object.assign(utxo, data);
 
         
        if (data.value) {
            utxo.setValue(Coin.fromJSON(data.value));
        }
        if (data.scriptHex) {
            utxo.setScriptHex(data.scriptHex);
        }
        // Handle hashHex property
        if (data.hashHex) {
            utxo.setHashHex(data.hashHex);
            utxo.hash = Sha256Hash.wrap(new Uint8Array(Utils.HEX.decode(data.hashHex)));
        }
          // Handle hashHex property
        if (data.blockHashHex) { 
            utxo.setBlockHash( Sha256Hash.wrap(new Uint8Array(Utils.HEX.decode(data.blockHashHex))));
        }
 
        return utxo;
    }
}
