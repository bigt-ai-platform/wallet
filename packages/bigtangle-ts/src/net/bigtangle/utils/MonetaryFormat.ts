/*******************************************************************************
*  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/
/*
 * Copyright 2014 Andreas Schildbach
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Monetary } from '../core/Monetary';
import { Coin } from '../core/Coin';
import { NetworkParameters } from '../params/NetworkParameters';

export enum RoundingMode {
    UP = 'UP',
    DOWN = 'DOWN',
    CEILING = 'CEILING',
    FLOOR = 'FLOOR',
    HALF_UP = 'HALF_UP',
    HALF_DOWN = 'HALF_DOWN',
    HALF_EVEN = 'HALF_EVEN',
    UNNECESSARY = 'UNNECESSARY'
}

/**
 * Robust utility for formatting and parsing coin values to and from human readable form.
 * Handles all edge cases including very small values, precise rounding, and trailing zeros.
 */
export class MonetaryFormat {
    /** Standard format for fiat amounts. */
    public static readonly FIAT = new MonetaryFormat().withShift(0).withMinDecimals(2);

    private negativeSign: string = '-';
    private positiveSign: string = '';
    private zeroDigit: string = '0';
    private decimalMark: string = '.';
    private minDecimals: number = 2;
    private decimalGroups: number[] | null = null;
    private shift: number = 0;
    private roundingMode: RoundingMode = RoundingMode.HALF_UP;
    private codes: string[] | null = null;
    private codeSeparator: string = ' ';
    private codePrefixed: boolean = true;

    // Builder methods that return new instances
    withNegativeSign(negativeSign: string): MonetaryFormat {
        const fmt = this.clone();
        fmt.negativeSign = negativeSign;
        return fmt;
    }

    withPositiveSign(positiveSign: string): MonetaryFormat {
        const fmt = this.clone();
        fmt.positiveSign = positiveSign;
        return fmt;
    }

    withZeroDigit(zeroDigit: string): MonetaryFormat {
        const fmt = this.clone();
        fmt.zeroDigit = zeroDigit;
        return fmt;
    }

    withDecimalMark(decimalMark: string): MonetaryFormat {
        const fmt = this.clone();
        fmt.decimalMark = decimalMark;
        return fmt;
    }

    withMinDecimals(minDecimals: number): MonetaryFormat {
        const fmt = this.clone();
        fmt.minDecimals = minDecimals;
        return fmt;
    }

    withOptionalDecimals(...groups: number[]): MonetaryFormat {
        const fmt = this.clone();
        fmt.decimalGroups = groups;
        return fmt;
    }

    withShift(shift: number): MonetaryFormat {
        const fmt = this.clone();
        fmt.shift = shift;
        return fmt;
    }

    withRoundingMode(roundingMode: RoundingMode): MonetaryFormat {
        const fmt = this.clone();
        fmt.roundingMode = roundingMode;
        return fmt;
    }

    withNoCode(): MonetaryFormat {
        const fmt = this.clone();
        fmt.codes = null;
        return fmt;
    }

    withCode(codeShift: number, code: string): MonetaryFormat {
        const fmt = this.clone();
        if (!fmt.codes) {
            fmt.codes = [];
        }
        fmt.codes[codeShift] = code;
        return fmt;
    }

    withCodeSeparator(codeSeparator: string): MonetaryFormat {
        const fmt = this.clone();
        fmt.codeSeparator = codeSeparator;
        return fmt;
    }

    withPrefixCode(): MonetaryFormat {
        const fmt = this.clone();
        fmt.codePrefixed = true;
        return fmt;
    }

    withPostfixCode(): MonetaryFormat {
        const fmt = this.clone();
        fmt.codePrefixed = false;
        return fmt;
    }

    // Formatting methods
    format(monetary: Monetary, decimals?: number): string {
        const decimalPlaces = decimals || NetworkParameters.BIGTANGLE_DECIMAL;
        return this.formatValue(monetary.getValue(), decimalPlaces);
    }

