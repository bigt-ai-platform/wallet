import { SpentBlock } from "./SpentBlock";
import { Sha256Hash } from "./Sha256Hash";
import { TokenType } from "./TokenType";
import { TokenKeyValues } from "./TokenKeyValues";
import { NetworkParameters } from "../params/NetworkParameters";
import { UtilGeneseBlock } from "./UtilGeneseBlock";
 
import { KeyValue } from "./KeyValue";
 
import { JsonProperty } from "jackson-js";
import { DataInputStream } from '../utils/DataInputStream';
import { UnsafeByteArrayOutputStream } from './UnsafeByteArrayOutputStream';
import { Utils } from '../utils/Utils';
import { bigIntToBytes, bytesToBigInt } from './BigIntegerConverter';


export class Token extends SpentBlock {
  public static readonly TOKEN_MAX_NAME_LENGTH = 100;
  public static readonly TOKEN_MAX_DESC_LENGTH = 5000;
  public static readonly TOKEN_MAX_URL_LENGTH = 100;
  public static readonly TOKEN_MAX_ID_LENGTH = 100;
  public static readonly TOKEN_MAX_LANGUAGE_LENGTH = 2;
  public static readonly TOKEN_MAX_CLASSIFICATION_LENGTH = 100;

  @JsonProperty()
  private tokenid!: string | null;
  @JsonProperty()
  private tokenindex: number = 0;
  @JsonProperty()
  private tokenname: string | null = null;
  @JsonProperty()
  private description: string | null = null;
  @JsonProperty()
  private domainName: string = "";
  @JsonProperty()
  private domainNameBlockHash: string | null = null;
  @JsonProperty()
  private signnumber: number = 0;
  @JsonProperty()
  private tokentype: number = 0;
  @JsonProperty()
  private tokenstop: boolean = false;
  @JsonProperty()
  private prevblockhash: Sha256Hash | null = null;
  @JsonProperty()
  private amount: bigint | null = null;
  @JsonProperty()
  private decimals: number = 0;
  @JsonProperty()
  private classification: string | null = null;
  @JsonProperty()
  private language: string | null = null;
  @JsonProperty()
  private revoked: boolean = false;
  @JsonProperty()
  private tokenKeyValues: TokenKeyValues | null = null;

  public addKeyvalue(kv: KeyValue): void {
    this.tokenKeyValues ??= new TokenKeyValues();
    this.tokenKeyValues.addKeyvalue(kv);
  }

  public getTokenid(): string | null {
    return this.tokenid;
  }

  public setTokenid(tokenid: string | null): void {
    this.tokenid = tokenid;
  }

  public getTokenindex(): number {
    return this.tokenindex;
  }

  public setTokenindex(tokenindex: number): void {
    this.tokenindex = tokenindex;
  }

  public getAmount(): bigint | null {
    return this.amount;
  }

  public setAmount(amount: bigint | null): void {
    this.amount = amount;
  }

  public getTokenname(): string | null {
    return this.tokenname;
  }

  public setTokenname(tokenname: string | null): void {
    this.tokenname = tokenname;
  }

  public getDescription(): string | null {
    return this.description;
  }

  public setDescription(description: string | null): void {
    this.description = description;
  }

  public getDomainName(): string {
    // Remove null check since domainName is always initialized to ""
    return this.domainName;
  }

  public setDomainName(domainName: string): void {
    this.domainName = domainName;
  }

  public getDomainNameBlockHash(): string | null {
    return this.domainNameBlockHash;
  }

  public setDomainNameBlockHash(domainNameBlockHash: string | null): void {
    this.domainNameBlockHash = domainNameBlockHash;
  }

  public getRevoked(): boolean {
    return this.revoked;
  }

  public setRevoked(revoked: boolean): void {
    this.revoked = revoked;
  }

  public getSignnumber(): number {
    return this.signnumber;
  }

  public setSignnumber(signnumber: number): void {
    this.signnumber = signnumber;
  }

  public getTokentype(): number {
    return this.tokentype;
  }

  public setTokentype(tokentype: number): void {
    this.tokentype = tokentype;
  }

  public isTokenstop(): boolean {
    return this.tokenstop;
  }

  public setTokenstop(tokenstop: boolean): void {
    this.tokenstop = tokenstop;
  }

  public getPrevblockhash(): Sha256Hash | null {
    return this.prevblockhash;
  }

  public setPrevblockhash(prevblockhash: any): void {
    if (prevblockhash instanceof Sha256Hash) {
      this.prevblockhash = prevblockhash;
      return;
    }
    let hex = "";
    if (typeof prevblockhash === "string") {
      hex = prevblockhash.trim();
    } else if (prevblockhash != null && typeof prevblockhash === "object") {
      // jackson-js may parse Sha256Hash as an object ({ hash: "..." }).
      hex = String((prevblockhash as any).hash || (prevblockhash as any).hex || "").trim();
    }
    this.prevblockhash = hex ? Sha256Hash.wrap(new Uint8Array(Utils.HEX.decode(hex))) : null;
  }

