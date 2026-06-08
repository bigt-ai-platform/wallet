/*******************************************************************************
 *  Copyright   2018  Inasset GmbH. 
 *  
 *******************************************************************************/
/*
 * Copyright 2011 Google Inc.
 * Copyright 2014 Andreas Schildbach
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Message } from './Message';
import { Sha256Hash } from './Sha256Hash';
import { Utils } from './Utils';
import { VarInt } from './VarInt';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { Transaction } from './Transaction';
import { NetworkParameters } from '../params/NetworkParameters';
import { MessageSerializer } from './MessageSerializer';
import { ProtocolException } from '../exception/ProtocolException';
import { VerificationException } from '../exception/VerificationException';
import { BlockType } from './BlockType';
import { Address } from './Address';
import { RewardInfo } from './RewardInfo';
import { OrderOpenInfo } from './OrderOpenInfo';
import { TokenInfo } from './TokenInfo';
import { ContractExecutionResult } from './ContractExecutionResult';
import { OrderExecutionResult } from './OrderExecutionResult';
import { ScriptBuilder } from '../script/ScriptBuilder';
import { ECKey } from './ECKey';
import { TransactionInput } from './TransactionInput';
import { TransactionOutput } from './TransactionOutput';
import { TransactionOutPoint } from './TransactionOutPoint';
;

/**
 * <p>
 * A block is a group of transactions, and is one of the fundamental data
 * structures of the Bitcoin system. It records a set of {@link Transaction}s
 * together with some data that links it into a place in the global block
 * structure, and proves that a difficult calculation was done over its
 * contents. See <a href="http://bitcoin.net/bigtangle.pdf">the white paper</a>
 * for more detail on blocks.
 * <p/>
 *
 * <p>
 * To get a block, you can either build one from the raw bytes you can get from
 * another implementation, or request one specifically using
 * </p>
 * 
 */
export class Block extends Message {
    private static readonly log = console;

    // Fields defined as part of the protocol format.
    private version: number = 0;
    private prevBlockHash: Sha256Hash;
    private prevBranchBlockHash: Sha256Hash; // second predecessor
    private merkleRoot: Sha256Hash | null;
    private time: number = 0;
    private difficultyTarget: number = 0; // "nBits"
    private lastMiningRewardBlock: number = 0; // last approved reward blocks max
    private nonce: number = 0;
    private minerAddress: Uint8Array; // Utils.sha256hash160
    private blockType: BlockType;
    
    public setBlockType(blockType: BlockType): void {
        this.unCacheHeader();
        this.blockType = blockType;
        this.hash = null;
    }
    
    public setMinerAddress(minerAddress: Uint8Array): void {
        this.unCacheHeader();
        this.minerAddress = minerAddress;
        this.hash = null;
    }
    
    public setDifficultyTarget(difficultyTarget: number): void {
        this.unCacheHeader();
        this.difficultyTarget = difficultyTarget;
        this.hash = null;
    }
    private height: number = 0;
    // If NetworkParameters.USE_EQUIHASH, this field will contain the PoW
    // solution

    /** If null, it means this object holds only the headers. */
    private transactions: Transaction[] | null = null;
    
    public getTransactions(): Transaction[] | null {
        return this.transactions;
    }

    /** Stores the hash of the block. If null, getHash() will recalculate it. */
    private hash: Sha256Hash | null = null;

    protected headerBytesValid: boolean = false;
    protected transactionBytesValid: boolean = false;

    // Blocks can be encoded in a way that will use more bytes than is optimal
    // (due to VarInts having multiple encodings)
    // MAX_BLOCK_SIZE must be compared to the optimal encoding, not the actual
    // encoding, so when parsing, we keep track
    // of the size of the ideal encoding in addition to the actual message size
    // (which Message needs)
    protected optimalEncodingMessageSize: number = 0;

    // Used to make transactions unique.
    private static txCounter: number = 0;

    // Static random generator
    private static gen = Math.random;

    public constructor(params: NetworkParameters) {
        super(params);
        this.prevBlockHash = Sha256Hash.ZERO_HASH;
        this.prevBranchBlockHash = Sha256Hash.ZERO_HASH;
        this.merkleRoot = null;
        this.minerAddress = new Uint8Array(20);
        this.blockType = BlockType.BLOCKTYPE_TRANSFER;
    }

    public static setBlock2(params: NetworkParameters, setVersion: number): Block {
        const block = Block.setBlock7(params, Sha256Hash.ZERO_HASH, Sha256Hash.ZERO_HASH,
            BlockType.BLOCKTYPE_TRANSFER, 0, Utils.encodeCompactBits(params.getMaxTarget()), 0);
        block.version = setVersion;
        block.length = NetworkParameters.HEADER_SIZE;
        block.transactions = null;
        return block;
    }

