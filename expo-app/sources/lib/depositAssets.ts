/**
 * Assets that can be deposited into the wallet's chains from an external
 * network. Today the bridge supports USDT on Ethereum -> the USDT token created
 * on the L1 order chain (the issuer credits it 1:1 after the deposit confirms).
 *
 * Add a network here once its issuer side exists; the screen is a coin ->
 * network -> address flow, so no UI change is needed for extra rows.
 */

export interface DepositNetwork {
  id: string;
  /** Shown in the network picker, exchange style: "Ethereum (ERC-20)". */
  name: string;
  /** EVM chain the source token lives on. */
  chain: 'mainnet' | 'sepolia';
  /** Source ERC-20 contract. */
  tokenAddress: string;
  decimals: number;
  explorer: string;
}

export interface DepositAsset {
  /** Display symbol on both sides. */
  coin: string;
  name: string;
  networks: DepositNetwork[];
}

export const DEPOSIT_ASSETS: DepositAsset[] = [
  {
    coin: 'USDT',
    name: 'Tether USD',
    networks: [
      {
        id: 'ethereum',
        name: 'Ethereum (ERC-20)',
        chain: 'mainnet',
        tokenAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        decimals: 6,
        explorer: 'https://etherscan.io',
      },
    ],
  },
];

export function findDepositAsset(coin: string): DepositAsset | undefined {
  return DEPOSIT_ASSETS.find((a) => a.coin === coin);
}

export function findDepositNetwork(coin: string, networkId: string): DepositNetwork | undefined {
  return findDepositAsset(coin)?.networks.find((n) => n.id === networkId);
}