  public getTokenKeyValues(): TokenKeyValues | null {
    return this.tokenKeyValues;
  }

  public setTokenKeyValues(tokenKeyValues: TokenKeyValues | null): void {
    this.tokenKeyValues = tokenKeyValues;
  }

  public getClassification(): string | null {
    return this.classification;
  }

  public setClassification(classification: string | null): void {
    this.classification = classification;
  }

  public getLanguage(): string | null {
    return this.language;
  }

  public setLanguage(language: string | null): void {
    this.language = language;
  }

  public getDecimals(): number {
    return this.decimals;
  }

  public setDecimals(decimals: number): void {
    this.decimals = decimals;
  }

  public getTokenFullname(): string {
    if (
      this.domainName === null ||
      this.domainName === "null" ||
      this.domainName.length === 0
    ) {
      return this.tokenname || "";
    } else {
      if (this.getTokentype() === TokenType.domainname) {
        return this.tokenname || "";
      } else {
        return `${this.tokenname}@${this.domainName}`;
      }
    }
  }

  public getTokenFullDomainname(): string {
    if (
      this.domainName === null ||
      this.domainName === "null" ||
      this.domainName.length === 0
    ) {
      return this.tokenname || "";
    } else {
      if (this.getTokentype() === TokenType.domainname) {
        return this.tokenname || "";
      } else {
        return `${this.tokenname}.${this.domainName}`;
      }
    }
  }

  public getTokennameDisplay(): string {
    return this.getTokenFullname();
  }

  public isTokenDomainname(): boolean {
    return this.tokentype === TokenType.domainname;
  }

  public static buildSimpleTokenInfo(
    confirmed: boolean,
    prevblockhash: Sha256Hash | null,
    tokenid: string,
    tokenname: string,
    description: string,
    signnumber: number,
    tokenindex: number,
    amount: bigint,
    tokenstop: boolean,
    tokenKeyValues: TokenKeyValues | null,
    revoked: boolean,
    language: string | null,
    classification: string | null,
    tokentype: number,
    decimals: number,
    domainName: string | null,
    domainNameBlockHash: string | null
  ): Token {
    const tokens = new Token();
    tokens.setTokenid(tokenid);
    tokens.setTokenname(tokenname);
    tokens.setDescription(description);
    tokens.tokenstop = tokenstop;
    tokens.tokentype = tokentype;
    tokens.signnumber = signnumber;
    tokens.amount = amount;
    tokens.tokenindex = tokenindex;
    tokens.setConfirmed(confirmed);
    tokens.prevblockhash = prevblockhash;
    tokens.tokenKeyValues = tokenKeyValues;
    tokens.revoked = revoked;
    tokens.language = language;
    tokens.classification = classification;
    tokens.decimals = decimals;
    tokens.domainName = domainName ?? "";
    tokens.domainNameBlockHash = domainNameBlockHash;
    return tokens;
  }
 
  public static buildSimpleTokenInfo2(
    confirmed: boolean,
    prevblockhash: Sha256Hash | null,
    tokenid: string,
    tokenname: string,
    description: string,
    signnumber: number,
    tokenindex: number,
    amount: bigint,
    tokenstop: boolean,
    decimals: number,
    predecessingDomainBlockHash: string | null
  ): Token {
    return Token.buildSimpleTokenInfo(
      confirmed,
      prevblockhash,
      tokenid,
      tokenname,
      description,
      signnumber,
      tokenindex,
      amount,
      tokenstop,
      null,
      false,
      null,
      null,
      TokenType.token,
      decimals,
      null,
      predecessingDomainBlockHash
    );
  }

  public static genesisToken(params: NetworkParameters): Token {
    const genesisToken = Token.buildSimpleTokenInfo2(
      true,
      null,
      NetworkParameters.BIGTANGLE_TOKENID_STRING,
      NetworkParameters.BIGTANGLE_TOKENNAME,
      "BigTangle Currency",
      1,
      0,
      NetworkParameters.BigtangleCoinTotal,
      true,
      NetworkParameters.BIGTANGLE_DECIMAL,
      ""
    );
    genesisToken.setBlockHash(UtilGeneseBlock.createGenesis(params).getHash());
    genesisToken.setTokentype(TokenType.currency);
    return genesisToken;
  }

  public static buildDomainnameTokenInfo(
    confirmed: boolean,
    prevblockhash: Sha256Hash | null,
    tokenid: string,
    tokenname: string,
    description: string,
    signnumber: number,
    tokenindex: number,
    tokenstop: boolean,
    domainname: string,
    predecessingDomainBlockHash: string | null
  ): Token {
    return Token.buildSimpleTokenInfo(
      confirmed,
      prevblockhash,
      tokenid,
      tokenname,
      description,
      signnumber,
      tokenindex,
      1n,
      tokenstop,
      null,
      false,
      null,
      null,
      TokenType.domainname,
      0,
      domainname,
      predecessingDomainBlockHash
    );
  }

