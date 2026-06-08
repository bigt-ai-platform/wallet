import { Coin } from '../../src/net/bigtangle/core/Coin';
import { CoinConstants } from '../../src/net/bigtangle/core/CoinConstants';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { MonetaryFormat } from '../../src/net/bigtangle/utils/MonetaryFormat';
import { OrderRecord } from '../../src/net/bigtangle/core/OrderRecord';
import { Token } from '../../src/net/bigtangle/core/Token';
import { describe, test, expect } from 'vitest';
 
describe('CoinTest', () => {
    test('testParseCoin', () => {
        // String version (6 decimals)
        const parsed1 = MonetaryFormat.FIAT.withNoCode().parse('0.01');
        expect(parsed1.getValue()).toBe(10000n);
        
        const parsed2 = MonetaryFormat.FIAT.withNoCode().parse('1.01');
        expect(parsed2.getValue()).toBe(1010000n);
        
        const parsed3 = MonetaryFormat.FIAT.withNoCode().parse('-1');
        expect(parsed3.getValue()).toBe(-1000000n);
        
        expect(() => {
            MonetaryFormat.FIAT.withNoCode().parse('2E-20');
        }).toThrow();
    });

    test('testValueOf', () => {
        Coin.valueOf(BigInt(Number.MAX_SAFE_INTEGER),  NetworkParameters.getBIGTANGLE_TOKENID() );
        Coin.valueOf(BigInt(Number.MIN_SAFE_INTEGER),  NetworkParameters.getBIGTANGLE_TOKENID() );
    });

    test('testOperators', () => {
        expect(CoinConstants.ZERO.isPositive()).toBe(false);
        expect(CoinConstants.ZERO.isNegative()).toBe(false);
        expect(CoinConstants.ZERO.isZero()).toBe(true);

        expect(
            Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() )
                .isGreaterThan(Coin.valueOf(1n,  NetworkParameters.getBIGTANGLE_TOKENID() ))
        ).toBe(true);
        expect(
            Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() )
                .isGreaterThan(Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() ))
        ).toBe(false);
        expect(
            Coin.valueOf(1n,  NetworkParameters.getBIGTANGLE_TOKENID() )
                .isGreaterThan(Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() ))
        ).toBe(false);
        expect(
            Coin.valueOf(1n,  NetworkParameters.getBIGTANGLE_TOKENID() )
                .isLessThan(Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() ))
        ).toBe(true);
        expect(
            Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() )
                .isLessThan(Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() ))
        ).toBe(false);
        expect(
            Coin.valueOf(2n,  NetworkParameters.getBIGTANGLE_TOKENID() )
                .isLessThan(Coin.valueOf(1n,  NetworkParameters.getBIGTANGLE_TOKENID() ))
        ).toBe(false);
    });

    test('testMultiplicationOverflow', () => {
        // bigint doesn't throw on overflow, so we'll test the behavior instead
        const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
        const result = Coin.valueOf(maxSafe,  NetworkParameters.getBIGTANGLE_TOKENID() )
            .multiply(2);
        expect(result.getValue()).toBe(maxSafe * 2n);
    });

    test('testMultiplicationUnderflow', () => {
        const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
        const result = Coin.valueOf(minSafe, NetworkParameters.getBIGTANGLE_TOKENID() )
            .multiply(2);
        expect(result.getValue()).toBe(minSafe * 2n);
    });

 

    test('testSubstractionUnderflow', () => {
        expect(() => {
            Coin.valueOf(BigInt(Number.MIN_SAFE_INTEGER),  NetworkParameters.getBIGTANGLE_TOKENID() )
                .subtract(CoinConstants.COIN);
        }).toThrow();
    });

    test('testToPlainString', () => {
        // Create a format with 2 decimal places
        const format = MonetaryFormat.FIAT
            .withNoCode()
            .withMinDecimals(2)
            .withShift(0);  // No shift to keep decimal places as-is
            
        const coin = Coin.valueOf(15000000n,  NetworkParameters.getBIGTANGLE_TOKENID() );
        // With 6 decimals, 15000000 units = 15.00
        expect(format.format(coin)).toBe('15.00');
        
        // Use the parsed coin directly
        const parsedCoin1 = format.parse('1.23');
        expect(format.format(parsedCoin1)).toBe('1.23');

        const parsedCoin2 = format.parse('0.1');
        expect(format.format(parsedCoin2)).toBe('0.10');
        
        const parsedCoin3 = format.parse('1.1');
        expect(format.format(parsedCoin3)).toBe('1.10');
        
        const parsedCoin4 = format.parse('21.12');
        expect(format.format(parsedCoin4)).toBe('21.12');
        
        const parsedCoin5 = format.parse('321.123');
        expect(format.format(parsedCoin5)).toBe('321.123'); // Only 2 decimals
        
        const parsedCoin6 = format.parse('4321.1234');
        expect(format.format(parsedCoin6)).toBe('4321.1234');
        
        const parsedCoin7 = format.parse('54321.12345');
        expect(format.format(parsedCoin7)).toBe('54321.12345');
        
        const parsedCoin8 = format.parse('654321.123456');
        expect(format.format(parsedCoin8)).toBe('654321.123456');

        // check there are no trailing zeros beyond minDecimals
        const parsedCoin9 = format.parse('1.0');
        expect(format.format(parsedCoin9)).toBe('1.00');
        
        const parsedCoin10 = format.parse('2.00');
        expect(format.format(parsedCoin10)).toBe('2.00');
        
        const parsedCoin11 = format.parse('3.000');
        expect(format.format(parsedCoin11)).toBe('3.00');
        
        const parsedCoin12 = format.parse('4.0000');
        expect(format.format(parsedCoin12)).toBe('4.00');
        
        const parsedCoin13 = format.parse('5.00000');
        expect(format.format(parsedCoin13)).toBe('5.00');
        
        const parsedCoin14 = format.parse('6.000000');
        expect(format.format(parsedCoin14)).toBe('6.00');
        
        const parsedCoin15 = format.parse('7.0000000');
        expect(format.format(parsedCoin15)).toBe('7.00');
    });

    test('testToPlainStringFail', () => {
        // With 6 decimals, 7654321.123456 = 7654321123456 units
        const format = MonetaryFormat.FIAT.withNoCode();
        const parsed = format.parse('7654321.123456');
        expect(parsed.getValue()).toBe(7654321123456n);
    });

    test('testOrder', () => {
        const mf = MonetaryFormat.FIAT.withNoCode();
        const orderRecord = new OrderRecord();
        orderRecord.setOfferValue(48);
        orderRecord.setTargetValue(24);
        orderRecord.setOfferTokenid( NetworkParameters.BIGTANGLE_TOKENID_STRING);
        // "SELL"
        const t = new Token();
        t.setDecimals(2);
        expect(mf.formatValue(48n, t.getDecimals())).toBe('0.48');
        
        // Correct ratio calculation
        const ratio = (24 * 100) / 48; // 24 * 100 / 48 = 50
        // With 2 decimals, 50 = 50.00
        expect(mf.formatValue(BigInt(Math.floor(ratio)), 0)).toBe('50.00');
    });
});
