/**
 * EIP-681 payment URIs for the deposit QR.
 *
 *   ethereum:0xADDRESS@1?value=1000000000000000000
 *   ethereum:0xTOKEN@1/transfer?address=0xRECIPIENT&uint256=1000000
 *
 * The parser also accepts a bare `0x…` address so the QR scanner can prefill
 * the withdraw form from a plain wallet address.
 */

import { isAddress, stripHexPrefix } from './address';

export interface EthPaymentUri {
  /** Target: the recipient (native) or the token contract (ERC-20). */
  address: string;
  chainId?: number;
  /** Native value in wei. */
  valueWei?: bigint;
  /** ERC-20 `transfer` target + amount. */
  tokenTransfer?: { to: string; amount: bigint };
}

export function buildEthPaymentUri(params: {
  address: string;
  chainId: number;
  valueWei?: bigint;
  token?: { contract: string; to: string; amount: bigint };
}): string {
  const chain = `@${params.chainId}`;
  if (params.token) {
    const q = `address=${params.token.to}&uint256=${params.token.amount.toString()}`;
    return `ethereum:${params.token.contract}${chain}/transfer?${q}`;
  }
  const q = params.valueWei && params.valueWei > 0n ? `?value=${params.valueWei.toString()}` : '';
  return `ethereum:${params.address}${chain}${q}`;
}

/** Parses `ethereum:` URIs (and a bare address). Returns null otherwise. */
export function parseEthPaymentUri(uri: string): EthPaymentUri | null {
  const text = uri.trim();
  if (!text) return null;
  if (isAddress(text)) return { address: text };
  if (!/^ethereum:/i.test(text)) return null;

  const body = text.slice('ethereum:'.length);
  const [target, query = ''] = body.split('?');
  const [head, func] = target.split('/');
  const [address, chainPart] = head.split('@');
  if (!isAddress(address)) return null;
  const chainId = chainPart && /^\d+$/.test(chainPart) ? Number(chainPart) : undefined;
  const params = new URLSearchParams(query);

  if (func === 'transfer') {
    const to = params.get('address') || '';
    const amount = params.get('uint256') || params.get('value') || '0';
    if (!isAddress(to) || !/^\d+$/.test(amount)) return null;
    return { address, chainId, tokenTransfer: { to, amount: BigInt(amount) } };
  }

  const value = params.get('value');
  return {
    address: `0x${stripHexPrefix(address)}`,
    chainId,
    valueWei: value && /^\d+$/.test(value) ? BigInt(value) : undefined,
  };
}