    public static createBlock(networkParameters: NetworkParameters, r1: Block, r2: Block): Block {
        const block = Block.setBlock7(networkParameters, r1.getHash(), r2.getHash(),
            BlockType.BLOCKTYPE_TRANSFER, Math.max(r1.getTimeSeconds(), r2.getTimeSeconds()),
            Math.max(r1.getLastMiningRewardBlock(), r2.getLastMiningRewardBlock()),
            r1.getLastMiningRewardBlock() > r2.getLastMiningRewardBlock() ? r1.getDifficultyTarget()
                : r2.getDifficultyTarget());
        block.setHeight(Math.max(r1.getHeight(), r2.getHeight()) + 1);

        return block;
    }

    public static setBlock7(params: NetworkParameters, prevBlockHash: Sha256Hash, prevBranchBlockHash: Sha256Hash,
        blocktype: BlockType, minTime: number, lastMiningRewardBlock: number, difficultyTarget: number): Block {
        const a = new Block(params);
        // Set up a few basic things. We are not complete after this though.
        a.version = NetworkParameters.BLOCK_VERSION_GENESIS;
        a.difficultyTarget = difficultyTarget;
        a.lastMiningRewardBlock = lastMiningRewardBlock;
        a.time = Date.now() / 1000;
        if (a.time < minTime)
            a.time = minTime;
        a.prevBlockHash = prevBlockHash;
        a.prevBranchBlockHash = prevBranchBlockHash;

        a.blockType = blocktype;
        a.minerAddress = new Uint8Array(20);
        a.length = NetworkParameters.HEADER_SIZE;
        a.transactions = [];
        return a;
    }

    
    /**
     * Construct a block object from the Bitcoin wire format.
     * 
     * @param params       NetworkParameters object.
     * @param payloadBytes the payload to extract the block from.
     * @param offset       The location of the first payload byte within the array.
     * @param serializer   the serializer to use for this message.
     * @param length       The length of message if known. Usually this is provided
     *                     when deserializing of the wire as the length will be
     *                     provided as part of the header. If unknown then set to
     *                     Message.UNKNOWN_LENGTH
     */
    public static setBlock5(params: NetworkParameters, payloadBytes: Uint8Array, offset: number,
        serializer: MessageSerializer<NetworkParameters>, length: number): Block {
        const a = new Block(params);
        a.setValues5(params, payloadBytes, offset, serializer, length);
        return a;
    }

    public isBLOCKTYPE_INITIAL(): boolean {
        return this.getBlockType() === BlockType.BLOCKTYPE_INITIAL;
    }

    /**
     * Parse transactions from the block.
     * 
     * @param transactionsOffset Offset of the transactions within the block. Useful
     *                           for non-Bitcoin chains where the block header may
     *                           not be a fixed size.
     */
    protected parseTransactions(transactionsOffset: number): void {
        this.cursor = transactionsOffset;
        this.optimalEncodingMessageSize = NetworkParameters.HEADER_SIZE;
        if (this.payload && this.payload.length === this.cursor) {
            // This message is just a header, it has no transactions.
            this.transactionBytesValid = false;
            return;
        }

        try {
            const numTransactions = Number(this.readVarInt());
            this.optimalEncodingMessageSize += VarInt.sizeOf(numTransactions);
            this.transactions = [];
            
            for (let i = 0; i < numTransactions; i++) {
                const tx = Transaction.fromTransaction6(
                    this.params!, 
                    this.payload!, 
                    this.cursor, 
                    this, 
                    this.serializer!, 
                    Message.UNKNOWN_LENGTH
                );
                
                // Allow exact fit (cursor + size == payload.length)
                if (this.cursor + tx.getMessageSize() > this.payload!.length) {
                    throw new ProtocolException(`Transaction data exceeds payload length: cursor=${this.cursor}, txSize=${tx.getMessageSize()}, payloadLength=${this.payload!.length}`);
                }
                
                this.transactions.push(tx);
                this.cursor += tx.getMessageSize();
                this.optimalEncodingMessageSize += tx.getOptimalEncodingMessageSize();
            }
            
            this.transactionBytesValid = this.serializer?.isParseRetainMode() ?? false;
           
        } catch (e) {
            console.error("Error parsing transactions:", e);
            this.transactionBytesValid = false;
            throw e;
        }
    }

