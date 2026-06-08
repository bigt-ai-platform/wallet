
import { Buffer } from 'buffer';
import { TransactionSigner } from '../../src/net/bigtangle/signers/TransactionSigner';
import { KeyBag } from '../../src/net/bigtangle/wallet/KeyBag';

// Define ProposedTransaction locally since the import was failing
type ProposedTransaction = any;

export class NopTransactionSigner implements TransactionSigner {
    private _isReady: boolean;

    public constructor(ready?: boolean) {
        this._isReady = ready || false;
    }

    public isReady(): boolean {
        return this._isReady;
    }

    public serialize(): Buffer {
        return this._isReady ? Buffer.from([1]) : Buffer.from([0]);
    }

    public deserialize(data: Buffer): void {
        if (data.length > 0) this._isReady = data[0] === 1;
    }

    public async signInputs(t: ProposedTransaction, keyBag: KeyBag): Promise<boolean> {
        return false;
    }
}
