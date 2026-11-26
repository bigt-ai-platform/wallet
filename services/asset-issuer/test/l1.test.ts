import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ASSETS } from '../src/config.js';
import type { Operation } from '../src/domain.js';
import {
  BigtAiL1Minter,
  BigtAiRedemptionSource,
  BigtAiRedemptionVerifier,
  RefusingTreasury,
  composeChainClient,
  redemptionMemo,
  type L1TokenOutput,
  type WalletLike,
} from '../src/l1.js';

const ASSET = {
  ...DEFAULT_ASSETS.find((a) => a.assetId === 'hkd')!,
  l1TokenId: 'aa11',
  redemptionAddress: 'REDEEM-ADDR',
  signers: ['pub1', 'pub2'],
  signnumber: 2,
};

function wallet(over: Partial<WalletLike> = {}): WalletLike {
  return {
    reissue: vi.fn(async () => ({ blockHash: 'b1' })),
    multiSign: vi.fn(async () => {}),
    pendingSigns: vi.fn(async () => 0),
    pay: vi.fn(async () => ({ txHash: 't1' })),
    tokenOutputs: vi.fn(async () => [] as L1TokenOutput[]),
    ...over,
  };
}

describe('L1 minter', () => {
  it('refuses to sign unless explicitly enabled', async () => {
    const w = wallet();
    const minter = new BigtAiL1Minter({ wallet: w, assets: [ASSET], live: false });
    await expect(minter.issue('hkd', '100')).rejects.toThrow(/disabled/);
    expect(w.reissue).not.toHaveBeenCalled();
  });

  it('refuses an asset without an issued token', async () => {
    const minter = new BigtAiL1Minter({
      wallet: wallet(), assets: [{ ...ASSET, l1TokenId: undefined }], live: true,
    });
    await expect(minter.issue('hkd', '100')).rejects.toThrow(/l1TokenId/);
  });

  it('reissues, then multi-signs and pays the holder — in that order', async () => {
    const calls: string[] = [];
    let pending = 1;
    const w = wallet({
      reissue: vi.fn(async () => { calls.push('reissue'); return { blockHash: 'b1' }; }),
      multiSign: vi.fn(async () => { calls.push('multiSign'); pending = 0; }),
      pendingSigns: vi.fn(async () => pending),
      pay: vi.fn(async () => { calls.push('pay'); return { txHash: 't1' }; }),
    });
    const minter = new BigtAiL1Minter({ wallet: w, assets: [ASSET], live: true, signaturePollMs: 0 });
    expect(await minter.issue('hkd', '100')).toEqual({ txHash: 'b1' });
    expect(calls).toEqual(['reissue']);
    expect(await minter.pay('hkd', 'holder', '100')).toEqual({ txHash: 't1' });
    expect(calls).toEqual(['reissue', 'multiSign', 'pay']);
    expect(w.pay).toHaveBeenCalledWith('aa11', 'holder', '100');
  });

  it('drains pending signatures before paying (the mint is not solid until then)', async () => {
    let pending = 1;
    const calls: string[] = [];
    const w = wallet({
      pendingSigns: vi.fn(async () => pending),
      multiSign: vi.fn(async () => { calls.push('multiSign'); pending -= 1; }),
      pay: vi.fn(async () => { calls.push('pay'); return { txHash: 't1' }; }),
    });
    const minter = new BigtAiL1Minter({ wallet: w, assets: [ASSET], live: true, signaturePollMs: 0 });
    expect(await minter.pay('hkd', 'holder', '100')).toEqual({ txHash: 't1' });
    expect(calls).toEqual(['multiSign', 'pay']);
  });

  it('fails loudly when a token block never collects its signatures', async () => {
    const w = wallet({ pendingSigns: vi.fn(async () => 2) });
    const minter = new BigtAiL1Minter({ wallet: w, assets: [ASSET], live: true, signaturePollMs: 0 });
    await expect(minter.pay('hkd', 'holder', '100')).rejects.toThrow(/signature/);
    expect(w.pay).not.toHaveBeenCalled();
  });

  it('rejects a zero amount and an empty holder', async () => {
    const minter = new BigtAiL1Minter({ wallet: wallet(), assets: [ASSET], live: true });
    await expect(minter.issue('hkd', '0')).rejects.toThrow(/amount/);
    await expect(minter.pay('hkd', '', '1')).rejects.toThrow(/account/);
  });
});

describe('L1 redemption source', () => {
  const output = (over: Partial<L1TokenOutput> = {}): L1TokenOutput => ({
    blockHash: 'bh', txHash: 'th', index: 0, valueRaw: 500n,
    tokenId: 'aa11', address: 'REDEEM-ADDR', confirmed: true,
    memo: redemptionMemo('hkd', '500', 'w1'),
    ...over,
  });

  it('reads only confirmed outputs at the redemption address', async () => {
    const w = wallet({
      tokenOutputs: vi.fn(async () => [
        output(),
        output({ txHash: 'th2', confirmed: false }),
        output({ txHash: 'th3', address: 'SOMEONE-ELSE' }),
        output({ txHash: 'th4', valueRaw: 0n }),
        output({ txHash: 'th5', tokenId: 'other' }),
      ]),
    });
    const source = new BigtAiRedemptionSource(w, [ASSET]);
    const rows = await source.redemptions(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: 'hkd', txHash: 'th', l1Raw: '500', chain: 'l1-order', logIndex: 0 });
  });

  it('does nothing for an asset with no redemption address', async () => {
    const w = wallet({ tokenOutputs: vi.fn(async () => [output()]) });
    const source = new BigtAiRedemptionSource(w, [{ ...ASSET, redemptionAddress: undefined }]);
    expect(await source.redemptions(0)).toEqual([]);
    expect(w.tokenOutputs).not.toHaveBeenCalled();
  });
});