    protected parse(lengthArg: number = Message.UNKNOWN_LENGTH): void {
        // header
        this.cursor = this.offset;
        this.version = this.readUint32();
        this.prevBlockHash = this.readHash();
        this.prevBranchBlockHash = this.readHash();
        this.merkleRoot = this.readHash();
        this.time = Number(this.readInt64());
        this.difficultyTarget = Number(this.readInt64());
        this.lastMiningRewardBlock = Number(this.readInt64());
        this.nonce = this.readUint32();
        
        // Read miner address - handle potentially shorter addresses
        const addressBytes = this.readBytes(20);
        if (addressBytes.length < 20) {
            // Pad with zeros if address is shorter than 20 bytes
            const padded = new Uint8Array(20);
            padded.set(addressBytes);
            this.minerAddress = padded;
        } else {
            this.minerAddress = addressBytes;
        }
        
        this.blockType = BlockType.values()[this.readUint32()];
        this.height = Number(this.readInt64());
        
        // Calculate hash only if we have enough data for the header
        if (this.cursor <= this.payload!.length) {
            this.hash = Sha256Hash.wrapReversed(Sha256Hash.hashTwice(new Uint8Array(this.payload!.subarray(this.offset, this.cursor))));
        }
        this.headerBytesValid = this.serializer!.isParseRetainMode();
        
        // Only parse transactions if we have more data after the header
        if (this.cursor < this.payload!.length) {
            this.parseTransactions(this.cursor);
        }
        // length must include entire payload if given, not just header
        if (lengthArg !== Message.UNKNOWN_LENGTH) {
            this.length = lengthArg;
        } else {
            this.length = this.payload ? this.payload.length - this.offset : this.cursor - this.offset;
        }
    }

    public getOptimalEncodingMessageSize(): number {
        if (this.optimalEncodingMessageSize !== 0)
            return this.optimalEncodingMessageSize;
        this.optimalEncodingMessageSize = this.bitcoinSerialize().length;
        return this.optimalEncodingMessageSize;
    }

    // default for testing
    writeHeader(stream: any): void {
        // try for cached write first
        if (this.headerBytesValid && this.payload && this.payload.length >= this.offset + NetworkParameters.HEADER_SIZE) {
            stream.write(new Uint8Array(this.payload.subarray(this.offset, this.offset + NetworkParameters.HEADER_SIZE)));
            return;
        }

        // fall back to manual write
        Utils.uint32ToByteStreamLE(this.version, stream);
        stream.write(this.prevBlockHash.getReversedBytes());
        stream.write(this.prevBranchBlockHash.getReversedBytes());
        stream.write(this.getMerkleRoot().getReversedBytes());
        Utils.int64ToByteStreamLE(BigInt(this.time), stream);
        Utils.int64ToByteStreamLE(BigInt(this.difficultyTarget), stream);
        Utils.int64ToByteStreamLE(BigInt(this.lastMiningRewardBlock), stream);
        Utils.uint32ToByteStreamLE(this.nonce, stream);
        stream.write(this.minerAddress);
        Utils.uint32ToByteStreamLE(BlockType.ordinal(this.blockType), stream);
        Utils.int64ToByteStreamLE(BigInt(this.height), stream);
    }

    writePoW(stream: any): void {
        // Empty implementation
    }

    private writeTransactions(stream: any): void {
        // check for no transaction conditions first
        if (this.transactions === null) {
            return;
        }

        // confirmed we must have transactions either cached or as objects.
        // Always serialize transactions from objects to avoid truncation
        stream.write(new VarInt(this.transactions.length).encode());
        for (const tx of this.transactions) {
            tx.bitcoinSerialize(stream);
        }
    }

    /**
     * Special handling to check if we have a valid byte array for both header and
     * transactions
     */
    public bitcoinSerialize(): Uint8Array {
        // we have completely cached byte array.
        if (this.headerBytesValid && this.transactionBytesValid) {
            if (this.length === this.payload!.length) {
                return this.payload!;
            } else {
                // byte array is offset so copy out the correct range.
                const buf = new Uint8Array(this.length);
                buf.set(this.payload!.subarray(this.offset, this.offset + this.length));
                return buf;
            }
        }

        // At least one of the two cacheable components is invalid
        // so fall back to stream write since we can't be sure of the length.
        const stream = new UnsafeByteArrayOutputStream(
            this.length === Message.UNKNOWN_LENGTH ? NetworkParameters.HEADER_SIZE + this.guessTransactionsLength() : this.length);
        try {
            this.writeHeader(stream);
            this.writePoW(stream);
            this.writeTransactions(stream);
        } catch (e) {
            // Cannot happen, we are serializing to a memory stream.
        }
        const result = stream.toByteArray();
        // Update the length to match the actual serialized length
        this.length = result.length;
        return result;
    }

