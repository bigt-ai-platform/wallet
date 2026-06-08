;
import { DataClass } from './DataClass';
import { Token } from './Token';
import { MultiSignAddress } from './MultiSignAddress';
import { Sha256Hash } from './Sha256Hash';

import { ObjectMapper, JsonProperty } from 'jackson-js';
/**
 * TokenInfo class represents information about a token and its associated multi-signature addresses.
 * It provides methods to serialize the object to a byte array, parse from a byte array,
 * and manage the token and multi-signature addresses.
 */
export class TokenInfo extends DataClass {
    // The version property is inherited from DataClass and is now protected,
    // so it doesn't need to be redefined here.
    // @JsonProperty() // No longer needed here as it's handled in DataClass

    @JsonProperty()
    private token: Token | null = null;
    @JsonProperty()
    private multiSignAddresses: MultiSignAddress[] = [];

    constructor() {
        super();
        this.multiSignAddresses = [];
    }

    public toByteArray(): Uint8Array {
        try {
            const replacer = (key: string, value: any) => {
                if (typeof value === 'bigint') {
                    return value.toString();
                }
                // For Sha256Hash objects, serialize them as objects with bytes field 
                if (value && value.getBytes && typeof value.getBytes === 'function') {
                    // Return an object with bytes field as byte array
                    return {
                        bytes: Array.from(value.getBytes())  // Convert Buffer to byte array
                    };
                }
                return value;
            };
            const jsonStr = JSON.stringify(this, replacer);
         //   console.log( " TokenInfo=" +   jsonStr   );
            return new TextEncoder().encode(jsonStr);
        } catch (e: any) {
            throw new Error(e);
        } 
    }
 
    public parse(buf: Uint8Array): TokenInfo {
        const jsonStr = new TextDecoder('utf-8').decode(buf);
        const objectMapper = new ObjectMapper();
        const parsed = objectMapper.parse(jsonStr, { 
            mainCreator: () => [TokenInfo],
            features: {
                deserialization: {
                    FAIL_ON_UNKNOWN_PROPERTIES: false
                }
            }
        }) as TokenInfo;
        if (parsed.token) {
            const tokenData = parsed.token as any;
            const token = new Token();
            token.setAmount(BigInt(tokenData.amount));
            token.setTokenid(tokenData.tokenid);
            token.setTokenname(tokenData.tokenname);
            token.setDescription(tokenData.description);
            token.setSignnumber(tokenData.signnumber);
            token.setTokenindex(tokenData.tokenindex);
            token.setTokenstop(tokenData.tokenstop);
            token.setTokentype(tokenData.tokentype);
            token.setDomainName(tokenData.domainName);
            token.setDomainNameBlockHash(tokenData.domainNameBlockHash);
            token.setConfirmed(tokenData.confirmed);
            token.setRevoked(tokenData.revoked);
            token.setLanguage(tokenData.language);
            token.setClassification(tokenData.classification);
            token.setDecimals(tokenData.decimals);
            token.setPrevblockhash(tokenData.prevblockhash);
            token.setBlockHash(tokenData.blockHash);
            parsed.setToken(token);
        }
        
        // Handle MultiSignAddress deserialization
        if (parsed.multiSignAddresses && Array.isArray(parsed.multiSignAddresses)) {
            const reconstructedAddresses: MultiSignAddress[] = [];
            for (const addrData of parsed.multiSignAddresses) {
                const addr = new MultiSignAddress();
                const addrObj = addrData as any;
                if (addrObj.tokenid !== undefined) addr.setTokenid(addrObj.tokenid);
                if (addrObj.address !== undefined) addr.setAddress(addrObj.address);
                if (addrObj.pubKeyHex !== undefined) addr.setPubKeyHex(addrObj.pubKeyHex);
                if (addrObj.posIndex !== undefined) addr.setPosIndex(addrObj.posIndex);
                if (addrObj.tokenHolder !== undefined) addr.setTokenHolder(addrObj.tokenHolder);
                
                // Handle blockhash if it exists
                if (addrObj.blockhash && addrObj.blockhash.bytes) {
                    const hashBytes = new Uint8Array(addrObj.blockhash.bytes);
                    const sha256Hash = Sha256Hash.wrap(hashBytes);
                    if (sha256Hash) {
                        addr.setBlockhash(sha256Hash);
                    }
                }
                
                reconstructedAddresses.push(addr);
            }
            parsed.setMultiSignAddresses(reconstructedAddresses);
        }
        
        return parsed;
    }

    public parseChecked(buf: Uint8Array): TokenInfo {
       
        try { 
            return this.parse(buf);
        } catch (e: any) {
            throw new Error(e);
        }
    }

    public getToken(): Token | null {
        return this.token;
    }

    public setToken(token: Token | null): void {
        this.token = token;
    }

    public getMultiSignAddresses(): MultiSignAddress[] {
        return this.multiSignAddresses;
    }

    public setMultiSignAddresses(multiSignAddresses: MultiSignAddress[]): void {
        this.multiSignAddresses = multiSignAddresses;
    }

    public toString(): string {
        return `TokenInfo [tokens=${this.token}, multiSignAddresses=${this.multiSignAddresses}]`;
    }
}
