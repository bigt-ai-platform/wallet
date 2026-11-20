/**
 * External assets — value that enters the system from outside and is
 * represented on `L1-order` by a token **we issue**.
 *
 * Two distinct roles, deliberately kept apart (design §1.1):
 *
 * - **Tradable** (`orderTrading.enabled`): a token on `L1-order` that the order
 *   book can escrow. Four of them — HKD, USD, GOLD and the custodial ETH token —
 *   each backed 1:1 by its own reserve and all at **6 decimals** (one constant;
 *   the `long` price ceiling in `OrderOpenInfo` makes 18 unusable and 2 awkward).
 * - **Rail only** (`orderTrading.enabled === false`): an external instrument we
 *   integrate but never wrap. HKDAP/PAXG/USDC live here — deposit/convert into
 *   one of the four, never an L1 token of their own. Wrapping a third-party
 *   token would leave our supply unbacked the moment its issuer freezes us.
 *
 * Adding a tradable asset is a registry change plus an issuance ceremony; the
 * order book needs no code change (`getOrderPriceShift` already returns 6 for
 * every non-`bc` base token).
 */

import { formatUnits, isValidUnits, parseUnits } from './eth/units';

/** Who holds the asset and executes transfers. */
export type ExternalCustody = 'distributor' | 'issuer';

/** What the recipient field accepts. */
export type ExternalDestination = 'evm-address' | 'account-id' | 'l1-address';

/** Finality the UI may promise. */
export type ExternalFinality = 'ethereum-finalized' | 'distributor-final' | 'l1-finalized';

/** How the L1 token comes into existence. */
export type ExternalWrapModel = 'native-issue' | 'issuer-credit';

/** Funding rail the deposit screen shows for an asset. */
export type DepositKind = 'bank' | 'vault' | 'evm' | 'l1';

export interface ExternalAssetCompliance {
  /** Transfers only between allowlisted holders. */
  permissioned: boolean;
  /** The issuer must whitelist the counterparty before it can transact. */
  allowlistRequired: boolean;
  /** Issuer can pause the token. */
  pauseable: boolean;
  /** Issuer can freeze/force-destroy a holder's balance. */
  freezeable: boolean;
  /** Mint and redeem are issuer operations, not user transfers. */
  mintRedeem: boolean;
}

/**
 * How the asset participates in the order book. `enabled === false` means rail
 * only: the wallet may deposit/withdraw it, but no L1 token exists and no pair
 * is listed.
 */
export interface ExternalOrderTrading {
  enabled: boolean;
  /**
   * `tokenid` on `L1-order` (the issuer public key hex) once the token exists.
   * Empty until the issuance ceremony has run — the wallet stays honest about
   * an asset that is configured but not yet issued.
   */
  l1TokenId?: string;
  /** Always 6 for a listed asset; repeated here so a UI never guesses. */
  decimals: number;
  /** Default quote asset id for a new market (`hkd`, `usd`, `bc`). */
  defaultQuote: string;
}

export interface ExternalAsset {
  /** Stable key used in API calls (`assetId`) and market definitions. */
  id: string;
  symbol: string;
  name: string;
  /** Display decimals as reported by the issuer/contract. */
  decimals: number;
  /** Human network label: "Ethereum (ERC-20)", "L1-order", "Bank rail". */
  network: string;
  /** Canonical chain the value rests on outside our book. */
  canonicalChain: string;
  issuer: string;
  jurisdiction: string;
  custody: ExternalCustody;
  destination: ExternalDestination;
  settlementFinality: ExternalFinality;
  /** Present only for assets we tokenise on `L1-order`. */
  wrapModel?: ExternalWrapModel;
  /** Rail the user funds this asset through. */
  depositKind: DepositKind;
  compliance: ExternalAssetCompliance;
  orderTrading: ExternalOrderTrading;
  /** Shown under the asset row; keeps the "not a rebrand" distinction visible. */
  note?: string;
}

const SIX_DECIMALS = 6;

const FIAT_COMPLIANCE: ExternalAssetCompliance = {
  permissioned: true,
  allowlistRequired: true,
  pauseable: true,
  freezeable: true,
  mintRedeem: true,
};

/**
 * HKD-X — our HKD stablecoin on `L1-order`.
 *
 * Native issuance, 1:1 bank reserve, allowlist + pause. **Not HKDAP** and must
 * never be described as HKDAP-backed (design §3.1).
 */
