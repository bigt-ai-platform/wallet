import { KeyChainFactory } from './KeyChainFactory';
import { DeterministicSeed } from './DeterministicSeed';
import { KeyCrypter } from '../crypto/KeyCrypter';
import { DeterministicKeyChain } from './DeterministicKeyChain';
import { MarriedKeyChain } from './MarriedKeyChain';
import { DeterministicKey } from '../crypto/DeterministicKey';
import { UnreadableWalletException } from './UnreadableWalletException';
import { HDUtils } from '../crypto/HDUtils';
import { ChildNumber } from '../crypto/ChildNumber';
import { MainNetParams } from '../params/MainNetParams';

/**
 * Default factory for creating keychains while de-serializing.
 */
export class DefaultKeyChainFactory implements KeyChainFactory {
    public makeKeyChain(key: any, firstSubKey: any, seed: DeterministicSeed, crypter: KeyCrypter, isMarried: boolean): DeterministicKeyChain {
        let chain: DeterministicKeyChain;
        if (isMarried) {
            chain = new MarriedKeyChain(MainNetParams.get(), seed, crypter);
        } else {
            chain = new DeterministicKeyChain(MainNetParams.get(), seed);
        }
        return chain;
    }

    public makeWatchingKeyChain(key: any, firstSubKey: any, accountKey: DeterministicKey,
                                                      isFollowingKey: boolean, isMarried: boolean): DeterministicKeyChain {
        const accountPath = accountKey.getPath();
        const expectedPath = [
            new ChildNumber(44 | 0x80000000),
            new ChildNumber(0 | 0x80000000),
            new ChildNumber(0 | 0x80000000)
        ];
        
        if (!(accountPath.length === expectedPath.length && 
              accountPath.every((val, idx) => val.equals(expectedPath[idx])))) {
            throw new UnreadableWalletException(`Expecting account key but found key with path: ${HDUtils.formatPath(accountPath)}`);
        }
        
        let chain: DeterministicKeyChain;
        if (isMarried) {
            chain = new MarriedKeyChain(MainNetParams.get(), accountKey);
        } else {
            chain = new DeterministicKeyChain(MainNetParams.get(), accountKey);
        }
        return chain;
    }
}
