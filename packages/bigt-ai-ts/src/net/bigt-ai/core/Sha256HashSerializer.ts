import { JsonStringifier, JsonParser } from 'jackson-js';
import { Sha256Hash } from './Sha256Hash';
;

export class Sha256HashSerializer extends JsonStringifier<Sha256Hash> {
  public stringify(value: Sha256Hash): string {
    const hex = Array.from(value.getBytes()).map(b => b.toString(16).padStart(2, '0')).join('');
    return JSON.stringify(hex);
  }
}

export class Sha256HashDeserializer extends JsonParser<Sha256Hash> {
  public parse(value: any): Sha256Hash {
    const hexString = JSON.parse(value);
    const bytes = new Uint8Array(hexString.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
    const hash = Sha256Hash.wrap(bytes);
    if (hash === null) {
      throw new Error('Invalid hash');
    }
    return hash;
  }
}