    protected bitcoinSerializeToStream(stream: any): void {
        this.writeHeader(stream);
        this.writePoW(stream);
        // We may only have enough data to write the header and PoW.
        this.writeTransactions(stream);
    }

    /**
     * Provides a reasonable guess at the byte length of the transactions part of
     * the block. The returned value will be accurate in 99% of cases and in those
     * cases where not will probably slightly oversize. This is used to preallocate
     * the underlying byte array for a ByteArrayOutputStream. If the size is under
     * the real value the only penalty is resizing of the underlying byte array.
     */
    private guessTransactionsLength(): number {
        if (this.transactionBytesValid && this.payload)
            return this.payload.length - NetworkParameters.HEADER_SIZE;
        if (this.transactions === null)
            return 0;
        let len = VarInt.sizeOf(this.transactions.length);
        for (const tx of this.transactions) {
            // 255 is just a guess at an average tx length
            len += tx.getLength() === Message.UNKNOWN_LENGTH ? 255 : tx.getLength();
        }
        return len;
    }

    protected unCache(): void {
        // Since we have alternate uncache methods to use internally this will
        // only ever be called by a child
        // transaction so we only need to invalidate that part of the cache.
        this.unCacheTransactions();
    }

    private unCacheHeader(): void {
        this.headerBytesValid = false;
        if (!this.transactionBytesValid)
            this.payload = null;
        this.hash = null;
    }

    private unCacheTransactions(): void {
        this.transactionBytesValid = false;
        if (!this.headerBytesValid)
            this.payload = null;
        // Current implementation has to uncache headers as well as any change
        // to a tx will alter the merkle root. In
        // future we can go more granular and cache merkle root separately so
        // rest of the header does not need to be
        // rewritten.
        this.unCacheHeader();
        // Clear merkleRoot last as it may end up being parsed during
        // unCacheHeader().
        this.merkleRoot = null as any;
    }

    /**
     * Calculates the block hash by serializing the block and hashing the resulting
     * bytes.
     */
    private calculateHash(): Sha256Hash {
        const bos = new UnsafeByteArrayOutputStream(NetworkParameters.HEADER_SIZE);
        this.writeHeader(bos);
        return Sha256Hash.wrapReversed(Sha256Hash.hashTwice(new Uint8Array(bos.toByteArray())));
    }

    /**
     * Calculates the hash relevant for PoW difficulty checks.
     */
    private calculatePoWHash(): Sha256Hash {
        const bos = new UnsafeByteArrayOutputStream(NetworkParameters.HEADER_SIZE);
        this.writeHeader(bos);
        return Sha256Hash.wrapReversed(Sha256Hash.hashTwice(new Uint8Array(bos.toByteArray())));
    }

    /**
     * Returns the hash of the block (which for a valid, solved block should be
     * below the target) in the form seen on the block explorer. If you call this on
     * block 1 in the mainnet chain you will get
     * "00000000839a8e6886ab5951d76f411475428afc90947ee320161bbf18eb6048".
     */
    public getHashAsString(): string {
        return this.getHash().toString();
    }

    /**
     * Returns the hash of the block (which for a valid, solved block should be
     * below the target). Big endian.
     */
    public getHash(): Sha256Hash {
        if (this.hash === null)
            this.hash = this.calculateHash();
        return this.hash;
    }

    /**
     * The number that is one greater than the largest representable SHA-256 hash.
     */
    private static readonly LARGEST_HASH = BigInt(1) << BigInt(256);

    /**
     * Returns the work represented by this block.
     * <p>
     *
     * Work is defined as the number of tries needed to solve a block in the average
     * case. Consider a difficulty target that covers 5% of all possible hash
     * values. Then the work of the block will be 20. As the target gets lower, the
     * amount of work goes up.
     */
    public getWork(): bigint {
        const target = this.getDifficultyTargetAsInteger();
        return Block.LARGEST_HASH / (target + BigInt(1));
    }

    /** Returns a copy of the block */
    public cloneAsHeader(): Block {
        const block = Block.setBlock2(this.params!, NetworkParameters.BLOCK_VERSION_GENESIS);
        this.copyBitcoinHeaderTo(block);
        return block;
    }

    /** Copy the block into the provided block. */
    protected copyBitcoinHeaderTo(block: Block): void {
        block.nonce = this.nonce;
        block.prevBlockHash = this.prevBlockHash;
        block.prevBranchBlockHash = this.prevBranchBlockHash;
        // Ensure we're not copying null merkleRoot
        block.merkleRoot = this.merkleRoot || Sha256Hash.ZERO_HASH;
        block.version = this.version;
        block.time = this.time;
        block.difficultyTarget = this.difficultyTarget;
        block.lastMiningRewardBlock = this.lastMiningRewardBlock;
        block.minerAddress = this.minerAddress;

        block.blockType = this.blockType;
        block.transactions = null;
        block.hash = this.getHash();
    }

