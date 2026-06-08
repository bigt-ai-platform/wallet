import { DataClass } from './DataClass';
import { UTXO } from './UTXO';
import { OrderRecord } from './OrderRecord';
import { ContractEventRecord } from './ContractEventRecord';
import { NetworkParameters } from '../params/NetworkParameters';
import { Utils } from '../utils/Utils';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { JsonProperty, JsonClassType } from "jackson-js";

export class Tokensums extends DataClass {
    @JsonProperty()
    public tokenid: string | null = null;
    @JsonProperty()
    public initial: bigint = 0n;
    @JsonProperty()
    public unspent: bigint = 0n;
    @JsonProperty()
    public order: bigint = 0n;
    @JsonProperty()
    public contract: bigint = 0n;
    @JsonProperty()
    @JsonClassType({type: () => [Array, [UTXO]]})
    public utxos: UTXO[] = [];
    @JsonProperty()
    @JsonClassType({type: () => [Array, [OrderRecord]]})
    public orders: OrderRecord[] = [];
    @JsonProperty()
    @JsonClassType({type: () => [Array, [ContractEventRecord]]})
    public contracts: ContractEventRecord[] = [];

    public calculate(): void {
        this.calcOutputs();
        this.ordersum();
        this.contractsum();
    }
    
    public calcOutputs(): void {
        for (const u of this.utxos) {
            if (u.isConfirmed() && !u.isSpent()) {
                const valueObj = u.getValue();
                if (valueObj !== null) {
                    this.unspent = this.unspent + BigInt(valueObj.getValue().toString());
                }
            } 
        }
    }

    public ordersum(): void {
        for (const orderRecord of this.orders) {
            if (orderRecord.getOfferTokenid() === this.tokenid) {
                this.order = this.order + BigInt(orderRecord.getOfferValue().toString());
            }
        }
    }

    public contractsum(): void {
        for (const c of this.contracts) {
            if (c.getTargetTokenid() === this.tokenid) {
                this.contract = this.contract + (c.getTargetValue() ?? 0n);
            }
        }
    }

    public toString(): string {
        return `Tokensums [ \n tokenid=${this.tokenid},  \n initial=${this.initial}, \n unspent UTXO=${this.unspent}` +
               `, \n order=${this.order}` +
               `, \n contract=${this.contract}` +
               ` \n unspentUTXO.add(order).add(contract) = ${this.unspent + this.order + this.contract}]`;
    }

    public check(): boolean {
        if (NetworkParameters.BIGTANGLE_TOKENID_STRING === this.tokenid) {
            //fee payment, only create reward block will fee to miner
            return this.initial >= (this.unspent + this.order + this.contract);
        } else {
            return this.initial === (this.unspent + this.order + this.contract);
        }
    }

    public toByteArray(): Uint8Array {
        const dos = new UnsafeByteArrayOutputStream();
        try {
            const superBytes = new Uint8Array(super.toByteArray());
            dos.writeBytes(superBytes, 0, superBytes.length);
            dos.writeNBytesString(this.tokenid ?? "");
            const initialBytes = new Uint8Array(Utils.bigIntToBytes(this.initial ));
            dos.writeBytes(initialBytes, 0, initialBytes.length);
            const unspentBytes = new Uint8Array(Utils.bigIntToBytes(this.unspent ));
            dos.writeBytes(unspentBytes, 0, unspentBytes.length);
            const orderBytes = new Uint8Array(Utils.bigIntToBytes(this.order));
            dos.writeBytes(orderBytes, 0, orderBytes.length);
            dos.writeInt(this.utxos.length);
            for (const c of this.utxos) {
                const bytes = new Uint8Array(c.toByteArray());
                dos.writeBytes(bytes, 0, bytes.length);
            }
            dos.writeInt(this.orders.length);
            for (const c of this.orders) {
                const bytes = new Uint8Array(c.toByteArray());
                dos.writeBytes(bytes, 0, bytes.length);
            }
            dos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return dos.toByteArray();
    }
 
    public unspentOrderSum(): bigint {
        return this.unspent + this.order;
    }

    public getTokenid(): string | null {
        return this.tokenid;
    }

    public setTokenid(tokenid: string | null): void {
        this.tokenid = tokenid;
    }

    public getInitial(): bigint {
        return this.initial;
    }

    public setInitial(initial: bigint): void {
        this.initial = initial;
    }

    public getUnspent(): bigint {
        return this.unspent;
    }

    public setUnspent(unspent: bigint): void {
        this.unspent = unspent;
    }

    public getOrder(): bigint {
        return this.order;
    }

    public setOrder(order: bigint): void {
        this.order = order;
    }

    public getUtxos(): UTXO[] {
        return this.utxos;
    }

    public setUtxos(utxos: UTXO[]): void {
        this.utxos = utxos;
    }

    public getOrders(): OrderRecord[] {
        return this.orders;
    }

    public setOrders(orders: OrderRecord[]): void {
        this.orders = orders;
    }

    public getContract(): bigint {
        return this.contract;
    }

    public setContract(contract: bigint): void {
        this.contract = contract;
    }

    public getContracts(): ContractEventRecord[] {
        return this.contracts;
    }

    public setContracts(contracts: ContractEventRecord[]): void {
        this.contracts = contracts;
    }
}
