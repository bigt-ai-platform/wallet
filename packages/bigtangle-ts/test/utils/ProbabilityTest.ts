
import { describe, test, expect } from 'vitest';
import { ProbabilityBlock } from '../../src/net/bigtangle/utils/ProbabilityBlock';

describe('ProbabilityTest', () => {
    test.skip('testSigns', () => {
        for (let z = 1; z < 300; z++) {
            console.log(
                z + '=' + ProbabilityBlock.attackerSuccessProbability(0.3, z),
            );
        }
    });
 
});
