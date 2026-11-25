import { SignedDataClass } from '../apps/data/SignedData';
import { Token } from '../core/Token';

export interface SignedDataWithToken {
  signedData: SignedDataClass;
  token: Token;
}

// Implementation class for SignedDataWithToken
export class SignedDataWithTokenImpl implements SignedDataWithToken {
  signedData: SignedDataClass;
  token: Token;

  constructor(signedData: SignedDataClass, token: Token) {
    this.signedData = signedData;
    this.token = token;
  }
}