export const HKD: ExternalAsset = {
  id: 'hkd',
  symbol: 'HKD',
  depositKind: 'bank',
  name: 'HKD Stablecoin',
  decimals: SIX_DECIMALS,
  network: 'L1-order',
  canonicalChain: 'l1-order',
  issuer: 'Bigtangle (licensed entity)',
  jurisdiction: 'HK',
  custody: 'issuer',
  destination: 'l1-address',
  settlementFinality: 'l1-finalized',
  wrapModel: 'native-issue',
  compliance: FIAT_COMPLIANCE,
  orderTrading: { enabled: true, decimals: SIX_DECIMALS, defaultQuote: 'bc' },
  note: 'Issued by us against a segregated HKD reserve. Not a token of any third party.',
};

/** USD-X — our USD stablecoin on `L1-order` (design §3.1). */
export const USD: ExternalAsset = {
  id: 'usd',
  symbol: 'USD',
  depositKind: 'bank',
  name: 'USD Stablecoin',
  decimals: SIX_DECIMALS,
  network: 'L1-order',
  canonicalChain: 'l1-order',
  issuer: 'Bigtangle (licensed entity)',
  jurisdiction: 'HK',
  custody: 'issuer',
  destination: 'l1-address',
  settlementFinality: 'l1-finalized',
  wrapModel: 'native-issue',
  compliance: FIAT_COMPLIANCE,
  orderTrading: { enabled: true, decimals: SIX_DECIMALS, defaultQuote: 'hkd' },
  note: 'A liability of this issuer, not USDC and not Tether.',
};

/**
 * GOLD — our allocated-gold token on `L1-order` (design §3.2).
 *
 * Allocated, bankruptcy-remote backing; the chain stores only the bar-list
 * hash. Pause on audit or insurance failure.
 */
export const GOLD: ExternalAsset = {
  id: 'gold',
  symbol: 'GOLD',
  depositKind: 'vault',
  name: 'Gold',
  decimals: SIX_DECIMALS,
  network: 'L1-order',
  canonicalChain: 'l1-order',
  issuer: 'Bigtangle (vault-held)',
  jurisdiction: 'HK',
  custody: 'issuer',
  destination: 'l1-address',
  settlementFinality: 'l1-finalized',
  wrapModel: 'native-issue',
  compliance: {
    permissioned: false,
    allowlistRequired: false,
    pauseable: true,
    freezeable: true,
    mintRedeem: true,
  },
  orderTrading: { enabled: true, decimals: SIX_DECIMALS, defaultQuote: 'hkd' },
  note: '1 unit = 1 microgram of allocated gold. Physical redemption has a minimum.',
};

/**
 * ETH_TOKEN — the custodial ETH representation on `L1-order` (design §3.3).
 *
 * Display name is **ETH** (product decision). It is a custodial claim on ETH
 * held by the issuer, not native ETH, and not Ethereum's contract-wrapped
 * wETH. That distinction therefore has to be carried by the UI: the asset must
 * always render with its `L1-order` network badge, must reject `0x`
 * recipients, and its market labels use this token's name — never the
 * underlying's. `wrapModel: 'issuer-credit'` is the machine-readable marker.
 */
export const ETH_TOKEN: ExternalAsset = {
  id: 'eth',
  symbol: 'ETH',
  depositKind: 'evm',
  name: 'Ether (custodial)',
  decimals: SIX_DECIMALS,
  network: 'L1-order',
  canonicalChain: 'ethereum',
  issuer: 'Bigtangle (custodian)',
  jurisdiction: 'HK',
  custody: 'issuer',
  destination: 'l1-address',
  settlementFinality: 'ethereum-finalized',
  wrapModel: 'issuer-credit',
  compliance: {
    permissioned: false,
    allowlistRequired: false,
    pauseable: true,
    freezeable: true,
    mintRedeem: true,
  },
  orderTrading: { enabled: true, decimals: SIX_DECIMALS, defaultQuote: 'hkd' },
  note: 'Custodial claim on ETH held by the issuer. Redeemable only through the issuer.',
};

/**
 * HKDAP — HKD At Par, an external permissioned ERC-20 held through an
 * authorised distributor.
 *
 * **Rail only, decided:** not our asset, our `StablecoinPolicy` cannot control
 * it, and a wrapped copy would be unbacked the moment Anchorpoint freezes or
 * force-destroys our custody address. Deposit/convert rail and custodian DvP;
 * never a pair (design §1).
 */