    /**
     * Returns a multi-line string containing a description of the contents of the
     * block. Use for debugging purposes only.
     */
    public toString(): string {
        let s = "";
        s += "   hash: " + this.getHashAsString() + '\n';
        s += "   version: " + this.version;
        s += "   time: " + this.time + " (" + Utils.dateTimeFormat(this.time * 1000) + ")\n";
        s += "   height: " + this.height + "\n";
        s += "   chain length: " + this.getLastMiningRewardBlock() + "\n";
        s += "   previous: " + this.getPrevBlockHash() + "\n";
        s += "   branch: " + this.getPrevBranchBlockHash() + "\n";
        s += "   merkle: " + this.getMerkleRoot() + "\n";
        s += "   difficulty target (nBits):    " + this.difficultyTarget + "\n";
        s += "   nonce: " + this.nonce + "\n";
        if (this.minerAddress !== null)
            s += "   mineraddress: " + new Address(this.params!, this.params!.getAddressHeader(), new Uint8Array(this.minerAddress)).toBase58() + "\n";

        s += "   blocktype: " + this.blockType + "\n";
        if (this.transactions !== null && this.transactions.length > 0) {
            s += "   " + this.transactions.length + " transaction(s):\n";
            for (const tx of this.transactions) {
                s += tx.toString();
            }
        }
        if (this.blockType === BlockType.BLOCKTYPE_REWARD) {
            try {
                if (this.transactions !== null && this.transactions.length > 0) {
                    const rewardInfo = new RewardInfo().parse(this.transactions[0].getData()!);
                    s += rewardInfo.toString();
                }
            } catch (e) {
                // ignore
            }
        }
        if (this.blockType === BlockType.BLOCKTYPE_ORDER_OPEN) {
            try {
                const info = new OrderOpenInfo().parse(this.transactions![0].getData()!);
                s += info.toString();
            } catch (e) {
                // ignore
            }
        }
        if (this.blockType === BlockType.BLOCKTYPE_TOKEN_CREATION) {
            try {
                const info = new TokenInfo().parse(this.transactions![0].getData()!);
                s += info.toString();
            } catch (e) {
                // ignore
            }
        }
        if (this.blockType === BlockType.BLOCKTYPE_CONTRACT_EXECUTE) {
            try {
                const info = new ContractExecutionResult().parse(this.transactions![0].getData()!);
                s += info.toString();
            } catch (e) {
                // ignore
            }
        }
        if (this.blockType === BlockType.BLOCKTYPE_ORDER_EXECUTE) {
            try {
                const info = new OrderExecutionResult().parse(this.transactions![0].getData()!);
                s += info.toString();
            } catch (e) {
                // ignore
            }
        }
        return s;
    }

    /**
     * <p>
     * Finds a value of nonce and equihashProof if using Equihash that validates
     * correctly.
     */
    public solveTarget(target?: bigint): void {
        // Add randomness to prevent new empty blocks from same miner with same
        // approved blocks to be the same
        // Constrain nonce to 32-bit unsigned integer range
        this.setNonce(Math.floor(Block.gen() * 0xFFFFFFFF));

        // Use provided target or calculate from difficulty
        const powTarget = target || this.getDifficultyTargetAsInteger();

        // Limit the number of iterations to prevent infinite loops
        let iterations = 0;
        const MAX_ITERATIONS = 1000000; // 1 million iterations should be enough

        while (iterations < MAX_ITERATIONS) {
            try {
                // Is our proof of work valid yet?
                if (this.checkProofOfWork(false, powTarget))
                    return;

                // No, so increment the nonce and try again.
                // Constrain nonce to 32-bit unsigned integer range
                let newNonce = this.getNonce() + 1;
                if (newNonce > 0xFFFFFFFF) {
                    newNonce = 0; // Wrap around to 0
                }
                this.setNonce(newNonce);
                
                iterations++;
            } catch (e) {
                throw new Error("Runtime exception"); // Cannot happen.
            }
        }
        
        // If we reach here, we couldn't find a solution within the iteration limit
        throw new Error("Failed to solve block within iteration limit");
    }
    
    // Alias for solve to maintain backward compatibility
    public solve(): void {
        this.solveTarget(this.getDifficultyTargetAsInteger());
    }

