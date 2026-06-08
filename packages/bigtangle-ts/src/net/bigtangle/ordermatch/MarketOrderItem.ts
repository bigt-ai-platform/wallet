import { OrderRecord } from '../core/OrderRecord';
import { Token } from '../core/Token';
import { NetworkParameters } from '../params/NetworkParameters';
import { SignedDataClass } from '../apps/data/SignedData';

export interface MarketOrderItem {
  tokenName: string;
  type: string; // 'buy' or 'sell'
  price: number | null;
  orderRecord: OrderRecord;
  token: Token;
}

// Implementation class for MarketOrderItem
export class MarketOrderItemImpl implements MarketOrderItem {
  tokenName: string;
  type: string;
  price: number | null;
  orderRecord: OrderRecord;
  token: Token;

  constructor(
    tokenName: string,
    type: string,
    price: number | null,
    orderRecord: OrderRecord,
    token: Token
  ) {
    this.tokenName = tokenName;
    this.type = type;
    this.price = price;
    this.orderRecord = orderRecord;
    this.token = token;
  }

  static build(
    orderRecord: OrderRecord,
    tokenNames: Map<string, Token> | null,
    params: NetworkParameters,
    buy: string,
    sell: string
  ): MarketOrderItemImpl {
    // Determine token name and type based on the order record
    let tokenName = '';
    let type = '';

    // Determine the token name based on the order record
    if (orderRecord.getSide()?.toString() === 'BUY') {
      // For buy orders, use the target token
      const targetTokenId = orderRecord.getTargetTokenid();
      if (targetTokenId && tokenNames) {
        const token = tokenNames.get(targetTokenId);
        if (token) {
          tokenName = token.getTokenname() || targetTokenId;
        }
      }
    } else {
      // For sell orders, use the offer token
      const offerTokenId = orderRecord.getOfferTokenid();
      if (offerTokenId && tokenNames) {
        const token = tokenNames.get(offerTokenId);
        if (token) {
          tokenName = token.getTokenname() || offerTokenId;
        }
      }
    }

    // Determine if this is a buy or sell order based on the side
    type = orderRecord.getSide()?.toString() === 'BUY' ? 'buy' : 'sell';

    // Get the appropriate token for the order
    let token: Token;
    if (orderRecord.getSide()?.toString() === 'BUY') {
      const targetTokenId = orderRecord.getTargetTokenid();
      token = (targetTokenId && tokenNames) ? (tokenNames.get(targetTokenId) || new Token()) : new Token();
    } else {
      const offerTokenId = orderRecord.getOfferTokenid();
      token = (offerTokenId && tokenNames) ? (tokenNames.get(offerTokenId) || new Token()) : new Token();
    }

    return new MarketOrderItemImpl(
      tokenName,
      type,
      orderRecord.getPrice(),
      orderRecord,
      token
    );
  }
}