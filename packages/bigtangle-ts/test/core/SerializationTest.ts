import { Buffer } from 'buffer';
import { describe, test, expect } from 'vitest';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { ContactInfo } from '../../src/net/bigtangle/core/ContactInfo';
import { Contact } from '../../src/net/bigtangle/core/Contact';
import { OrderOpenInfo } from '../../src/net/bigtangle/core/OrderOpenInfo';
import { Side } from '../../src/net/bigtangle/core/Side';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { ContractEventInfo } from '../../src/net/bigtangle/core/ContractEventInfo';
import { OrderCancelInfo } from '../../src/net/bigtangle/core/OrderCancelInfo';
import { MyHomeAddress } from '../../src/net/bigtangle/core/MyHomeAddress';
import { RewardInfo } from '../../src/net/bigtangle/core/RewardInfo';
import { TokenInfo } from '../../src/net/bigtangle/core/TokenInfo';
import { Token } from '../../src/net/bigtangle/core/Token';
import { MultiSignAddress } from '../../src/net/bigtangle/core/MultiSignAddress';
import { KeyValue } from '../../src/net/bigtangle/core/KeyValue';
import { KeyValueList } from '../../src/net/bigtangle/core/KeyValueList';
import { IdentityCoreClass as IdentityCore } from '../../src/net/bigtangle/apps/data/IdentityCore';
import { IdentityDataClass as IdentityData } from '../../src/net/bigtangle/apps/data/IdentityData';
import { Utils } from '../../src/net/bigtangle/utils/Utils';

