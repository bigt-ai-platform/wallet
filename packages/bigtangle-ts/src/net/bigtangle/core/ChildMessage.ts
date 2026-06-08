/*******************************************************************************
 *  Copyright   2018  Inasset GmbH.
 *
 *******************************************************************************/
/*
 * Copyright 2011 Steve Coughlan.
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

import { Message } from './Message';
import { NetworkParameters } from '../params/NetworkParameters';

/**
 * <p>Represents a Message type that can be contained within another Message.  ChildMessages that have a cached
 * backing byte array need to invalidate their parent's caches as well as their own if they are modified.</p>
 *
 * <p>Instances of this class are not safe for use by multiple threads.</p>
 */
export abstract class ChildMessage extends Message {

    protected parent: Message | null = null;


    public constructor(params: NetworkParameters) {
        super(params);
    }


    public setParent(parent: Message | null): void {
        if (this.parent !== null && this.parent !== parent && parent !== null) {
            // After old parent is unlinked it won't be able to receive notice if this ChildMessage
            // changes internally.  To be safe we invalidate the parent cache to ensure it rebuilds
            // manually on serialization.
            if (this.parent instanceof ChildMessage) {
                this.parent.unCache();
            }
        }
        this.parent = parent;
    }

    /* (non-Javadoc)
      * @see Message#unCache()
      */
    protected unCache(): void {
        super.unCache();
        if (this.parent !== null) {
            if (this.parent instanceof ChildMessage) {
                this.parent.unCache();
            }
        }
    }

    protected adjustLength(adjustment: number): void;
    protected adjustLength(newArraySize: number, adjustment: number): void;
    protected adjustLength(newArraySize: number, adjustment?: number): void {
        if (adjustment === undefined) {
            // Call the parent method with just the adjustment parameter
            super.adjustLength(0, newArraySize);
        } else {
            // Call the parent method with both parameters
            super.adjustLength(newArraySize, adjustment);
        }
        if (this.parent !== null) {
            if (this.parent instanceof ChildMessage) {
                this.parent.adjustLength(newArraySize, adjustment || 0);
            }
        }
    }
}
