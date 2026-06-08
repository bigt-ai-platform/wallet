import { Sha256Hash } from "./Sha256Hash";
import { SpentBlock } from "./SpentBlock";
import { Side } from "./Side";
import {
  JsonProperty,
  JsonClassType,
} from "jackson-js";


export class OrderRecord extends SpentBlock {
  @JsonProperty()
  private issuingMatcherBlockHash: Sha256Hash | null = null;
  @JsonProperty() offerValue: number = 0;
  @JsonProperty() offerTokenid: string | null = null;
  @JsonProperty() targetValue: number = 0;
  @JsonProperty() targetTokenid: string | null = null;
  @JsonProperty() beneficiaryPubKey: Uint8Array | null = null;
  @JsonProperty() beneficiaryAddress: string | null = null;
  @JsonProperty() validToTime: number | null = null;
  @JsonProperty() validFromTime: number | null = null;
  @JsonProperty()
  private side: Side | null = null;
  @JsonProperty() orderBaseToken: string | null = null;
  @JsonProperty() tokenDecimals: number = 0;
  @JsonProperty() price: number | null = null;
  @JsonProperty() cancelPending: boolean = false;
  @JsonProperty() blockHashHex: string | null = null;

  constructor(
    initialBlockHash?: Sha256Hash,
    issuingMatcherBlockHash?: Sha256Hash,
    offerValue?: number,
    offerTokenid?: string,
    confirmed?: boolean,
    spent?: boolean,
    spenderBlockHash?: Sha256Hash,
    targetValue?: number,
    targetTokenid?: string,
    beneficiaryPubKey?: Uint8Array,
    validToTime?: number,
    validFromTime?: number,
    side?: string,
    beneficiaryAddress?: string,
    orderBaseToken?: string,
    price?: number,
    tokenDecimals?: number
  ) {
    super();
    if (initialBlockHash) this.setBlockHash(initialBlockHash);
    if (issuingMatcherBlockHash)
      this.issuingMatcherBlockHash = issuingMatcherBlockHash;
    if (offerValue !== undefined) this.offerValue = offerValue;
    if (offerTokenid) this.offerTokenid = offerTokenid;
    if (confirmed !== undefined) this.setConfirmed(confirmed);
    if (spent !== undefined) this.setSpent(spent);
    if (spenderBlockHash) this.setSpenderBlockHash(spenderBlockHash);
    if (targetValue !== undefined) this.targetValue = targetValue;
    if (targetTokenid) this.targetTokenid = targetTokenid;
    if (beneficiaryPubKey) this.beneficiaryPubKey = beneficiaryPubKey;
    if (validToTime !== undefined) this.validToTime = validToTime;
    if (validFromTime !== undefined) this.validFromTime = validFromTime;
    if (side) {
      if (side === 'BUY') this.side = Side.BUY;
      else if (side === 'SELL') this.side = Side.SELL;
    }
    if (beneficiaryAddress) this.beneficiaryAddress = beneficiaryAddress;
    if (orderBaseToken) this.orderBaseToken = orderBaseToken;
    if (price !== undefined) this.price = price;
    if (tokenDecimals !== undefined) this.tokenDecimals = tokenDecimals;
  }

  public static cloneOrderRecord(old: OrderRecord): OrderRecord {
    return new OrderRecord(
      old.getBlockHash() || undefined,
      old.issuingMatcherBlockHash || undefined,
      old.offerValue,
      old.offerTokenid || undefined,
      old.isConfirmed(),
      old.isSpent(),
      old.getSpenderBlockHash() || undefined,
      old.targetValue,
      old.targetTokenid || undefined,
      old.beneficiaryPubKey || undefined,
      old.validToTime || undefined,
      old.validFromTime || undefined,
      old.side ? old.side.toString() : undefined,
      old.beneficiaryAddress || undefined,
      old.getOrderBaseToken() || undefined,
      old.getPrice() || undefined,
      old.getTokenDecimals()
    );
  }

  public getPrice(): number | null {
    return this.price;
  }

  public setPrice(price: number | null): void {
    this.price = price;
  }

  public isTimeouted(blockTime: number): boolean {
    return this.validToTime !== null && blockTime > this.validToTime;
  }

  public isValidYet(blockTime: number): boolean {
    return this.validFromTime !== null && blockTime >= this.validFromTime;
  }

  public getIssuingMatcherBlockHash(): Sha256Hash | null {
    return this.issuingMatcherBlockHash;
  }

  public setIssuingMatcherBlockHash(
    issuingMatcherBlockHash: Sha256Hash | null
  ): void {
    this.issuingMatcherBlockHash = issuingMatcherBlockHash;
  }

  public getOfferValue(): number {
    return this.offerValue;
  }

  public setOfferValue(offerValue: number): void {
    this.offerValue = offerValue;
  }

  public getOfferTokenid(): string | null {
    return this.offerTokenid;
  }

  public setOfferTokenid(offerTokenid: string | null): void {
    this.offerTokenid = offerTokenid;
  }

  public getTargetValue(): number {
    return this.targetValue;
  }

  public setTargetValue(targetValue: number): void {
    this.targetValue = targetValue;
  }

  public getTargetTokenid(): string | null {
    return this.targetTokenid;
  }

  public setTargetTokenid(targetTokenid: string | null): void {
    this.targetTokenid = targetTokenid;
  }

  public getBeneficiaryPubKey(): Uint8Array | null {
    return this.beneficiaryPubKey;
  }

  public getValidToTime(): number | null {
    return this.validToTime;
  }

  public setValidToTime(validToTime: number | null): void {
    this.validToTime = validToTime;
  }

  public getValidFromTime(): number | null {
    return this.validFromTime;
  }

  public setValidFromTime(validFromTime: number | null): void {
    this.validFromTime = validFromTime;
  }

  public getSide(): Side | null {
    return this.side;
  }

  public setSide(side: Side | null): void {
    this.side = side;
  }

  public getBeneficiaryAddress(): string | null {
    return this.beneficiaryAddress;
  }

  public setBeneficiaryAddress(beneficiaryAddress: string | null): void {
    this.beneficiaryAddress = beneficiaryAddress;
  }

  public isCancelPending(): boolean {
    return this.cancelPending;
  }

  public setCancelPending(cancelPending: boolean): void {
    this.cancelPending = cancelPending;
  }

  public getOrderBaseToken(): string | null {
    return this.orderBaseToken;
  }

  public setOrderBaseToken(orderBaseToken: string | null): void {
    this.orderBaseToken = orderBaseToken;
  }

  public getTokenDecimals(): number {
    return this.tokenDecimals;
  }

  public toString(): string {
    return (
      `OrderRecord [ price=${this.price} , side=${this.side} , offerValue=${this.offerValue}` +
      `, offerTokenid=${this.offerTokenid}, targetValue=${this.targetValue}, targetTokenid=${this.targetTokenid}` +
      `, beneficiaryAddress=${this.beneficiaryAddress}, validToTime=${this.validToTime}, validFromTime=${this.validFromTime}` +
      `, issuingMatcherBlockHash=${
        this.issuingMatcherBlockHash
      } ${super.toString()}]`
    );
  }
}
