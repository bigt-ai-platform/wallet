/*******************************************************************************
 *  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/
/*
 * Copyright 2013 Matija Mazi.
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

export class ChildNumber {
    /**
     * The bit that's set in the child number to indicate whether this key is "hardened". Given a hardened key, it is
     * not possible to derive a child public key if you know only the hardened public key. With a non-hardened key this
     * is possible, so you can derive trees of public keys given only a public parent, but the downside is that it's
     * possible to leak private keys if you disclose a parent public key and a child private key (elliptic curve maths
     * allows you to work upwards).
     */
    public static readonly HARDENED_BIT = 0x80000000;

    public static readonly ZERO = new ChildNumber(0);
    public static readonly ONE = new ChildNumber(1);
    public static readonly ZERO_HARDENED = new ChildNumber(0, true);

    /** Integer i as per BIP 32 spec, including the MSB denoting derivation type (0 = public, 1 = private) **/
    private readonly i: number;

    constructor(childNumber: number, isHardened?: boolean) {
        if (isHardened === undefined) {
            // Used when deserializing; the childNumber already includes the hardened bit if set
            // Verify it's a valid 32-bit unsigned integer
            if (childNumber < 0 || childNumber > 0xFFFFFFFF || !Number.isInteger(childNumber)) {
                throw new Error("Child number must be a valid 32-bit unsigned integer: " + childNumber);
            }
            this.i = childNumber;
        } else {
            // Used when creating new ChildNumber from an index
            // If isHardened is true, then childNumber is the index (before applying hardened bit)
            // If isHardened is false, then childNumber is the index (without hardened bit)
            if (childNumber < 0 || childNumber >= ChildNumber.HARDENED_BIT || !Number.isInteger(childNumber)) {
                throw new Error("Child number index must be between 0 and 2^31-1: " + childNumber);
            }
            this.i = isHardened ? (childNumber | ChildNumber.HARDENED_BIT) : childNumber;
        }
    }

    /** Returns the uint32 encoded form of the path element, including the most significant bit. */
    public getI(): number {
        return this.i >>> 0;
    }

    public isHardened(): boolean {
        return ChildNumber.hasHardenedBit(this.i);
    }

    private static hasHardenedBit(a: number): boolean {
        return (a & ChildNumber.HARDENED_BIT) !== 0;
    }

    /** Returns the child number without the hardening bit set (i.e. index in that part of the tree). */
    public num(): number {
        return this.i & (~ChildNumber.HARDENED_BIT);
    }

    public toString(): string {
        return `${this.num()}${this.isHardened() ? "H" : ""}`;
    }

    public equals(o: any): boolean {
        if (this === o) return true;
        if (o == null || this.constructor !== o.constructor) return false;
        return this.i === (o as ChildNumber).i;
    }

    public hashCode(): number {
        return this.i;
    }

    public compareTo(other: ChildNumber): number {
        // note that in this implementation compareTo() is not consistent with equals()
        return this.num() - other.num();
    }
}
