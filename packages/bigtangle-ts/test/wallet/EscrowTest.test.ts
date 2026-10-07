import { describe, test, expect } from 'vitest';
import { Escrow, EscrowRoles } from '../../src/net/bigtangle/wallet/Escrow';
import { MainNetParams } from '../../src/net/bigtangle/params/MainNetParams';
import { Address } from '../../src/net/bigtangle/core/Address';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { SigHash } from '../../src/net/bigtangle/core/SigHash';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { PQKey } from '../../src/net/bigtangle/crypto/pq/PQKey';
import { SignatureBundle } from '../../src/net/bigtangle/crypto/pq/SignatureBundle';
import { Script } from '../../src/net/bigtangle/script/Script';
import { OP_0 } from '../../src/net/bigtangle/script/ScriptOpCodes';
import { Utils } from '../../src/net/bigtangle/utils/Utils';

const params = MainNetParams.get();

/** Deterministic 32-byte ML-DSA seeds, matching the Java oracle's PQKey.fromMLDSA. */
function key(seedByte: number): PQKey {
    const seed = new Uint8Array(32);
    seed[31] = seedByte;
    return PQKey.fromKeyMaterial(seed);
}

const seller = key(1);
const buyer = key(2);
const engine = key(3);

const blockHash = Sha256Hash.wrapString('aa'.repeat(32));
const dest = Address.fromP2PKH(params,
    Utils.HEX.decode('11223344556677889900aabbccddeeff00112233'));

/** P2SH outputs can only be spent by referencing the funding transaction. */
function escrowUtxo(vault: Escrow): Transaction {
    const funding = new Transaction(params);
    funding.addOutputScript(Coin.COIN, vault.outputScript);
    return funding;
}

function spendOf(vault: Escrow) {
    const funding = escrowUtxo(vault);
    return vault.createSpend({
        params,
        blockHash,
        utxo: funding.getOutputs()[0],
        to: dest,
    });
}

describe('Escrow — vectors from the Java oracle', () => {
    const vault = Escrow.of(2, [seller, buyer, engine]);

    test('redeem script is 7,806 bytes: 3 x 2,598-byte PQ pubkeys plus framing', () => {
        expect(vault.redeemScript.getProgram().length).toBe(7806);
        expect(vault.threshold).toBe(2);
        expect(vault.pubkeys.length).toBe(3);
    });

    test('pubkeys are stored in lexicographic order, not delivery order', () => {
        const prefixes = vault.pubkeys.map(p => Utils.HEX.encode(p.getPubKey()).substring(0, 34));
        expect(prefixes).toEqual([
            '050101010a2043846adb419993d820fdfd',
            '050101010a206b7725ec1b4d0fbc9055a2',
            '050101010a20c3e5222d74c89b645b72d9',
        ]);
        // Java: sorted [key(2), key(3), key(1)] — i.e. buyer, engine, seller.
        expect(vault.indexOf(buyer)).toBe(0);
        expect(vault.indexOf(engine)).toBe(1);
        expect(vault.indexOf(seller)).toBe(2);
        expect(vault.indexOf(key(9))).toBe(-1);
    });

    test('P2SH output script and address match the Java oracle', () => {
        expect(vault.outputScript.getProgram().length).toBe(23);
        expect(Utils.HEX.encode(vault.outputScript.getProgram()))
            .toBe('a914fef017903adb364ceef9863609bc1250462e102287');
        expect(vault.address(params).getVersion()).toBe(5);
        expect(vault.address(params).toBase58())
            .toBe('3Qw1BA2LeSDuNms3eBY68YPZHcnmFnEpfd');
    });

    test('address is independent of the order keys were handed in', () => {
        expect(Escrow.of(2, [engine, seller, buyer]).address(params).toBase58())
            .toBe(vault.address(params).toBase58());
        expect(Utils.HEX.encode(Escrow.of(2, [engine, seller, buyer]).outputScript.getProgram()))
            .toBe(Utils.HEX.encode(vault.outputScript.getProgram()));
    });

    test('spend serialization and sighash match the Java oracle byte-for-byte', () => {
        const funding = escrowUtxo(vault);
        expect(Utils.HEX.encode(funding.bitcoinSerialize()))
            .toBe('010000000001030f424001bc17a914fef017903adb364ceef9863609bc1250462e102287000000000000000000000000000000000000000000000000');

        const tx = vault.createSpend({ params, blockHash, utxo: funding.getOutputs()[0], to: dest });
        expect(Utils.HEX.encode(tx.bitcoinSerialize()))
            .toBe('0200000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0cdd8b3615f72a7c36ac5c4f1d1c6ff861c72a5215423eaea510b742dce96a8b0000000000ffffffff0000000001030f424001bc1976a91411223344556677889900aabbccddeeff0011223388ac0000000000000000000000000000000000000000000000000000000000000000');
        // Sighash over the same serialization (Java: hashForSignature(0, redeem, ALL, false)).
        expect(tx.hashForSignature(0, vault.redeemScript.getProgram(), SigHash.ALL, false).toString())
            .toBe('c729bc63bc2eef02815a47ab669302c9751f35f9057fd721f5ed7c558c6c8b53');
    });

    test('rejects out-of-range thresholds', () => {
        expect(() => Escrow.of(0, [seller, buyer, engine])).toThrow();
        expect(() => Escrow.of(4, [seller, buyer, engine])).toThrow();
        expect(() => Escrow.of(2, [])).toThrow();
        // 3-of-3 is in range, so it must be accepted.
        expect(Escrow.of(3, [seller, buyer, engine]).threshold).toBe(3);
    });
});