    /**
     * Returns the difficulty target as a 256 bit value that can be compared to a
     * SHA-256 hash. Inside a block the target is represented using a compact form.
     * If this form decodes to a value that is out of bounds, an exception is
     * thrown.
     */
    public getDifficultyTargetAsInteger(): bigint {
        const target = Utils.decodeCompactBits(this.difficultyTarget);
        if (target < 0 || target > this.params!.getMaxTarget())
            throw new VerificationException("Difficulty target out of bounds");
        return target;
    }

    /**
     * Returns true if the PoW of the block is OK
     */
    public checkProofOfWork(throwException: boolean, target?: bigint): boolean {
        // Use provided target or calculate from difficulty
        const powTarget = target || this.getDifficultyTargetAsInteger();
        
        // No PoW for genesis block
        if (this.getBlockType() === BlockType.BLOCKTYPE_INITIAL) {
            return true;
        }

        const h = this.calculatePoWHash().toBigInteger();

        if (h > powTarget) {
            if (throwException)
                throw new VerificationException("Proof of work failed");
            return false;
        }

        return true;
    }

    private checkTimestamp(): void {
        // Allow injection of a fake clock to allow unit testing.
        const currentTime = Math.floor(Date.now() / 1000);
        if (this.time > currentTime + NetworkParameters.ALLOWED_TIME_DRIFT)
            throw new VerificationException("Time traveler");
    }

    private checkSigOps(): void {
        // Check there aren't too many signature verifications in the block.
        // This is an anti-DoS measure, see the
        // comments for MAX_BLOCK_SIGOPS.
        let sigOps = 0;
        if (this.transactions === null)
            return;
        for (const tx of this.transactions) {
            sigOps += tx.getSigOpCount();
        }
        if (sigOps > NetworkParameters.MAX_BLOCK_SIGOPS)
            throw new VerificationException("Too many signature operations");
    }

    private checkMerkleRoot(): void {
        const calculatedRoot = this.calculateMerkleRoot();
        // Handle possible null merkleRoot
        if (this.merkleRoot === null) {
            this.merkleRoot = calculatedRoot;
        }
        if (!calculatedRoot.equals(this.merkleRoot)) {
            Block.log.error("Merkle tree did not verify");
            throw new VerificationException.MerkleRootMismatchException();
        }
    }
    
    
    public getMinerAddress(): Uint8Array {
        return this.minerAddress;
    }

    private calculateMerkleRoot(): Sha256Hash {
        const tree = this.buildMerkleTree();
        if (tree.length === 0)
            return Sha256Hash.ZERO_HASH;
        return Sha256Hash.wrap(new Uint8Array(tree[tree.length - 1]));
    }

    public getMerkleRoot(): Sha256Hash {
        if (this.merkleRoot === null) {
            this.merkleRoot = this.calculateMerkleRoot();
        }
        return this.merkleRoot;
    }

    private buildMerkleTree(): Uint8Array[] {
        // The Merkle root is based on a tree of hashes calculated from the
        // transactions:
        //
        // root
        // / \
        // A B
        // / \ / \
        // t1 t2 t3 t4
        //
        // The tree is represented as a list: t1,t2,t3,t4,A,B,root where each
        // entry is a hash.
        //
        // The hashing algorithm is double SHA-256. The leaves are a hash of the
        // serialized contents of the transaction.
        // The interior nodes are hashes of the concenation of the two child
        // hashes.
        //
        // This structure allows the creation of proof that a transaction was
        // included into a block without having to
        // provide the full block contents. Instead, you can provide only a
        // Merkle branch. For example to prove tx2 was
        // in a block you can just provide tx2, the hash(tx1) and B. Now the
        // other party has everything they need to
        // derive the root, which can be checked against the block header. These
        // proofs aren't used right now but
        // will be helpful later when we want to download partial block
        // contents.
        //
        // Note that if the number of transactions is not even the last tx is
        // repeated to make it so (see
        // tx3 above). A tree with 5 transactions would look like this:
        //
        // root
        // / \
        // 1 5
        // / \ / \
        // 2 3 4 4
        // / \ / \ / \
        // t1 t2 t3 t4 t5 t5
        const tree: Uint8Array[] = [];
        if (this.transactions === null)
            this.transactions = [];
        // Start by adding all the hashes of the transactions as leaves of the
        // tree.
        for (const t of this.transactions) {
            tree.push(t.getHash().getBytes());
        }
        let levelOffset = 0; // Offset in the list where the currently processed
                                // level starts.
        // Step through each level, stopping when we reach the root (levelSize
        // == 1).
        for (let levelSize = this.transactions.length; levelSize > 1; levelSize = Math.floor((levelSize + 1) / 2)) {
            // For each pair of nodes on that level:
            for (let left = 0; left < levelSize; left += 2) {
                // The right hand node can be the same as the left hand, in the
                // case where we don't have enough
                // transactions.
                const right = Math.min(left + 1, levelSize - 1);
                const leftBytes = tree[levelOffset + left];
                const rightBytes = tree[levelOffset + right];
                const leftReversed = Utils.reverseBytes(new Uint8Array(leftBytes));
                const rightReversed = Utils.reverseBytes(new Uint8Array(rightBytes));
                const hashResult = Sha256Hash.hashTwiceRanges(
                    leftReversed, 0, leftReversed.length,
                    rightReversed, 0, rightReversed.length
                );
                tree.push(new Uint8Array(Utils.reverseBytes(hashResult)));
            }
            // Move to the next level.
            levelOffset += levelSize;
        }
        return tree;
    }

