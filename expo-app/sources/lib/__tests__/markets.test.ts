import { describe, expect, it } from 'vitest';
import {
  MARKETS,
  MAX_ORDER_RAW,
  checkLongBounds,
  defaultMarketFor,
  findMarket,
  fitsLong,
  marketsFor,
  maxDisplayAmount,
  maxDisplayPrice,
  orderPriceDecimals,
  quoteSymbols,
} from '../markets';

describe('market definitions', () => {
  it('lists the launch set once, without duplicates', () => {
    const ids = MARKETS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['ETHHKD', 'ETHUSD', 'GOLDHKD', 'GOLDUSD', 'HKDUSD', 'ETHBC', 'GOLDBC', 'HKDBC']);
  });

  it('only trades registered external assets', () => {
    for (const market of MARKETS) {
      expect(market.asset).toBe(market.asset.toLowerCase());
      expect(['hkd', 'usd', 'bc']).toContain(market.quote);
      expect(market.label).toContain('/');
    }
  });

  it('never quotes an asset against itself', () => {
    for (const market of MARKETS) {
      expect(market.asset).not.toBe(market.quote);
    }
  });

  it('resolves markets by id and by asset', () => {
    expect(findMarket('goldhkd')?.label).toBe('GOLD/HKD');
    expect(findMarket('nope')).toBeUndefined();
    expect(marketsFor('gold').map((m) => m.quote)).toEqual(['hkd', 'usd', 'bc']);
    expect(defaultMarketFor('eth')?.id).toBe('ETHHKD');
    expect(defaultMarketFor('hkdap')).toBeUndefined();
  });

  it('offers HKD and USD plus the legacy quotes for discovery', () => {
    const symbols = quoteSymbols();
    expect(symbols).toContain('HKD');
    expect(symbols).toContain('USD');
    expect(symbols).toContain('USDT');
    expect(symbols).toContain('CNY');
    expect(symbols).not.toContain('BC');
    expect(new Set(symbols).size).toBe(symbols.length);
  });
});

describe('long ceilings', () => {
  it('uses shift 0 for bc and 6 for every token quote', () => {
    expect(orderPriceDecimals(6, 'bc')).toBe(6);
    expect(orderPriceDecimals(6, 'hkd')).toBe(12);
    expect(orderPriceDecimals(6, 'usd')).toBe(12);
  });

  it('keeps a 6-decimal asset far below the amount ceiling', () => {
    // 9.22e18 raw / 1e6 = 9.22e12 whole units.
    expect(maxDisplayAmount(6)).toBe(MAX_ORDER_RAW / 1_000_000n);
    expect(maxDisplayAmount(6)).toBeGreaterThan(9_000_000_000_000n);
  });

  it('keeps the price ceiling above a realistic ETH/HKD quote', () => {
    const ceiling = maxDisplayPrice(6, 'hkd');
    expect(ceiling).toBe(MAX_ORDER_RAW / 10n ** 12n);
    expect(ceiling).toBeGreaterThan(30_000n); // ETH ~30k HKD is representable
  });

  it('rejects raw values that overflow the on-chain long', () => {
    expect(fitsLong(0n)).toBe(true);
    expect(fitsLong(MAX_ORDER_RAW)).toBe(true);
    expect(fitsLong(MAX_ORDER_RAW + 1n)).toBe(false);
    expect(fitsLong(-1n)).toBe(false);
    expect(checkLongBounds(MAX_ORDER_RAW + 1n, 'price')).toBe('errPrice');
    expect(checkLongBounds(MAX_ORDER_RAW + 1n, 'amount')).toBe('errAmount');
    expect(checkLongBounds(10n, 'amount')).toBeNull();
  });
});
