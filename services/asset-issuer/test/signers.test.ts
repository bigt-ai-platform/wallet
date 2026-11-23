import { describe, expect, it } from 'vitest';
import { deriveDepositAddress } from '../src/depositAddress.js';
import { erc20TransferData, bytesToHex } from '../src/ethTx.js';
import {
  CommandL1Minter,
  CommandSweepSigner,
  CommandTreasury,
  LocalSweepSigner,
  type CommandRunner,
  type SweepSignRequest,
} from '../src/signers.js';

const XPUB = 'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ';
const XPRV = 'xprv9wTYmMFdV23N2TdNG573QoEsfRrWKQgWeibmLntzniatZvR9BmLnvSxqu53Kw1UmYPxLgboyZQaXwTCg8MSY3H2EU4pWcQDnRnrVA1xe8fs';
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const OMNIBUS = '0x1111111111111111111111111111111111111111';

const address = deriveDepositAddress(XPUB, '', 2);
const request: SweepSignRequest = {
  address,
  addressIndex: 2,
  chainId: '1',
  nonce: '7',
  maxPriorityFeePerGas: '1000000000',
  maxFeePerGas: '3000000000',
  gasLimit: '65000',
  to: USDT,
  data: bytesToHex(erc20TransferData(OMNIBUS, 100_000_000n)),
};

describe('local sweep signer', () => {
  it('signs from the allocation index and reports the signer', async () => {
    const signed = await new LocalSweepSigner(XPRV, '').sign(request);
    expect(signed.signer).toBe(address);
    expect(signed.rawTransaction.startsWith('0x02')).toBe(true);
  });

  it('refuses an index that does not match the requested address', async () => {
    await expect(new LocalSweepSigner(XPRV, '').sign({
      ...request, address: '0x9999999999999999999999999999999999999999',
    })).rejects.toThrow(/not requested address/);
  });
});

describe('command signers', () => {
  it('sends a sweep-sign payload and validates the type-2 response', async () => {
    let seen: { command: string; payload: unknown } | undefined;
    const runner: CommandRunner = async (command, payload) => {
      seen = { command, payload };
      return { rawTransaction: '0x02ff', signer: address };
    };
    const signed = await new CommandSweepSigner('/usr/local/bin/hsm', runner).sign(request);
    expect(signed).toEqual({ rawTransaction: '0x02ff', signer: address });
    expect(seen?.command).toBe('/usr/local/bin/hsm');
    expect(seen?.payload).toMatchObject({ op: 'sweep-sign', address, addressIndex: 2, nonce: '7' });
  });

  it('refuses a missing signer or a non-type-2 transaction', async () => {
    await expect(new CommandSweepSigner('/hsm', async () => ({
      rawTransaction: '0x02ff',
    })).sign(request)).rejects.toThrow(/signer/);

    await expect(new CommandSweepSigner('/hsm', async () => ({
      rawTransaction: '0x01ff', signer: address,
    })).sign(request)).rejects.toThrow(/type-2/);
  });

  it('delegates L1 minting and treasury release with the expected payloads', async () => {
    const calls: unknown[] = [];
    const runner: CommandRunner = async (_command, payload) => {
      calls.push(payload);
      return { txHash: '0xhash' };
    };

    expect(await new CommandL1Minter('/l1', runner).mint('usdt', 'l1-1', '100000000'))
      .toEqual({ txHash: '0xhash' });
    expect(await new CommandTreasury('/treasury', runner).release(
      'usdt', 'l1-1', OMNIBUS, '2000000',
    )).toEqual({ txHash: '0xhash' });

    expect(calls).toEqual([
      { op: 'l1-mint', assetId: 'usdt', account: 'l1-1', amountRaw: '100000000' },
      {
        op: 'treasury-release',
        assetId: 'usdt',
        account: 'l1-1',
        destination: OMNIBUS,
        externalRaw: '2000000',
      },
    ]);
  });
});
