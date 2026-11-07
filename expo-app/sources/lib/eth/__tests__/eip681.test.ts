import { describe, expect, it } from 'vitest';
import { buildEthPaymentUri, parseEthPaymentUri } from '../eip681';

const ADDR = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';
const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const TO = '0x2c7536E3605D9C16a7a3D7b1898e529396a65c23';

describe('EIP-681 payment URIs', () => {
  it('builds a native transfer URI with value', () => {
    const uri = buildEthPaymentUri({ address: ADDR, chainId: 1, valueWei: 10n ** 18n });
    expect(uri).toBe(`ethereum:${ADDR}@1?value=1000000000000000000`);
  });

  it('builds an ERC-20 transfer URI', () => {
    const uri = buildEthPaymentUri({
      address: ADDR,
      chainId: 1,
      token: { contract: TOKEN, to: TO, amount: 1_000_000n },
    });
    expect(uri).toBe(`ethereum:${TOKEN}@1/transfer?address=${TO}&uint256=1000000`);
  });

  it('round-trips a native URI', () => {
    expect(parseEthPaymentUri(`ethereum:${ADDR}@1?value=42`)).toEqual({
      address: ADDR,
      chainId: 1,
      valueWei: 42n,
    });
    expect(parseEthPaymentUri(`ethereum:${ADDR}`)).toEqual({ address: ADDR, chainId: undefined, valueWei: undefined });
  });

  it('parses an ERC-20 URI', () => {
    const parsed = parseEthPaymentUri(`ethereum:${TOKEN}@11155111/transfer?address=${TO}&uint256=7`);
    expect(parsed?.tokenTransfer).toEqual({ to: TO, amount: 7n });
    expect(parsed?.chainId).toBe(11155111);
  });

  it('accepts a bare address and rejects junk', () => {
    expect(parseEthPaymentUri(ADDR)).toEqual({ address: ADDR });
    expect(parseEthPaymentUri('bitcoin:bc1qxyz')).toBeNull();
    expect(parseEthPaymentUri('ethereum:0x1234@1')).toBeNull();
    expect(parseEthPaymentUri('')).toBeNull();
  });
});
