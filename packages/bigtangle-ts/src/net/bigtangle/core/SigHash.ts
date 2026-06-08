/**
 * These constants are a part of a scriptSig signature on the inputs. They
 * define the details of how a transaction can be redeemed, specifically, they
 * control how the hash of the transaction is calculated.
 */
export enum SigHash {
    ALL = 1,
    NONE = 2,
    SINGLE = 3,
    ANYONECANPAY = 0x80
}

export namespace SigHash {
    export const value = {
        ALL: 1,
        NONE: 2,
        SINGLE: 3,
        ANYONECANPAY: 0x80
    };
}
