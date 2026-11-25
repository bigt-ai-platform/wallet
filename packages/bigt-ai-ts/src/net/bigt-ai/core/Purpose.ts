/**
 * This enum describes the underlying reason the transaction was created. It's
 * useful for rendering wallet GUIs more appropriately.
 */
export enum Purpose {
    /** Used when the purpose of a transaction is genuinely unknown. */
    UNKNOWN,
    /** Transaction created to satisfy a user payment request. */
    USER_PAYMENT,
    /**
     * Transaction automatically created and broadcast in order to reallocate money
     * from old to new keys.
     */
    KEY_ROTATION,
    /** Transaction that uses up pledges to an assurance contract */
    ASSURANCE_CONTRACT_CLAIM,
    /** Transaction that makes a pledge to an assurance contract. */
    ASSURANCE_CONTRACT_PLEDGE,
    /**
     * Send-to-self transaction that exists just to create an output of the right
     * size we can pledge.
     */
    ASSURANCE_CONTRACT_STUB,
    /** Raise fee, e.g. child-pays-for-parent. */
    RAISE_FEE
}