describe('SerializationTest', () => {
    function getRandomSha256Hash(): Sha256Hash {
        const rawHashBytes = Buffer.alloc(32);
        for (let i = 0; i < rawHashBytes.length; i++) {
            rawHashBytes[i] = Math.floor(Math.random() * 256);
        }
        const hash = Sha256Hash.wrap(rawHashBytes);
        if (hash === null) {
            throw new Error('Failed to create Sha256Hash');
        }
        return hash;
    }

    test('testContactInfoSerialization', () => {
        const info1 = new ContactInfo();
        info1.setVersion(3);
        const e = new Contact();
        e.setAddress('test1');
        e.setName('test2');
        info1.getContactList().push(e);
        const info2 = new ContactInfo().parse(info1.toByteArray());

        expect(Buffer.compare(info1.toByteArray(), info2.toByteArray())).toBe(0);
        expect(info1.getVersion()).toBe(info2.getVersion());
        expect(info1.getContactList()[0].getAddress()).toBe(
            info2.getContactList()[0].getAddress(),
        );
        expect(info1.getContactList()[0].getName()).toBe(
            info2.getContactList()[0].getName(),
        );
    });

    test('testContactInfo2Serialization', () => {
        const info1 = new ContactInfo();
        info1.setVersion(3);
        const e = new Contact();
        e.setAddress('test1');
        e.setName('');
        info1.getContactList().push(e);
        const info2 = new ContactInfo().parse(info1.toByteArray());

        expect(Buffer.compare(info1.toByteArray(), info2.toByteArray())).toBe(0);
        expect(info1.getVersion()).toBe(info2.getVersion());
        expect(info1.getContactList()[0].getAddress()).toBe(
            info2.getContactList()[0].getAddress(),
        );
        expect(info1.getContactList()[0].getName()).toBe(
            info2.getContactList()[0].getName(),
        );
    });

    test('testOrderOpenInfoSerialization', () => {
        const info1 = new OrderOpenInfo(
            3, // targetValue (number)
            'test1', // targetTokenid
            Buffer.from([2]), // beneficiaryPubKey
            1, // validToTimeMilli (number)
            4, // validFromTimeMilli (number)
            Side.SELL, // side
            'test2', // beneficiaryAddress
            NetworkParameters.BIGTANGLE_TOKENID_STRING, // orderBaseToken
            5, // price (number)
            2, // offerValue (number)
            NetworkParameters.BIGTANGLE_TOKENID_STRING, // offerTokenid
        );
        const info2 = new OrderOpenInfo().parse(info1.toByteArray());

        expect(Buffer.compare(info1.toByteArray(), info2.toByteArray())).toBe(0);
        expect(info1.getBeneficiaryAddress()).toBe(info2.getBeneficiaryAddress());
        expect(
            Buffer.compare(
                info1.getBeneficiaryPubKey()!,
                info2.getBeneficiaryPubKey()!,
            ),
        ).toBe(0);
        expect(info1.getTargetTokenid()).toBe(info2.getTargetTokenid());
        expect(info1.getTargetValue()).toBe(info2.getTargetValue());
        expect(info1.getValidFromTime()).toBe(info2.getValidFromTime());
        expect(info1.getValidToTime()).toBe(info2.getValidToTime());
        expect(info1.getVersion()).toBe(info2.getVersion());
        expect(info1.getPrice()).toBe(info2.getPrice());
        expect(info1.getOfferValue()).toBe(info2.getOfferValue());
        expect(info1.getOfferTokenid()).toBe(info2.getOfferTokenid());
        console.log(Utils.HEX.encode(info1.toByteArray()));
    });

    test('testContractEventInfoSerialization', () => {
        const info1 = new ContractEventInfo(
            'contracttokenid',
            BigInt("1"), // version
            'tokenid',
            'address',
            3, // offerValue (number)
            4, // offerSystem (number)
            '',
        );
        const info2 = new ContractEventInfo().parse(info1.toByteArray());

        expect(Buffer.compare(info1.toByteArray(), info2.toByteArray())).toBe(0);
        expect(info1.getBeneficiaryAddress()).toBe(info2.getBeneficiaryAddress());
        expect(info1.getOfferValue()).toStrictEqual(info2.getOfferValue());
        expect(info1.getOfferTokenid()).toBe(info2.getOfferTokenid());
        expect(info1.getOfferSystem()).toBe(info2.getOfferSystem());
        expect(info1.getContractTokenid()).toBe(info2.getContractTokenid());
        expect(info1.getVersion()).toBe(info2.getVersion());
    });

    test('testOrderCancelInfoSerialization', () => {
        const info1 = new OrderCancelInfo(getRandomSha256Hash());
        const info2 = new OrderCancelInfo().parse(info1.toByteArray());

        expect(Buffer.compare(info1.toByteArray(), info2.toByteArray())).toBe(0);
        expect(info1.getBlockHash().equals(info2.getBlockHash())).toBe(true);
    });

    test('testMyHomeAddressSerialization', () => {
        const info1 = new MyHomeAddress();
        info1.setCity('test1');
        info1.setCountry('test2');
        info1.setEmail('test3');
        info1.setProvince('test4');
        info1.setRemark('test5');
        info1.setStreet('test6');
        const info2 = new MyHomeAddress().parse(info1.toByteArray());

        expect(Buffer.compare(info1.toByteArray(), info2.toByteArray())).toBe(0);
        expect(info1.getCity()).toBe(info2.getCity());
        expect(info1.getCountry()).toBe(info2.getCountry());
        expect(info1.getEmail()).toBe(info2.getEmail());
        expect(info1.getProvince()).toBe(info2.getProvince());
        expect(info1.getRemark()).toBe(info2.getRemark());
        expect(info1.getStreet()).toBe(info2.getStreet());
    });

    test('testRewardInfoSerialization', () => {
        const randomHash = getRandomSha256Hash();
        const blocks = new Set<Sha256Hash>();
        blocks.add(randomHash);
        const info1 = new RewardInfo(randomHash, 2, blocks, 2);
        const bytes1 = info1.toByteArray();
        const info2 = new RewardInfo().parse(bytes1);
        const bytes2 = info2.toByteArray();

        expect(Buffer.compare(bytes1, bytes2)).toBe(0);
        expect(info1.getPrevRewardHash().equals(info2.getPrevRewardHash())).toBe(true);
        expect(info1.getChainlength()).toBe(info2.getChainlength());
        expect(Array.from(info1.getBlocks())[0].equals(Array.from(info2.getBlocks())[0])).toBe(true);
    });

    test('testTokenInfoSerialization', () => {
        const addresses: MultiSignAddress[] = [];
        
        // Create some MultiSignAddress objects to test serialization
        const multiSignAddr1 = new MultiSignAddress('token1', 'address1', 'pubKeyHex1', 1);
        multiSignAddr1.setPosIndex(0);
        multiSignAddr1.setBlockhash(getRandomSha256Hash());
        
        const multiSignAddr2 = new MultiSignAddress('token2', 'address2', 'pubKeyHex2', 2);
        multiSignAddr2.setPosIndex(1);
        multiSignAddr2.setBlockhash(getRandomSha256Hash());
        
        addresses.push(multiSignAddr1, multiSignAddr2);
        
        const tokens = Token.buildSimpleTokenInfo(
            true, // confirmed
            null, // prevblockhash
            '2', // tokenid
            '3', // tokenname
            '4', // description
            3, // signnumber
            2, // tokenindex
            4n, // amount (native bigint)
            true, // tokenstop
            null, // tokenKeyValues
            false, // revoked
            null, // language
            null, // classification
            0, // tokentype
            0, // decimals
            null, // domainName
            null  // domainNameBlockHash
        );
        const info1 = new TokenInfo();
        info1.setToken(tokens);
        info1.setMultiSignAddresses(addresses);
        const bytes1 = info1.toByteArray();
        
        // Test the parse functionality specifically
        const info2 = new TokenInfo().parse(bytes1);
        const bytes2 = info2.toByteArray();
        console.log(Utils.HEX.encode(bytes1));

        expect(Buffer.compare(bytes1, bytes2)).toBe(0);
        expect(info1.getMultiSignAddresses().length).toBe(
            info2.getMultiSignAddresses().length,
        );
        // Verify that the MultiSignAddress data is preserved after serialization/deserialization
        expect(info1.getMultiSignAddresses()[0].getAddress()).toBe(
            info2.getMultiSignAddresses()[0].getAddress()
        );
        expect(info1.getMultiSignAddresses()[0].getTokenid()).toBe(
            info2.getMultiSignAddresses()[0].getTokenid()
        );
        expect(info1.getMultiSignAddresses()[0].getPubKeyHex()).toBe(
            info2.getMultiSignAddresses()[0].getPubKeyHex()
        );
        expect(info1.getMultiSignAddresses()[0].getTokenHolder()).toBe(
            info2.getMultiSignAddresses()[0].getTokenHolder()
        );
        expect(info1.getMultiSignAddresses()[1].getAddress()).toBe(
            info2.getMultiSignAddresses()[1].getAddress()
        );
        expect(info1.getToken()!.getAmount()).toBe(info2.getToken()!.getAmount());
        expect(info1.getToken()!.getBlockHash()).toBe(
            info2.getToken()!.getBlockHash(),
        );
        expect(info1.getToken()!.getDescription()).toBe(
            info2.getToken()!.getDescription(),
        );
        expect(info1.getToken()!.getPrevblockhash()).toBe(
            info2.getToken()!.getPrevblockhash(),
        );
        expect(info1.getToken()!.getSignnumber()).toBe(
            info2.getToken()!.getSignnumber(),
        );
        expect(info1.getToken()!.getTokenid()).toBe(info2.getToken()!.getTokenid());
        expect(info1.getToken()!.getTokenindex()).toBe(
            info2.getToken()!.getTokenindex(),
        );
        expect(info1.getToken()!.getTokenname()).toBe(
            info2.getToken()!.getTokenname(),
        );
        expect(info1.getToken()!.getTokentype()).toBe(
            info2.getToken()!.getTokentype(),
        );
        expect(info1.getToken()!.getDomainName()).toBe(
            info2.getToken()!.getDomainName(),
        );
        expect(info1.getToken()!.isConfirmed()).toBe(
            info2.getToken()!.isConfirmed(),
        );
        expect(info1.getToken()!.isTokenstop()).toBe(
            info2.getToken()!.isTokenstop(),
        );
          expect(info1.getToken()!.getDomainNameBlockHash()).toBe(
            info2.getToken()!.getDomainNameBlockHash(),
        );
       
    });

    test('testKeyValueSerialization', () => {
        const kv = new KeyValue();
        kv.setKey('identity');
        kv.setValue('value');
        const bytes1 = kv.toByteArray();
        const k2 = new KeyValue().parse(bytes1);
        expect(kv.getKey()).toBe(k2.getKey());
        expect(kv.getValue()).toBe(k2.getValue());
    });

    test('testKeyValueListSerialization', () => {
        const kvs = new KeyValueList();

        const first = Buffer.from('my first file');
        let kv = new KeyValue();
        kv.setKey('myfirst');
        kv.setValue(Utils.HEX.encode(first));
        kvs.addKeyvalue(kv);
        kv = new KeyValue();
        kv.setKey('second.pdf');
        kv.setValue(Utils.HEX.encode(Buffer.from('second.pdf')));
        kvs.addKeyvalue(kv);
        const id = new KeyValueList().parse(kvs.toByteArray());

        expect(id.getKeyvalues().length).toBe(2);
    });

    test('testIdentityCoreSerialization', () => {
        const identityCore = new IdentityCore();
        identityCore.setSurname('zhang');
        identityCore.setForenames('san');
        identityCore.setSex('man');
        identityCore.setDateofissue('20200101');
        identityCore.setDateofexpiry('20201231');

        const id = IdentityCore.parse(identityCore.toByteArray());
        expect(id.getDateofissue()).toBe('20200101');
    });

    test('testIdentityCoreDataSerialization', () => {
        const identityCore = new IdentityCore();
        identityCore.setSurname('zhang');
        identityCore.setForenames('san');
        identityCore.setSex('man');
        identityCore.setDateofissue('20200101');
        identityCore.setDateofexpiry('20201231');
        const identityData = new IdentityData();
        identityData.setIdentityCore(identityCore);
        identityData.setIdentificationnumber('120123456789012345');
        identityCore.setDateofbirth('20201231');
        identityData.setPhoto(Buffer.from('readFile'));
        identityData.setIdentityCore(identityCore);
        const id = IdentityData.parse(identityData.toByteArray());
        expect(id.getIdentificationnumber()).toBe('120123456789012345');
        expect(identityData.uniqueNameIdentity()).toBe(
            identityData.uniqueNameIdentity(),
        );
        const identityData2 = new IdentityData();
        identityData2.setIdentificationnumber('546120123456789012345');
        expect(identityData.uniqueNameIdentity()).not.toBe(
            identityData2.uniqueNameIdentity(),
        );
        const identityData3 = new IdentityData();
        expect(identityData.uniqueNameIdentity()).not.toBe(
            identityData3.uniqueNameIdentity(),
        );
        const identityData4 = new IdentityData();
        identityData2.setIdentificationnumber('');
        expect(identityData4.uniqueNameIdentity()).toBe(
            identityData4.uniqueNameIdentity(),
        );
        expect(identityData3.uniqueNameIdentity()).toBe(
            identityData4.uniqueNameIdentity(),
        );
    });

    test.skip('testIdentitySerialization', () => {
        // ECIES encryption not available in TypeScript
    });
});
