import { NetworkParameters } from '../params/NetworkParameters';

export enum BlockType {
    BLOCKTYPE_INITIAL,
    BLOCKTYPE_TRANSFER,
    BLOCKTYPE_REWARD,
    BLOCKTYPE_TOKEN_CREATION,
    BLOCKTYPE_USERDATA,
    BLOCKTYPE_CONTRACT_EVENT,
    BLOCKTYPE_GOVERNANCE,
    BLOCKTYPE_FILE,
    BLOCKTYPE_CONTRACT_EXECUTE,
    BLOCKTYPE_CROSSTANGLE,
    BLOCKTYPE_ORDER_OPEN,
    BLOCKTYPE_ORDER_CANCEL,
    BLOCKTYPE_ORDER_EXECUTE,
    BLOCKTYPE_CONTRACTEVENT_CANCEL
}

export interface BlockTypeConfig {
    allowCoinbaseTransaction: boolean;
    maxSize: number;
    requiresCalculation: boolean;
}

// Add methods to the enum
export namespace BlockType {
    export function values(): BlockType[] {
        return [
            BlockType.BLOCKTYPE_INITIAL,
            BlockType.BLOCKTYPE_TRANSFER,
            BlockType.BLOCKTYPE_REWARD,
            BlockType.BLOCKTYPE_TOKEN_CREATION,
            BlockType.BLOCKTYPE_USERDATA,
            BlockType.BLOCKTYPE_CONTRACT_EVENT,
            BlockType.BLOCKTYPE_GOVERNANCE,
            BlockType.BLOCKTYPE_FILE,
            BlockType.BLOCKTYPE_CONTRACT_EXECUTE,
            BlockType.BLOCKTYPE_CROSSTANGLE,
            BlockType.BLOCKTYPE_ORDER_OPEN,
            BlockType.BLOCKTYPE_ORDER_CANCEL,
            BlockType.BLOCKTYPE_ORDER_EXECUTE,
            BlockType.BLOCKTYPE_CONTRACTEVENT_CANCEL
        ];
    }

    export function ordinal(type: BlockType): number {
        return type;
    }

    export function getMaxBlockSize(type: BlockType): number {
        return getBlockTypeConfig(type).maxSize;
    }


    export function allowCoinbaseTransaction(type: BlockType): boolean {
        return getBlockTypeConfig(type).allowCoinbaseTransaction;
    }

    export function requiresCalculation(type: BlockType): boolean {
        return getBlockTypeConfig(type).requiresCalculation;
    }
}

function getBlockTypeConfig(type: BlockType): BlockTypeConfig {
    switch (type) {
        case BlockType.BLOCKTYPE_INITIAL:
            return { allowCoinbaseTransaction: false, maxSize: Number.MAX_SAFE_INTEGER, requiresCalculation: false };
        case BlockType.BLOCKTYPE_TRANSFER:
            return { allowCoinbaseTransaction: false, maxSize: NetworkParameters.MAX_DEFAULT_BLOCK_SIZE, requiresCalculation: false };
        case BlockType.BLOCKTYPE_REWARD:
            return { allowCoinbaseTransaction: false, maxSize: NetworkParameters.MAX_REWARD_BLOCK_SIZE, requiresCalculation: false };
        case BlockType.BLOCKTYPE_TOKEN_CREATION:
            return { allowCoinbaseTransaction: true, maxSize: NetworkParameters.MAX_DEFAULT_BLOCK_SIZE, requiresCalculation: false };
        case BlockType.BLOCKTYPE_USERDATA:
        case BlockType.BLOCKTYPE_CONTRACT_EVENT:
        case BlockType.BLOCKTYPE_GOVERNANCE:
        case BlockType.BLOCKTYPE_FILE:
        case BlockType.BLOCKTYPE_CONTRACT_EXECUTE:
        case BlockType.BLOCKTYPE_CROSSTANGLE:
        case BlockType.BLOCKTYPE_ORDER_OPEN:
        case BlockType.BLOCKTYPE_ORDER_CANCEL:
        case BlockType.BLOCKTYPE_ORDER_EXECUTE:
        case BlockType.BLOCKTYPE_CONTRACTEVENT_CANCEL:
            return { allowCoinbaseTransaction: false, maxSize: NetworkParameters.MAX_DEFAULT_BLOCK_SIZE, requiresCalculation: false };
        default:
            throw new Error('Unknown BlockType');
    }
}

export function allowCoinbaseTransaction(type: BlockType): boolean {
    return getBlockTypeConfig(type).allowCoinbaseTransaction;
}

export function getMaxBlockSize(type: BlockType): number {
    return getBlockTypeConfig(type).maxSize;
}

export function requiresCalculation(type: BlockType): boolean {
    return getBlockTypeConfig(type).requiresCalculation;
}
