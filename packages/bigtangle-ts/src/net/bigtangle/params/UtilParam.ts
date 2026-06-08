 
import { NetworkParameters } from './NetworkParameters';
import { MainNetParams } from './MainNetParams';
import { TestParams } from './TestParams';
 
 export class UtilParam   {
    public static fromID(id: string): NetworkParameters   {
        if (id === NetworkParameters.ID_MAINNET) {
            return MainNetParams.get();
        } else if (id === NetworkParameters.ID_UNITTESTNET) {
            return TestParams.get();
        } else {
            return TestParams.get();
        }
    }
}