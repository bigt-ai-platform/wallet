import { describe, it, expect } from 'vitest';
import {
  Address,
  Coin,
  Escrow,
  MainNetParams,
  PQKey,
  Script,
  Sha256Hash,
  SignatureBundle,
  Transaction,
  Utils,
} from 'bigtangle-ts';
import { buildEscrowSighash, buildEscrowSpend, signEscrow, vaultEnginePubkey, vaultMatchesAddress } from '../p2pEscrow';
import {
  acceptCoopRelease,
  assembleCoopRelease,
  buildCoopReleaseRecord,
  buildCoopReleaseTx,
  combineCoopRelease,
  verifyCoopSignature,
  type CoopReleaseContext,
  type CoopSignature,
} from '../p2pEscrowCoop';
import { pqDidFromKey } from '../p2pIdentity';

const params = MainNetParams.get();

/** Deterministic ML-DSA seeds — same helper the bigtangle-ts EscrowTest uses. */
function key(seedByte: number): PQKey {
  const seed = new Uint8Array(32);
  seed[31] = seedByte;
  return PQKey.fromKeyMaterial(seed);
}

const seller = key(1);
const buyer = key(2);
const engine = key(3);
const vault = Escrow.twoOfThree({ seller, buyer, engine });
const blockHash = Sha256Hash.wrapString('bb'.repeat(32));
const dest = Address.fromP2PKH(params, Utils.HEX.decode('11223344556677889900aabbccddeeff00112233'));
const escrowAddress = vault.address(params).toBase58();

/** The lock tx whose P2SH output funds the vault (BIG, one coin). */
const funding = new Transaction(params);
funding.addOutputScript(Coin.COIN, vault.outputScript);
const escrowTxHash = funding.getHash().toString();

/** `getOutputsHistory` shape the wallet receives back from the chain. */
const outputs = [
  {
    hashHex: escrowTxHash,
    blockHashHex: blockHash.toString(),
    scriptHex: Utils.HEX.encode(vault.outputScript.getProgram()),
    address: escrowAddress,
    spent: false,
    value: { value: Coin.COIN.getValue().toString(), tokenHex: 'bc' },
    index: 0,
  },
];

function skeleton() {
  const spend = buildEscrowSpend({
    vault,
    outputs,
    escrowAddress,
    escrowTxHash,
    toBase58: dest.toBase58(),
  });
  if (!spend) throw new Error('skeleton missing');
  return spend;
}

function sigOf(who: PQKey, sighash: Sha256Hash): CoopSignature {
  return { signer: who, sigHex: signEscrow(who, sighash) };
}

describe('cooperative escrow release (engine-free, seller + buyer)', () => {
  it('re-exposes the sighash unchanged (buildEscrowSighash refactor)', () => {
    const spend = skeleton();
    const skel = buildEscrowSighash({
      vault,
      outputs,
      escrowAddress,
      escrowTxHash,
      toBase58: dest.toBase58(),
    });
    expect(skel!.sighash.toString()).toBe(spend.sighash.toString());
  });

  it('assembles seller + buyer and the script verifies (correctlySpends)', async () => {
    const spend = skeleton();
    const sigs = [sigOf(seller, spend.sighash), sigOf(buyer, spend.sighash)];
    expect(sigs.every((s) => verifyCoopSignature(spend.sighash, s))).toBe(true);

    const n = assembleCoopRelease(vault, spend.tx, spend.sighash, sigs);
    expect(n).toBe(2);
    await spend.tx.getInput(0).getScriptSig()
      .correctlySpends(spend.tx, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);
  });

  it('is order-independent — signatures land in redeem-script order either way', () => {
    const a = skeleton();
    assembleCoopRelease(vault, a.tx, a.sighash, [sigOf(seller, a.sighash), sigOf(buyer, a.sighash)]);

    const b = skeleton();
    assembleCoopRelease(vault, b.tx, b.sighash, [sigOf(buyer, b.sighash), sigOf(seller, b.sighash)]);

    // ML-DSA signatures are randomized, so compare the *order* — both must lead
    // with buyer (redeem index 0) then seller (index 2), regardless of input order.
    for (const [tx, sighash] of [[a.tx, a.sighash], [b.tx, b.sighash]] as const) {
      const chunks = tx.getInput(0).getScriptSig().getChunks();
      expect(chunks.length).toBe(4);
      expect(PQKey.verify(sighash, SignatureBundle.deserialize(chunks[1].data!), vault.pubkeys[0].getPubKey()))
        .toBe(true);
      expect(PQKey.verify(sighash, SignatureBundle.deserialize(chunks[2].data!), vault.pubkeys[2].getPubKey()))
        .toBe(true);
    }
  });

  it('works with any other two keys too (engine + buyer)', async () => {
    const spend = skeleton();
    assembleCoopRelease(vault, spend.tx, spend.sighash, [
      sigOf(engine, spend.sighash),
      sigOf(buyer, spend.sighash),
    ]);
    await spend.tx.getInput(0).getScriptSig()
      .correctlySpends(spend.tx, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);
  });

  it('buildCoopReleaseTx returns broadcastable bytes that verify', async () => {
    const spend = skeleton();
    const out = buildCoopReleaseTx({
      vault,
      outputs,
      escrowAddress,
      escrowTxHash,
      toBase58: dest.toBase58(),
      sigs: [sigOf(buyer, spend.sighash), sigOf(seller, spend.sighash)],
    });
    expect(out).not.toBeNull();
    expect(typeof out!.txHex).toBe('string');
    await out!.tx.getInput(0).getScriptSig()
      .correctlySpends(out!.tx, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);
  });

  it('fails closed on a non-participant signer', () => {
    const spend = skeleton();
    expect(() =>
      assembleCoopRelease(vault, spend.tx, spend.sighash, [
        sigOf(key(9), spend.sighash),
        sigOf(buyer, spend.sighash),
      ]),
    ).toThrow(/not a participant/);
  });

  it('fails closed on an invalid signature (claimed as buyer, signed by engine)', () => {
    const spend = skeleton();
    const wrong: CoopSignature = { signer: buyer, sigHex: signEscrow(engine, spend.sighash) };
    expect(() =>
      assembleCoopRelease(vault, spend.tx, spend.sighash, [wrong, sigOf(seller, spend.sighash)]),
    ).toThrow(/invalid escrow signature/);
  });

  it('fails closed on a duplicate and on too few signatures', () => {
    const spend = skeleton();
    const sig = sigOf(buyer, spend.sighash);
    expect(() => assembleCoopRelease(vault, spend.tx, spend.sighash, [sig, sig]))
      .toThrow(/duplicate signer/);
    expect(() => assembleCoopRelease(vault, spend.tx, spend.sighash, [sig]))
      .toThrow(/need 2 signatures/);
  });

  it('returns null when the lock output is absent (fail closed)', () => {
    const out = buildCoopReleaseTx({
      vault,
      outputs: undefined,
      escrowAddress,
      escrowTxHash,
      toBase58: dest.toBase58(),
      sigs: [],
    });
    expect(out).toBeNull();
  });
});

