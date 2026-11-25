// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class VerificationException extends Error {
    constructor(message?: string, cause?: Error) {
        super(message);
        this.name = "VerificationException";
        Object.setPrototypeOf(this, VerificationException.prototype);
        if (cause) {
            this.cause = cause;
        }
    }
    public cause?: Error;
}

export namespace VerificationException {
    export class InfeasiblePrototypeException extends VerificationException {
        constructor(message: string) { super(message); this.name = "InfeasiblePrototypeException"; }
    }
    export class LargerThanMaxBlockSize extends VerificationException {
        constructor() { super("Message larger than MAX_BLOCK_SIZE"); this.name = "LargerThanMaxBlockSize"; }
    }
    export class DuplicatedOutPoint extends VerificationException {
        constructor() { super("Duplicated outpoint"); this.name = "DuplicatedOutPoint"; }
    }
    export class NegativeValueOutput extends VerificationException {
        constructor() { super("Transaction output negative"); this.name = "NegativeValueOutput"; }
    }
    export class CoinbaseScriptSizeOutOfRange extends VerificationException {
        constructor() { super("Coinbase script size out of range"); this.name = "CoinbaseScriptSizeOutOfRange"; }
    }
    export class HeightOutOfRange extends VerificationException {
        constructor() { super("Transaction height out of range"); this.name = "HeightOutOfRange"; }
    }
    export class UnexpectedCoin extends VerificationException {
        constructor() { super("Unexpected coin"); this.name = "UnexpectedCoin"; }
    }
    export class EmptyScriptSig extends VerificationException {
        constructor() { super("Empty scriptSig"); this.name = "EmptyScriptSig"; }
    }
    export class MerkleRootMismatchException extends VerificationException {
        constructor() { super("Merkle root mismatch"); this.name = "MerkleRootMismatchException"; }
    }
    export class MissingSignatureException extends VerificationException {
        constructor() { super("Missing signature"); this.name = "MissingSignatureException"; }
    }
}