    /**
     * Checks the block data to ensure it follows the rules laid out in the network
     * parameters. Specifically, throws an exception if the proof of work is
     * invalid, or if the timestamp is too far from what it should be. This is
     * <b>not</b> everything that is required for a block to be valid, only what is
     * checkable independent of the chain and without a transaction index.
     *
     */
    public verifyHeader(): void {
        // Prove that this block is OK. It might seem that we can just ignore
        // most of these checks given that the
        // network is also verifying the blocks, but we cannot as it'd open us
        // to a variety of obscure attacks.
        //
        // Firstly we need to ensure this block does in fact represent real work
        // done. If the difficulty is high
        // enough, it's probably been done by the network.
        this.checkProofOfWork(true);
        this.checkTimestamp();
    }

    /**
     * Checks the block contents formally
     *
     * @throws VerificationException if there was an error verifying the block.
     */
    public verifyTransactions(): void {
        // Now we need to check that the body of the block actually matches the
        // headers. The network won't generate
        // an invalid block, but if we didn't validate this then an untrusted
        // man-in-the-middle could obtain the next
        // valid block from the network and simply replace the transactions in
        // it with their own fictional
        // transactions that reference spent or non-existant inputs.
        // if (transactions.isEmpty())
        // throw new VerificationException("Block had no transactions");
        if (this.getOptimalEncodingMessageSize() > this.getMaxBlockSize())
            throw new VerificationException("Block size too large");
        this.checkMerkleRoot();
        this.checkSigOps();
        if (this.transactions === null)
            return;
        for (const transaction of this.transactions) {
            if (!this.allowCoinbaseTransaction() && transaction.isCoinBase()) {
                throw new VerificationException("Coinbase transaction not allowed");
            }

            transaction.verify();
        }
    }

    private getMaxBlockSize(): number {
        return BlockType.getMaxBlockSize(this.blockType);
    }

    /**
     * Verifies both the header and that the transactions hash to the merkle root.
     *
     */
    public verify(): void {
        this.verifyHeader();
        this.verifyTransactions();
    }

    public equals(o: any): boolean {
        if (this === o)
            return true;
        if (o === null || !(o instanceof Block))
            return false;
        return this.getHash().equals((o as Block).getHash());
    }

    public hashCode(): number {
        return this.getHash().hashCode();
    }


    /** Exists only for unit testing. */
    setMerkleRoot(value: Sha256Hash | null): void {
        this.unCacheHeader();
        this.merkleRoot = value;
        this.hash = null;
    }

    /**
     * Adds a transaction to this block. The nonce and merkle root are invalid after
     * this.
     */
    public addTransaction(t: Transaction): void {
        this.unCacheTransactions();
        if (this.transactions === null) {
            this.transactions = [];
        }
        t.setParent(this);
        this.transactions.push(t);
        // TODO: Implement adjustLength
        // this.adjustLength(transactions.size(), t.length);
        // Force a recalculation next time the values are needed.
        this.setMerkleRoot( null);
        this.hash = null;
    }

    /**
     * Returns the version of the block data structure as defined by the Bitcoin
     * protocol.
     */
    public getVersion(): number {
        return this.version;
    }

    /**
     * Returns the hash of the previous trunk block in the chain, as defined by the
     * block header.
     */
    public getPrevBlockHash(): Sha256Hash {
        return this.prevBlockHash;
    }

    public setPrevBlockHash(prevBlockHash: Sha256Hash): void {
        this.unCacheHeader();
        this.prevBlockHash = prevBlockHash;
        this.hash = null;
    }

    /**
     * Returns the hash of the previous branch block in the chain, as defined by the
     * block header.
     */
    public getPrevBranchBlockHash(): Sha256Hash {
        return this.prevBranchBlockHash;
    }

