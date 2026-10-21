import { afterEach, describe, expect, test, vi } from 'vitest';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { Transaction } from '../../src/net/bigtangle/core/Transaction';
import { PQKey } from '../../src/net/bigtangle/crypto/pq/PQKey';
import { TestParams } from '../../src/net/bigtangle/params/TestParams';
import { Wallet } from '../../src/net/bigtangle/wallet/Wallet';

afterEach(() => vi.restoreAllMocks());

describe('Wallet contract payment change', () => {
  test.each([
    { payment: 0n, fee: false },
    { payment: 0n, fee: true },
    { payment: 10000n, fee: false },
    { payment: 10000n, fee: true },
  ])('returns change for $payment with fee=$fee', async ({ payment, fee }) => {
    const key = PQKey.fromMLDSA(new Uint8Array(32).fill(1));
    const wallet = Wallet.fromKeys(TestParams.get(), key);
    const input = new Coin(100000n, new Uint8Array([0xbc]));
    const candidate = {
      getUTXO: () => ({
        getAddress: () => key.toAddress().toHex(),
        getValue: () => input,
        getBlockHash: () => null,
      }),
    };
    vi.spyOn(wallet, 'getFee').mockReturnValue(fee);
    vi.spyOn(wallet, 'calculateAllSpendCandidates').mockResolvedValue([candidate] as any);
    vi.spyOn(wallet as any, 'filterTokenid').mockReturnValue([candidate]);
    vi.spyOn(wallet, 'getECKey').mockResolvedValue(key);
    vi.spyOn(Transaction.prototype, 'addInput2').mockReturnThis();
    const output = vi.spyOn(Transaction.prototype, 'addOutputEckey');
    vi.spyOn(wallet as any, 'signTransaction').mockResolvedValue(undefined);
    const submit = vi.spyOn(wallet as any, 'submitTransaction').mockResolvedValue(undefined);

    await wallet.payContract(null, 'bc', payment, null, null, 'contract', '{"action":"heartbeat"}');

    expect(output).toHaveBeenCalledTimes(1);
    expect(output.mock.calls[0][0].getValue()).toBe(
      input.getValue() - payment - (fee ? Coin.FEE_DEFAULT.getValue() : 0n),
    );
    expect(submit).toHaveBeenCalledTimes(1);
  });
});