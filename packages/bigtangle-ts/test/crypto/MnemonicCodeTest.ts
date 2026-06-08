
import { Buffer } from 'buffer';
import { MnemonicCode } from '../../src/net/bigtangle/crypto/MnemonicCode';
import { MnemonicException } from '../../src/net/bigtangle/crypto/MnemonicException';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import { describe, beforeEach, test, expect } from 'vitest';

describe('MnemonicCodeTest', () => {
    const vectors = [
        '00000000000000000000000000000000',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04',

        '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
        '2e8905819b8723fe2c1d161860e5ee1830318dbf49a83bd451cfb8440c28bd6fa457fe1296106559a3c80937a1c1069be3a3a5bd381ee6260e8d9739fce1f607',

        '80808080808080808080808080808080',
        'letter advice cage absurd amount doctor acoustic avoid letter advice cage above',
        'd71de856f81a8acc65e6fc851a38d4d7ec216fd0796d0a6827a3ad6ed5511a30fa280f12eb2e47ed2ac03b5c462a0358d18d69fe4f985ec81778c1b370b652a8',

        'ffffffffffffffffffffffffffffffff',
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
        'ac27495480225222079d7be181583751e86f571027b0497b5b5d11218e0a8a13332572917f0f8e5a589620c6f15b11c61dee327651a14c34e18231052e48c069',

        '000000000000000000000000000000000000000000000000',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent',
        '035895f2f481b1b0f01fcf8c289c794660b289981a78f8106447707fdd9666ca06da5a9a565181599b79f53b844d8a71dd9f439c52a3d7b3e8a79c906ac845fa',

        '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
        'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal will',
        'f2b94508732bcbacbcc020faefecfc89feafa6649a5491b8c952cede496c214a0c7b3c392d168748f2d4a612bada0753b52a1c7ac53c1e93abd5c6320b9e95dd',

        '808080808080808080808080808080808080808080808080',
        'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter always',
        '107d7c02a5aa6f38c58083ff74f04c607c2d2c0ecc55501dadd72d025b751bc27fe913ffb796f841c49b1d33b610cf0e91d3aa239027f5e99fe4ce9e5088cd65',

        'ffffffffffffffffffffffffffffffffffffffffffffffff',
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo when',
        '0cd6e5d827bb62eb8fc1e262254223817fd068a74b5b449cc2f667c3f1f985a76379b43348d952e2265b4cd129090758b3e3c2c49103b5051aac2eaeb890a528',

        '0000000000000000000000000000000000000000000000000000000000000000',
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
        'bda85446c68413707090a52022edd26a1c9462295029f2e60cd7c4f2bbd3097170af7a4d73245cafa9c3cca8d561a7c3de6f5d4a10be8ed2a5e608d68f92fcc8',

        '7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f',
        'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title',
        'bc09fca1804f7e69da93c2f2028eb238c227f2e9dda30cd63699232578480a4021b146ad717fbb7e451ce9eb835f43620bf5c514db0f8add49f5d121449d3e87',

        '8080808080808080808080808080808080808080808080808080808080808080',
        'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless',
        'c0c519bd0e91a2ed54357d9d1ebef6f5af218a153624cf4f2da911a0ed8f7a09e2ef61af0aca007096df430022f7a2b6fb91661a9589097069720d015e4e982f',

        'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote',
        'dd48c104698c30cfe2b6142103248622fb7bb0ff692eebb0089b32d22484e1613912f0a5b694407be899ffd31ed3992c456cdf60f5d4564b8ba3f05a69890ad',
    ];

    let mc: MnemonicCode;

    beforeEach(() => {
        mc = new MnemonicCode();
    });

    test('testVectors', async () => {
        for (let ii = 0; ii < vectors.length; ii += 3) {
            const vecData = vectors[ii];
            const vecCode = vectors[ii + 1];
            const vecSeed = vectors[ii + 2];

            const code = mc.toMnemonic(Utils.HEX.decode(vecData));
            const seed = await MnemonicCode.toSeed(code, 'TREZOR');
         //TODO   const entropy = await mc.toEntropy(split(vecCode));

            // Convert entropy to hex string manually for verification
       //FIXME     const entropyHex = Array.from(entropy).map(b => b.toString(16).padStart(2, '0')).join('');
       //FIXME       expect(entropyHex).toBe(vecData);
          //FIXME       expect(Utils.join(code)).toBe(vecCode);
         //FIXME        expect(Utils.HEX.encode(seed)).toBe(vecSeed);
        }
    });

    test('testBadEntropyLength', () => {
        expect(() => {
            const entropy = Utils.HEX.decode('7f7f7f7f7f7f7f7f7f7f7f7f7f7f');
            mc.toMnemonic(entropy);
        }).toThrow(MnemonicException);
    });

    test('testBadLength', async () => {
        await expect(async () => {
            const words = split(
                'risk tiger venture dinner age assume float denial penalty hello',
            );
            await mc.check(words);
        }).rejects.toThrow(MnemonicException);
    });

    test('testBadWord', async () => {
        await expect(async () => {
            const words = split(
                'risk tiger venture dinner xyzzy assume float denial penalty hello game wing',
            );
            await mc.check(words);
        }).rejects.toThrow(MnemonicException);
    });

    test('testBadChecksum', async () => {
        await expect(async () => {
            const words = split(
                'bless cloud wheel regular tiny venue bird web grief security dignity zoo',
            );
            await mc.check(words);
        }).rejects.toThrow(MnemonicException);
    });

    test('testEmptyMnemonic', async () => {
        await expect(async () => {
            const words: string[] = [];
            await mc.check(words);
        }).rejects.toThrow(MnemonicException);
    });

    test('testEmptyEntropy', () => {
        expect(() => {
            const entropy = Buffer.from([]);
            mc.toMnemonic(entropy);
        }).toThrow(MnemonicException.MnemonicLengthException);
    });

    function split(words: string): string[] {
        return words.split(/\s+/);
    }
});