    public setPrevBranchBlockHash(prevBranchBlockHash: Sha256Hash): void {
        this.unCacheHeader();
        this.prevBranchBlockHash = prevBranchBlockHash;
        this.hash = null;
    }

    /**
     * Returns the time at which the block was solved and broadcast, according to
     * the clock of the solving node. This is measured in seconds since the UNIX
     * epoch (midnight Jan 1st 1970).
     */
    public getTimeSeconds(): number {
        return this.time;
    }

    /**
     * Returns the time at which the block was solved and broadcast, according to
     * the clock of the solving node.
     */
    public getTime(): Date {
        return new Date(this.getTimeSeconds() * 1000);
    }

    public setTime(time: number): void {
        this.unCacheHeader();
        this.time = time;
        this.hash = null;
    }

    /**
     * Returns the nonce, an arbitrary value that exists only to make the hash of
     * the block header fall below the difficulty target.
     */
    public getNonce(): number {
        return this.nonce;
    }

    /** Sets the nonce and clears any cached data. */
    public setNonce(nonce: number): void {
        this.unCacheHeader();
        this.nonce = nonce;
        this.hash = null;
    }

    public allowCoinbaseTransaction(): boolean {
        // Always allow coinbase transactions for initial blocks
        if (this.blockType === BlockType.BLOCKTYPE_INITIAL) {
            return true;
        }
        return BlockType.allowCoinbaseTransaction(this.blockType);
    }


    public getLastMiningRewardBlock(): number {
        return this.lastMiningRewardBlock;
    }

    public getDifficultyTarget(): number {
        return this.difficultyTarget;
    }

    public getHeight(): number {
        return this.height;
    }

    public getBlockType(): BlockType {
        return this.blockType;
    }

    public setHeight(height: number): void {
        this.unCacheHeader();
        this.height = height;
        this.hash = null;
    }

    /**
     * Add a coinbase transaction to this block.
     * This is used for token creation and other coinbase operations.
     */
    public addCoinbaseTransaction(pubKeyTo: Uint8Array, value: any, tokenInfo: TokenInfo | null = null, memoInfo: any | null = null): void {
        this.unCacheTransactions();
        this.transactions ??= [];

        const coinbase = new Transaction(this.params!);
        if (tokenInfo != null) {
            coinbase.setDataClassName("TokenInfo");  // Using class name instead of DataClassName.TOKEN.name()
            const buf = tokenInfo.toByteArray();
            coinbase.setData(buf);
        }
        coinbase.setMemo(memoInfo ? memoInfo.toString() : null);
        
        // Create script builder to add counter data to scriptSig
        const inputBuilder = new ScriptBuilder();
        // Add a simple counter to distinguish transactions (simplified from Java)
        const counterBytes = new Uint8Array([Block.txCounter, Block.txCounter >> 8]);
        Block.txCounter = (Block.txCounter + 1) % 65536; // Keep counter within 16-bit range
        inputBuilder.data(counterBytes);

        // Create the coinbase transaction input with counter data
        // In Bitcoin, coinbase transaction inputs have special characteristics
        // They have a zero hash for previous output (all zeros) and index 0xFFFFFFFF
        const scriptBytes = inputBuilder.build().getProgram();
        const input = TransactionInput.fromScriptBytes(this.params!, coinbase, scriptBytes);
        
        // For a proper coinbase transaction, the outpoint in the input should have special values
        // The outpoint should have zero hash and index 0xFFFFFFFF (0xFFFFFFFF)
        const outpoint = TransactionOutPoint.fromTransactionOutPoint4(
            this.params!,
            0xFFFFFFFF, // -1 when interpreted as signed 32-bit, special value for coinbase
            Sha256Hash.ZERO_HASH, // zero tx hash
            Sha256Hash.ZERO_HASH  // zero block hash
        );
        input.setOutpoint(outpoint);
        
        coinbase.addInput1(input);

        // Create output to specified public key - ensure the correct token ID and value are used
        const ecKey = ECKey.fromPublic(pubKeyTo);
        const scriptPubKey = ScriptBuilder.createOutputScript(ecKey);
        // Create output with the value that contains the correct token ID and amount
        // Ensure the value object is properly constructed to avoid serialization issues
        const output = new TransactionOutput(this.params!, coinbase, value, scriptPubKey.getProgram());

        coinbase.addOutput(output);

        this.transactions.push(coinbase);
        coinbase.setParent(this);
        // Note: Simplified length calculation
        // coinbase.length = coinbase.unsafeBitcoinSerialize().length;
        // this.adjustLength(this.transactions.length, coinbase.length);
    }
}

// Add static counter for transaction uniqueness
(Block as any).txCounter = 0;