describe('Escrow — spending', () => {
    const vault = Escrow.of(2, [seller, buyer, engine]);

    // The gapped pair (indices 0 and 2, skipping 1) is seller + buyer.
    test.each([
        ['0,1', [engine, buyer]],
        ['0,2', [seller, buyer]],
        ['1,2', [engine, seller]],
    ])('a %s signature set satisfies OP_CHECKMULTISIG', async (_label, signers) => {
        const tx = spendOf(vault);
        expect(vault.signInput(tx, 0, signers)).toBe(2);
        await tx.getInput(0).getScriptSig()
            .correctlySpends(tx, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);
    });

    test('scriptSig is OP_0 <sig> <sig> <redeemProgram> in redeem order', () => {
        const tx = spendOf(vault);
        vault.signInput(tx, 0, [engine, seller]);
        const scriptSig = tx.getInput(0).getScriptSig();
        const chunks = scriptSig.getChunks();

        expect(chunks.length).toBe(4);
        expect(chunks[0].opcode).toBe(OP_0);
        // Java's isOpCode() is `opcode > OP_PUSHDATA4`, so OP_0 is not an opcode.
        expect(chunks[0].isOpCode()).toBe(false);
        expect(chunks[1].data!.length).toBe(4632);
        expect(chunks[2].data!.length).toBe(4632);
        expect(Array.from(chunks[3].data!)).toEqual(Array.from(vault.redeemScript.getProgram()));
        // 1 + 2*(3+4632) + (3+7806)
        expect(scriptSig.getProgram().length).toBe(17080);
    });

    test('signatures are ordered by redeem-script index, not by caller order', () => {
        // Caller passes seller (index 2) before buyer (index 0); the scriptSig
        // must still lead with buyer, the lower redeem-script position.
        const tx = spendOf(vault);
        vault.signInput(tx, 0, [seller, buyer]);
        const chunks = tx.getInput(0).getScriptSig().getChunks();
        const sighash = tx.hashForSignature(0, vault.redeemScript.getProgram(), SigHash.ALL, false);

        expect(PQKey.verify(sighash, SignatureBundle.deserialize(chunks[1].data!),
            vault.pubkeys[0].getPubKey())).toBe(true);
        expect(PQKey.verify(sighash, SignatureBundle.deserialize(chunks[2].data!),
            vault.pubkeys[2].getPubKey())).toBe(true);
    });

    test('spends the full UTXO by default and leaves an explicit remainder as fee', () => {
        const full = spendOf(vault);
        expect(full.getOutputs()[0].getValue().equals(Coin.COIN)).toBe(true);

        const funding = escrowUtxo(vault);
        const partial = vault.createSpend({
            params,
            blockHash,
            utxo: funding.getOutputs()[0],
            to: dest,
            amount: Coin.valueOf(400000n),
        });
        expect(partial.getOutputs()[0].getValue().getValue()).toBe(400000n);
    });

    test('version is 2 (PQ) so the PQ witness rules apply', () => {
        expect(spendOf(vault).version).toBe(2);
    });

    test('rejects a single signature', () => {
        const tx = spendOf(vault);
        expect(() => vault.signInput(tx, 0, [seller])).toThrow(/need 2 signatures/);
    });

    test('rejects a signer that is not a participant', () => {
        const tx = spendOf(vault);
        expect(() => vault.signInput(tx, 0, [seller, key(9)])).toThrow(/not a participant/);
    });

    test('rejects a duplicate signer', () => {
        const tx = spendOf(vault);
        expect(() => vault.signInput(tx, 0, [seller, seller])).toThrow(/duplicate signer/);
    });

    test('rejects a watch-only participant', () => {
        const tx = spendOf(vault);
        const watchOnly = PQKey.fromPublicOnly(seller.getPubKey());
        expect(() => vault.signInput(tx, 0, [watchOnly, buyer])).toThrow(/watch-only/);
    });
});