describe('redemption verifier', () => {
  const output = (over: Partial<L1TokenOutput> = {}): L1TokenOutput => ({
    blockHash: 'bh', txHash: 'th', index: 0, valueRaw: 500n,
    tokenId: 'aa11', address: 'REDEEM-ADDR', confirmed: true,
    memo: redemptionMemo('hkd', '500', 'w1'),
    ...over,
  });

  const op = (over: Partial<Operation> = {}): Operation => ({
    id: 'op1',
    kind: 'redeem',
    assetId: 'hkd',
    account: 'w1',
    amountRaw: '500',
    l1AmountRaw: '500',
    status: 'pending',
    ref: { chain: 'l1-order', txHash: 'th', logIndex: 0 },
    destination: '0x2222222222222222222222222222222222222222',
    attempts: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('accepts exactly one confirmed output of the token and amount', async () => {
    const verifier = new BigtAiRedemptionVerifier(
      wallet({ tokenOutputs: vi.fn(async () => [output()]) }),
      [ASSET],
    );
    expect(await verifier.check(op(), ASSET)).toEqual({
      status: 'ok',
      txHash: 'th',
      logIndex: 0,
    });
    expect(await verifier.verify(op(), ASSET)).toBe(true);
  });

  it('pins the cross-repo funding memo', () => {
    // Pinned on the client in
    // expo-app/sources/services/__tests__/redeemFunding.test.ts.
    expect(redemptionMemo('USDT', '5000000', 'acct'))
      .toBe('wallet-redeem:v1:usdt:5000000:acct');
  });

  it('returns the canonical outpoint and verifies the stored index', async () => {
    const verifier = new BigtAiRedemptionVerifier(
      wallet({ tokenOutputs: vi.fn(async () => [output({ txHash: '0xTH', index: 2 })]) }),
      [ASSET],
    );
    expect(await verifier.check(op({ ref: { chain: 'l1-order', txHash: '0xth', logIndex: 9 } }), ASSET))
      .toEqual({ status: 'ok', txHash: 'th', logIndex: 2 });
    // The stored ref must be the matched outpoint, not just "some output in the tx".
    expect(await verifier.verify(
      op({ ref: { chain: 'l1-order', txHash: 'th', logIndex: 2 } }), ASSET,
    )).toBe(true);
    expect(await verifier.verify(
      op({ ref: { chain: 'l1-order', txHash: 'th', logIndex: 0 } }), ASSET,
    )).toBe(false);
  });

  it('rejects a wrong amount, address, token, transaction or memo', async () => {
    const cases: L1TokenOutput[] = [
      output({ valueRaw: 499n }),
      output({ address: 'SOMEONE-ELSE' }),
      output({ tokenId: 'other' }),
      output({ txHash: 'other-tx' }),
      // Same token/amount/address, but not bound to this account.
      output({ memo: redemptionMemo('hkd', '500', 'someone-else') }),
      output({ memo: '' }),
    ];
    for (const candidate of cases) {
      const verifier = new BigtAiRedemptionVerifier(
        wallet({ tokenOutputs: vi.fn(async () => [candidate]) }),
        [ASSET],
      );
      expect(await verifier.verify(op(), ASSET)).toBe(false);
    }
  });

  it('is pending while the output is unconfirmed or not indexed yet', async () => {
    const unconfirmed = new BigtAiRedemptionVerifier(
      wallet({ tokenOutputs: vi.fn(async () => [output({ confirmed: false })]) }),
      [ASSET],
    );
    expect((await unconfirmed.check(op(), ASSET)).status).toBe('pending');

    const missing = new BigtAiRedemptionVerifier(
      wallet({ tokenOutputs: vi.fn(async () => []) }),
      [ASSET],
    );
    expect((await missing.check(op(), ASSET)).status).toBe('pending');
  });

  it('rejects a release with no L1 reference or no redemption address', async () => {
    const verifier = new BigtAiRedemptionVerifier(
      wallet({ tokenOutputs: vi.fn(async () => [output()]) }),
      [ASSET],
    );
    expect((await verifier.check(op({ ref: undefined }), ASSET)).status).toBe('invalid');
    expect((await verifier.check(op({ ref: { chain: 'ethereum', txHash: 'th', logIndex: 0 } }), ASSET)).status)
      .toBe('invalid');
    expect((await verifier.check(op(), { ...ASSET, redemptionAddress: undefined })).status).toBe('invalid');
  });
});

describe('treasury guard', () => {
  it('fails loudly instead of half-releasing', async () => {
    await expect(new RefusingTreasury().release('hkd', 'w', '1')).rejects.toThrow(/HSM\/MPC/);
  });
});

describe('composition', () => {
  it('routes deposits and redemptions to their own sources', async () => {
    const chain = composeChainClient(
      { finalizedBlock: async () => 7, deposits: async () => [] },
      { redemptions: async () => [] },
    );
    expect(await chain.finalizedBlock('ethereum')).toBe(7);
    expect(await chain.redemptions(0)).toEqual([]);
  });
});