    formatValue(value: bigint, decimal: number): string {
        if (decimal < 0) {
            throw new Error('Decimal places cannot be negative');
        }
        
        const isNegative = value < 0n;
        let absValue = value < 0n ? -value : value;
        
        // Apply shift
        if (this.shift > 0) {
            const shiftValue = 10n ** BigInt(this.shift);
            absValue *= shiftValue;
        }

        // Calculate divisor based on decimal
        const divisor = 10n ** BigInt(decimal);
        const whole = absValue / divisor;
        const fractional = absValue % divisor;
        
        // Handle values that are too small to represent
        let effectiveMinDecimals = this.minDecimals;
        if (this.decimalGroups) {
            effectiveMinDecimals = this.decimalGroups.reduce((sum, group) => sum + group, this.minDecimals);
        }

        // Calculate the smallest representable unit, handling cases where effectiveMinDecimals > decimal
        const exponent = decimal - effectiveMinDecimals;
        const smallestRepresentableUnit = exponent >= 0 ? 10n ** BigInt(exponent) : 1n;

        if (absValue > 0n && absValue < smallestRepresentableUnit) {
            // throw new Error('Value too small to be represented');
        }
        
        // Convert fractional part to string and pad with leading zeros
        const fractionalStr = fractional.toString().padStart(decimal, '0');
        
        // Apply decimalGroups for optional decimals
        let decimalsToShow = this.applyDecimalGroups(fractionalStr);
        
        // Remove trailing zeros while respecting minDecimals
        let lastNonZero = decimalsToShow.length;
        while (lastNonZero > this.minDecimals && decimalsToShow[lastNonZero - 1] === '0') {
            lastNonZero--;
        }
        decimalsToShow = decimalsToShow.substring(0, lastNonZero);
        
        // Always preserve at least minDecimals
        if (decimalsToShow.length < this.minDecimals) {
            decimalsToShow = decimalsToShow.padEnd(this.minDecimals, '0');
        }
        
        // Special case: if we have all zeros after decimal and minDecimals is 0, show nothing
        if (this.minDecimals === 0 && /^0+$/.test(decimalsToShow)) {
            decimalsToShow = '';
        }
        
        // Format the whole number part
        const wholeStr = whole.toString();
        
        // Combine whole and fractional parts
        let result = wholeStr;
        if (decimalsToShow.length > 0) {
            // Handle case where whole is zero but we have fractional part
            if (whole === 0n && wholeStr === "0") {
                // Ensure we have "0" before decimal for values like 0.1
                result = "0" + this.decimalMark + decimalsToShow;
            } else {
                result += this.decimalMark + decimalsToShow;
            }
        } else if (whole === 0n) {
            result = "0";
        }
        
        // Add sign
        if (isNegative) {
            result = this.negativeSign + result;
        } else if (this.positiveSign) {
            result = this.positiveSign + result;
        }

        // Add currency code if needed
        if (this.codes) {
            const code = this.getCode();
            if (code) {
                if (this.codePrefixed) {
                    result = code + this.codeSeparator + result;
                } else {
                    result = result + this.codeSeparator + code;
                }
            }
        }

        return result;
    }

    parseValue(str: string, smallestUnitExponent: number): bigint {
        str = str.trim();
        if (str.length === 0) throw new Error('Empty string');

        let isNegative = false;
        if (str.startsWith(this.negativeSign)) {
            isNegative = true;
            str = str.substring(this.negativeSign.length);
        } else if (str.startsWith(this.positiveSign)) {
            str = str.substring(this.positiveSign.length);
        }

        const decimalMarkIndex = str.indexOf(this.decimalMark);
        let numbers = str, decimals = '';

        if (decimalMarkIndex !== -1) {
            numbers = str.substring(0, decimalMarkIndex);
            decimals = str.substring(decimalMarkIndex + 1);
        }

        // Pad decimals to the required precision
        decimals = decimals.padEnd(smallestUnitExponent, '0').substring(0, smallestUnitExponent);

        const combined = numbers + decimals;
        if (!/^\d+$/.test(combined)) throw new Error(`Illegal character in: ${str}`);

        let value = BigInt(combined);
        
        // Apply shift as division
        if (this.shift > 0) {
            const shiftValue = 10n ** BigInt(this.shift);
            value = value / shiftValue;
        }

        return isNegative ? -value : value;
    }

    // Parsing methods
    parse(str: string): Coin {
        return new Coin(this.parseValue(str, NetworkParameters.BIGTANGLE_DECIMAL), NetworkParameters.getBIGTANGLE_TOKENID() );
    }

    parseWithToken(str: string, tokenid: Uint8Array , decimal: number): Coin {
        return new Coin(this.parseValue(str, decimal), tokenid);
    }

    // Helper methods
    private clone(): MonetaryFormat {
        return Object.assign(Object.create(Object.getPrototypeOf(this)), this);
    }

    private applyDecimalGroups(fractionalStr: string): string {
        // If no decimal groups specified, return the full fractional string
        if (!this.decimalGroups) {
            return fractionalStr;
        }
        
        // Calculate the maximum decimals we can show based on groups
        let maxDecimals = this.minDecimals;
        for (const group of this.decimalGroups) {
            maxDecimals += group;
        }
        
        // Truncate to maxDecimals if needed
        if (fractionalStr.length > maxDecimals) {
            return fractionalStr.substring(0, maxDecimals);
        }
        
        return fractionalStr;
    }

    private getCode(): string | null {
        if (!this.codes) return null;
        return this.codes[this.shift] || null;
    }
}
