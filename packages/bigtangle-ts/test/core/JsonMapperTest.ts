
import { Buffer } from 'buffer';
import { ByteListResp } from './ByteListResp';
import { ByteResp } from './ByteResp';
import { Sha256Hash } from '../../src/net/bigtangle/core/Sha256Hash';
import { Coin } from '../../src/net/bigtangle/core/Coin';
import { NetworkParameters } from '../../src/net/bigtangle/params/NetworkParameters';
import { BlockMCMC } from '../../src/net/bigtangle/core/BlockMCMC';
import { Utils } from '../../src/net/bigtangle/utils/Utils';
import { describe, test } from 'vitest';

describe('JsonMapperTest', () => {
    test('testJsonMapperByteList', () => {
        const byteListResp = new ByteListResp();
        const byteResp = new ByteResp();
        byteResp.setData(Buffer.from([0x00, 0x01, 0x02, 0x03]));
        byteListResp.getList().push(byteResp);
        const jsonStr = JSON.stringify(byteListResp);

        console.log(jsonStr);
        const parsedByteListResp = new ByteListResp();
        const parsedJson = JSON.parse(jsonStr);
        const list = parsedJson.list.map((item: any) => {
            const byteResp = new ByteResp();
            byteResp.setData(Buffer.from(item.data.data));
            return byteResp;
        });
        parsedByteListResp.setList(list);
        const parsedByteResp = parsedByteListResp.getList()[0];
        for (const b of parsedByteResp.getData()) {
            console.log(b.toString(16).padStart(2, '0'));
        }
    });

    test('testJsonMapperSha256Hash', () => {
        const rawHashBytes = Buffer.alloc(32);
        for (let i = 0; i < rawHashBytes.length; i++) {
            rawHashBytes[i] = Math.floor(Math.random() * 256);
        }
        let sha256Hash = Sha256Hash.wrap(rawHashBytes);
        if (sha256Hash === null) {
            throw new Error('Failed to create Sha256Hash from raw bytes');
        }
        console.log(Utils.HEX.encode(sha256Hash.getBytes()));
        let jsonStr = JSON.stringify(sha256Hash);

        const parsedJson2 = JSON.parse(jsonStr);
        sha256Hash = Sha256Hash.wrap(Buffer.from(parsedJson2.bytes.data));
        if (sha256Hash === null) {
            throw new Error('Failed to create Sha256Hash from parsed JSON bytes');
        }
        console.log(Utils.HEX.encode(sha256Hash.getBytes()));

        let coin = Coin.valueOf(BigInt(10000), NetworkParameters.getBIGTANGLE_TOKENID() );
        jsonStr = JSON.stringify(coin);

        console.log(jsonStr);

        const parsedCoin = JSON.parse(jsonStr);
        coin = Coin.valueOf(BigInt(parsedCoin.value), parsedCoin.tokenid);
        console.log(coin);
    });

    test('testJsonBlockMCMC', () => {
        const blockMCMC = BlockMCMC.defaultBlockMCMC(Sha256Hash.ZERO_HASH);

        const jsonStr = JSON.stringify(blockMCMC);

        console.log(jsonStr);
     const   b= new BlockMCMC( JSON.parse(jsonStr));
      console.log(b.toString); 
     
    });
});