export const HKDAP: ExternalAsset = {
  id: 'hkdap',
  symbol: 'HKDAP',
  depositKind: 'evm',
  name: 'HKD At Par',
  decimals: SIX_DECIMALS,
  network: 'Ethereum (ERC-20)',
  canonicalChain: 'ethereum',
  issuer: 'Anchorpoint Financial',
  jurisdiction: 'HK',
  custody: 'distributor',
  destination: 'evm-address',
  settlementFinality: 'ethereum-finalized',
  compliance: {
    permissioned: true,
    allowlistRequired: true,
    pauseable: true,
    freezeable: true,
    mintRedeem: true,
  },
  orderTrading: { enabled: false, decimals: SIX_DECIMALS, defaultQuote: 'hkd' },
  note: 'Institution-only. Not a token issued by this wallet and not the native HKD token.',
};

/** Every external asset the wallet can show. Tradable first. */
export const EXTERNAL_ASSETS: ExternalAsset[] = [HKD, USD, GOLD, ETH_TOKEN, HKDAP];

export function listExternalAssets(): ExternalAsset[] {
  return EXTERNAL_ASSETS.slice();
}

/** The four assets that can be escrowed by the order book. */
export function tradableExternalAssets(): ExternalAsset[] {
  return EXTERNAL_ASSETS.filter((a) => a.orderTrading.enabled);
}

/** Look up by `id` or `symbol`, case-insensitively. */
export function findExternalAsset(idOrSymbol: string): ExternalAsset | undefined {
  const key = (idOrSymbol ?? '').trim().toLowerCase();
  if (!key) return undefined;
  return EXTERNAL_ASSETS.find(
    (a) => a.id.toLowerCase() === key || a.symbol.toLowerCase() === key
  );
}

export function requireExternalAsset(idOrSymbol: string): ExternalAsset {
  const asset = findExternalAsset(idOrSymbol);
  if (!asset) throw new Error(`Unknown external asset: ${idOrSymbol}`);
  return asset;
}

export const isExternalAsset = (idOrSymbol: string): boolean =>
  !!findExternalAsset(idOrSymbol);

/**
 * Map an on-chain token id back to its asset. The issuance ceremony sets
 * `orderTrading.l1TokenId`; until then this returns undefined for that asset.
 */
export function findExternalAssetByTokenId(tokenId: string): ExternalAsset | undefined {
  const key = (tokenId ?? '').trim().toLowerCase();
  if (!key) return undefined;
  return EXTERNAL_ASSETS.find((a) => a.orderTrading.l1TokenId?.toLowerCase() === key);
}

/**
 * Smallest units (as returned by the distributor) → localized display string.
 * No floats: the API contract is a decimal string of the raw amount.
 */
export function formatExternalAmount(raw: string | bigint, asset: ExternalAsset, locale = 'en'): string {
  let value: bigint;
  try {
    value = typeof raw === 'bigint' ? raw : BigInt(raw || '0');
  } catch {
    return '0';
  }
  return formatUnits(value, asset.decimals, locale);
}

/** Display string → smallest units; throws on too many decimals / bad input. */
export function parseExternalAmount(text: string, asset: ExternalAsset): bigint {
  return parseUnits(text, asset.decimals);
}

export function isValidExternalAmount(text: string, asset: ExternalAsset): boolean {
  return isValidUnits(text, asset.decimals);
}

/**
 * Payment reference the user must include on a bank/vault deposit.
 *
 * Deterministic from `(asset, account, nonce)` so the issuer can match a
 * transfer to a holder without the app inventing anything: the reference is
 * shown, copied, and parsed back out of the statement. Constrained to
 * `A-Z0-9-` and 32 characters because bank reference fields reject the rest.
 */
export function buildDepositReference(asset: ExternalAsset, account: string, nonce: string): string {
  const prefix = asset.symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'ASSET';
  const clean = (account ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const snippet = (clean.slice(-6) || 'WALLET').padStart(6, '0');
  const tail = String(nonce ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10);
  if (!tail) throw new Error('nonce is required');
  return `${prefix}-${snippet}-${tail}`.slice(0, 32);
}

/** Compliance labels the UI shows as chips, in a stable order. */
export function complianceFlags(asset: ExternalAsset): Array<keyof ExternalAssetCompliance> {
  const flags = asset.compliance;
  return (Object.keys(flags) as Array<keyof ExternalAssetCompliance>).filter((k) => flags[k]);
}
