import { DataClass } from './DataClass.js';
import { Sha256Hash } from './Sha256Hash.js';
import { Utils } from '../utils/Utils.js';
import { DataInputStream } from '../utils/DataInputStream.js';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream.js';
 
import { JsonProperty, JsonClassType } from "jackson-js";

export class RewardInfo extends DataClass {
    @JsonProperty()
    private chainlength: number = 0;
    
    @JsonProperty()
    private prevRewardHash: Sha256Hash | null = null;
    
    @JsonProperty()
    @JsonClassType({type: () => [Set, [Sha256Hash]]})
    private blocks: Set<Sha256Hash> = new Set();

    @JsonProperty()
    private difficultyTargetReward: number = 0;

    @JsonProperty()
    private ordermatchingResult: Sha256Hash | null = null;

    @JsonProperty()
    private miningResult: Sha256Hash | null = null;
    
    constructor(
        prevRewardHash?: Sha256Hash,
        difficultyTargetReward?: number,
        blocks?: Set<Sha256Hash>,
        chainlength?: number
    ) {
        super();
        if (prevRewardHash) this.prevRewardHash = prevRewardHash;
        if (difficultyTargetReward !== undefined) this.difficultyTargetReward = difficultyTargetReward;
        if (blocks) this.blocks = blocks;
        if (chainlength !== undefined) this.chainlength = chainlength;
    }

    private static readonly LARGEST_HASH = 1n << 256n;

    public getWork(): bigint { // Use native bigint instead of BigInteger
        const target = this.getDifficultyTargetAsInteger();
        // Convert to native bigint division
        return RewardInfo.LARGEST_HASH / (target + 1n);
    }

    public getDifficultyTargetAsInteger(): bigint { // Use native bigint instead of BigInteger
        return Utils.decodeCompactBits(this.difficultyTargetReward);
    }
    
    public setPrevRewardHash(prevRewardHash: Sha256Hash | null): void {
        this.prevRewardHash = prevRewardHash;
    }

    public getPrevRewardHash(): Sha256Hash | null {
        return this.prevRewardHash;
    }

    public getBlocks(): Set<Sha256Hash> {
        return this.blocks;
    }

    public setBlocks(blocks: Set<Sha256Hash>): void {
        this.blocks = blocks;
    }

    public getChainlength(): number {
        return this.chainlength;
    }

    public setChainlength(chainlength: number): void {
        this.chainlength = chainlength;
    }

    public getDifficultyTargetReward(): number {
        return this.difficultyTargetReward;
    }

    public setDifficultyTargetReward(difficultyTargetReward: number): void {
        this.difficultyTargetReward = difficultyTargetReward;
    }

    public getMiningResult(): Sha256Hash | null {
        return this.miningResult;
    }

    public setMiningResult(miningResult: Sha256Hash | null): void {
        this.miningResult = miningResult;
    }

    public getOrdermatchingResult(): Sha256Hash | null {
        return this.ordermatchingResult;
    }

    public setOrdermatchingResult(ordermatchingResult: Sha256Hash | null): void {
        this.ordermatchingResult = ordermatchingResult;
    }

    public toByteArray(): Uint8Array {
        const dos = new UnsafeByteArrayOutputStream();
        try {
            dos.writeLong(this.chainlength);
            const prevRewardHashBytes = this.prevRewardHash ? this.prevRewardHash.getBytes() : Sha256Hash.ZERO_HASH.getBytes();
            dos.writeBytes(prevRewardHashBytes, 0, prevRewardHashBytes.length);
            dos.writeInt(this.blocks.size);
            for (const bHash of this.blocks) {
                const bytes = bHash.getBytes();
                dos.writeBytes(bytes, 0, bytes.length);
            }
            dos.writeLong(this.difficultyTargetReward);
            dos.writeBoolean(this.ordermatchingResult !== null);
            if (this.ordermatchingResult !== null) {
                const bytes = this.ordermatchingResult.getBytes();
                dos.writeBytes(bytes, 0, bytes.length);
            }
            dos.writeBoolean(this.miningResult !== null);
            if (this.miningResult !== null) {
                const bytes = this.miningResult.getBytes();
                dos.writeBytes(bytes, 0, bytes.length);
            }
            
            dos.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return dos.toByteArray();
    }

    public parseChecked(buf: Uint8Array): RewardInfo {
        try {
            return this.parse(buf);
        } catch (e: any) {
            throw new Error(e);
        }
    }

    public parse(buf: Uint8Array): RewardInfo {
        const bain = new DataInputStream(new Uint8Array(buf));
        const r = new RewardInfo();
        try {
            r.chainlength = bain.readLong();
            r.prevRewardHash = Sha256Hash.wrap(bain.readBytes(32));
            const blocksSize = bain.readInt();
            r.blocks = new Set();
            for (let i = 0; i < blocksSize; ++i) {
                const hash = Sha256Hash.wrap(bain.readBytes(32));
                if (hash !== null) {
                    r.blocks.add(hash);
                }
            }
            r.difficultyTargetReward = bain.readLong();
            
            const hasOrderMatching = bain.readBoolean();
            if (hasOrderMatching) {
                r.ordermatchingResult = Sha256Hash.wrap(bain.readBytes(32));
            } 
            
            const hasMiningReward = bain.readBoolean();
            if (hasMiningReward) {
                r.miningResult = Sha256Hash.wrap(bain.readBytes(32));
            } 
            
            bain.close();
        } catch (e: any) {
            throw new Error(e);
        }
        return r;
    }

    public toString(): string {
        return `RewardInfo  \n chainlength=${this.chainlength}, \n prevRewardHash=${this.prevRewardHash}` +
               `, \n prevRewardDifficulty=${this.difficultyTargetReward}` +
               `, \n referenced block size =${this.blocks.size}]`;
    }
}