  constructor(tokenid?: string, tokenname?: string) {
    super();
    if (tokenid) this.tokenid = tokenid;
    if (tokenname) this.tokenname = tokenname;
  }

  public static buildSubtangleTokenInfo(
    confirmed: boolean,
    prevblockhash: Sha256Hash | null,
    tokenid: string,
    tokenname: string,
    description: string,
    domainname: string
  ): Token {
    const tokens = new Token();
    tokens.setTokenid(tokenid);
    tokens.setTokenname(tokenname);
    tokens.setDescription(description);
    tokens.setDomainName(domainname);
    tokens.tokenstop = true;
    tokens.tokentype = TokenType.subtangle;
    tokens.signnumber = 1;
    tokens.amount = 0n;
    tokens.tokenindex = 1;
    tokens.setConfirmed(confirmed);
    tokens.prevblockhash = prevblockhash;

    return tokens;
  }

  public toByteArray(): Uint8Array {
    const baos = new UnsafeByteArrayOutputStream();
    const superBytes = new Uint8Array(super.toByteArray());
    baos.writeBytes(superBytes, 0, superBytes.length);
    Utils.writeNBytesString(baos, this.tokenid);
    baos.writeLong(Number(this.tokenindex));
    Utils.writeNBytesString(baos, this.tokenname);
    Utils.writeNBytesString(baos, this.description);
    Utils.writeNBytesString(baos, this.domainName);
    Utils.writeNBytesString(baos, this.domainNameBlockHash);
    baos.writeInt(this.signnumber);
    baos.writeInt(this.tokentype);
    baos.writeBoolean(this.tokenstop);
    const prevBytes = this.prevblockhash === null || this.prevblockhash === undefined
      ? null
      : (this.prevblockhash instanceof Sha256Hash
          ? this.prevblockhash.getBytes()
          : Utils.HEX.decode(String(this.prevblockhash)));
    Utils.writeNBytes(baos, prevBytes ? new Uint8Array(prevBytes) : null);
    const amountBytes = bigIntToBytes(this.amount ?? 0n);
    Utils.writeNBytes(baos, amountBytes);
    baos.writeInt(this.decimals);
    Utils.writeNBytesString(baos, this.classification);
    Utils.writeNBytesString(baos, this.language);
    baos.writeBoolean(this.revoked === true);
    if (this.tokenKeyValues != null) {
      const kvBytes = this.tokenKeyValues.toByteArray();
      baos.writeInt(kvBytes.length);
      baos.writeBytes(new Uint8Array(kvBytes), 0, kvBytes.length);
    } else {
      baos.writeInt(0);
    }
    baos.close();
    return baos.toByteArray();
  }

  public parseDIS(dis: DataInputStream): Token {
    super.parseDIS(dis);
    this.tokenid = Utils.readNBytesString(dis);
    this.tokenindex = dis.readLong();
    this.tokenname = Utils.readNBytesString(dis);
    this.description = Utils.readNBytesString(dis);
    this.domainName = Utils.readNBytesString(dis) ?? "";
    this.domainNameBlockHash = Utils.readNBytesString(dis);
    this.signnumber = dis.readInt();
    this.tokentype = dis.readInt();
    this.tokenstop = dis.readBoolean();
    const prevBytes = Utils.readNBytes(dis);
    if (prevBytes) {
      this.prevblockhash = Sha256Hash.wrap(prevBytes);
    }
    const amountBytes = Utils.readNBytes(dis);
    if (amountBytes) {
      this.amount = bytesToBigInt(amountBytes);
    }
    this.decimals = dis.readInt();
    this.classification = Utils.readNBytesString(dis);
    this.language = Utils.readNBytesString(dis);
    this.revoked = dis.readBoolean();
    const kvLen = dis.readInt();
    if (kvLen > 0) {
      const kvBytes = dis.readBytes(kvLen);
      this.tokenKeyValues = TokenKeyValues.parse(kvBytes);
    }
    return this;
  }

  public parse(buf: Uint8Array): Token {
    const dis = new DataInputStream(buf);
    try {
      this.parseDIS(dis);
      dis.close();
    } catch (e: any) {
      throw new Error(e);
    }
    return this;
  }

  public toString(): string {
    return (
      `Token \n [tokenid=${this.tokenid}, tokenindex=${this.tokenindex}, tokenname=${this.tokenname}` +
      ` \n , description=${this.description}, domainName=${this.domainName}, domainNameBlockHash=${this.domainNameBlockHash}` +
      ` \n , signnumber=${this.signnumber}, tokentype=${this.tokentype}, tokenstop=${this.tokenstop}` +
      `\n , prevblockhash=${this.prevblockhash}, amount=${this.amount}, decimals=${this.decimals}` +
      ` \n , classification=${this.classification}, language=${this.language}, revoked=${this.revoked}]`
    );
  }
}