describe('cooperative release via social.p2p-release (no engine)', () => {
  const swapId = 'swap-0123456789abcdef';
  const releaseCtx = (): CoopReleaseContext => ({
    vault,
    spend: skeleton(),
    escrowTxHash,
    kind: 'release',
    toAddress: dest.toBase58(),
  });

  it('seller hands over a record; buyer combines and the spend verifies', async () => {
    const sellerRec = buildCoopReleaseRecord({
      key: seller,
      from: pqDidFromKey(seller),
      swapId,
      kind: 'release',
      escrowTxHash,
      toAddress: dest.toBase58(),
      spend: skeleton(),
    });
    // The buyer rebuilds its own skeleton (same deterministic bytes) and settles.
    const out = combineCoopRelease(releaseCtx(), buyer, sellerRec);
    await out.tx.getInput(0).getScriptSig()
      .correctlySpends(out.tx, 0, vault.outputScript, Script.ALL_VERIFY_FLAGS);
    expect(out.txHex.length).toBeGreaterThan(0);
  });

  it('acceptCoopRelease returns the counterparty signer after checking the record', () => {
    const ctx = releaseCtx();
    const sellerRec = buildCoopReleaseRecord({
      key: seller, from: pqDidFromKey(seller), swapId, kind: 'release',
      escrowTxHash, toAddress: dest.toBase58(), spend: skeleton(),
    });
    const sig = acceptCoopRelease(sellerRec, ctx);
    expect(vault.indexOf(sig.signer)).toBe(vault.indexOf(seller));
  });

  it('rejects a record for a different destination, lock, or kind', () => {
    const ctx = releaseCtx();
    const build = (over: Partial<Parameters<typeof buildCoopReleaseRecord>[0]>) =>
      buildCoopReleaseRecord({
        key: seller, from: pqDidFromKey(seller), swapId, kind: 'release',
        escrowTxHash, toAddress: dest.toBase58(), spend: skeleton(), ...over,
      });
    // wrong destination (a release pointing elsewhere)
    expect(() => acceptCoopRelease(build({ toAddress: escrowAddress }), ctx)).toThrow(/different address/);
    // wrong lock
    expect(() => acceptCoopRelease(build({ escrowTxHash: 'ab'.repeat(32) }), ctx)).toThrow(/different lock/);
    // wrong kind (refund record) vs a release context
    expect(() => acceptCoopRelease(build({ kind: 'refund' }), ctx)).toThrow(/kind/);
  });

  it('rejects a signature that does not verify over this sighash', () => {
    const ctx = releaseCtx();
    const rec = buildCoopReleaseRecord({
      key: seller, from: pqDidFromKey(seller), swapId, kind: 'release',
      escrowTxHash, toAddress: dest.toBase58(), spend: skeleton(),
    });
    // Claim the author is the buyer, but the signature is the seller's.
    const forged = { ...rec, from: pqDidFromKey(buyer) };
    expect(() => acceptCoopRelease(forged, ctx)).toThrow(/invalid escrow signature/);
  });
});

describe('vaultEnginePubkey enforces the trusted engine set', () => {
  it('accepts a pinned key only when trusted (allowlist or the configured engine)', () => {
    // default: a pin must equal the configured engine's key (rejects a rogue pin)
    expect(vaultEnginePubkey('05caps', '05caps')).toBe('05caps');
    expect(vaultEnginePubkey('05rogue', '05caps')).toBeNull();
    // allowlist enables a second trusted engine
    expect(vaultEnginePubkey('05b', '05caps', ['05b', '05c'])).toBe('05b');
    expect(vaultEnginePubkey('05rogue', '05caps', ['05b'])).toBeNull();
    // no pin → the configured engine's key
    expect(vaultEnginePubkey(undefined, '05caps')).toBe('05caps');
    expect(vaultEnginePubkey(undefined, undefined)).toBeNull();
  });
});

describe('vaultMatchesAddress (substituted-key guard)', () => {
  it('accepts the vault’s own address and rejects any other', () => {
    const addr = vault.address(MainNetParams.get()).toBase58();
    expect(vaultMatchesAddress(vault, addr)).toBe(true);
    // a different key set → different address → refuse to sign
    const other = Escrow.twoOfThree({ seller: key(4), buyer, engine });
    expect(vaultMatchesAddress(other, addr)).toBe(false);
    expect(vaultMatchesAddress(vault, 'not-an-address')).toBe(false);
  });
});
