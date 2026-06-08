
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Address } from '../../src/net/bigtangle/core/Address';
import { ScriptBuilder } from '../../src/net/bigtangle/script/ScriptBuilder';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { TransactionOutput } from '../../src/net/bigtangle/core/TransactionOutput';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { CoinConstants } from '../../src/net/bigtangle/core/CoinConstants';
import { describe, test, expect } from 'vitest';

describe('TransactionOutputTest', () => {
    test('testP2SHOutputScript', () => {
        const P2SHAddressString = '35b9vsyH1KoFT5a5KtrKusaCcPLkiSo1tU';
        const P2SHAddress = Address.fromBase58(
            MainNetParams.get(),
            P2SHAddressString,
        );
        const script = ScriptBuilder.createOutputScript(P2SHAddress);
        const tx = new Transaction(MainNetParams.get());
        const output = new TransactionOutput(
            MainNetParams.get(), 
            tx, 
             CoinConstants.COIN, 
            Buffer.from(script.getProgram())
        );
        tx.addOutput(output);
        expect(
            tx.getOutputs()[0].getAddressFromP2SH(MainNetParams.get())!.toString(),
        ).toBe(P2SHAddressString);
    });
});