describe('Escrow — release and refund', () => {
    const roles: EscrowRoles = { seller, buyer, engine };
    const vault = Escrow.twoOfThree(roles);

    test('release is engine + buyer', () => {
        expect(vault.releaseSigners()).toEqual([roles.engine, roles.buyer]);
        const tx = spendOf(vault);
        vault.signInput(tx, 0, vault.releaseSigners());
        expect(tx.getInput(0).getScriptSig().getChunks().length).toBe(4);
    });

    test('refund is engine + seller', () => {
        expect(vault.refundSigners()).toEqual([roles.engine, roles.seller]);
        const tx = spendOf(vault);
        vault.signInput(tx, 0, vault.refundSigners());
        expect(tx.getInput(0).getScriptSig().getChunks().length).toBe(4);
    });

    test('buildRelease and buildRefund produce spending transactions', async () => {
        const funding = escrowUtxo(vault);
        const opts = { params, blockHash, utxo: funding.getOutputs()[0], to: dest };

        const release = vault.buildRelease(opts);
        await release.getInput(0).getScriptSig()
            .correctlySpends(release, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);

        const refund = vault.buildRefund(opts);
        await refund.getInput(0).getScriptSig()
            .correctlySpends(refund, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);
    });

    test('every release/refund pair shares the engine, but any two keys sign', () => {
        const release = vault.releaseSigners();
        const refund = vault.refundSigners();
        expect(release).toContain(roles.engine);
        expect(refund).toContain(roles.engine);
        expect(release).not.toEqual(refund);

        // The 2-of-3 script cannot enforce which *purpose* a pair signs for:
        // seller + buyer is a valid script set even though neither policy
        // path names it. Enforcing release/refund intent stays with the caller.
        const funding = escrowUtxo(vault);
        const tx = vault.createSpend({
            params, blockHash, utxo: funding.getOutputs()[0], to: dest,
        });
        expect(vault.signInput(tx, 0, [roles.seller, roles.buyer])).toBe(2);

        const tooFew = vault.createSpend({
            params, blockHash, utxo: funding.getOutputs()[0], to: dest,
        });
        expect(() => vault.signInput(tooFew, 0, [roles.seller]))
            .toThrow(/need 2 signatures/);
    });

    test('an Escrow built without roles cannot name release/refund signers', () => {
        const plain = Escrow.of(2, [seller, buyer, engine]);
        expect(() => plain.releaseSigners()).toThrow(/no release roles/);
        expect(() => plain.refundSigners()).toThrow(/no refund roles/);
    });
});
