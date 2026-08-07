import { describe, test, expect } from "vitest";
import { Token } from "../../src/net/bigtangle/core/Token";
import { TokenType } from "../../src/net/bigtangle/core/TokenType";
import { TokenKeyValues } from "../../src/net/bigtangle/core/TokenKeyValues";
import { KeyValue } from "../../src/net/bigtangle/core/KeyValue";
import { Sha256Hash } from "../../src/net/bigtangle/core/Sha256Hash";
import { NetworkParameters } from "../../src/net/bigtangle/params/NetworkParameters";
import { TestParams } from "../../src/net/bigtangle/params/TestParams";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("TokenSerializationTest", () => {
  const params: NetworkParameters = TestParams.get();

  test("testRoundTripFull", () => {
    const original = new Token();
    original.setTokenid("test_token_id_123");
    original.setTokenindex(42);
    original.setTokenname("TestCoin");
    original.setDescription("A test token for unit testing");
    original.setDomainName("testdomain");
    original.setDomainNameBlockHash("domainblockhash123");
    original.setSignnumber(2);
    original.setTokentype(TokenType.token);
    original.setTokenstop(false);
    original.setPrevblockhash(Sha256Hash.of(utf8("prev")));
    original.setAmount(1000000n);
    original.setDecimals(8);
    original.setClassification("currency");
    original.setLanguage("en");
    original.setRevoked(false);
    original.setBlockHash(Sha256Hash.of(utf8("block")));
    original.setConfirmed(true);
    original.setSpent(false);
    original.setTime(1234567890);

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe(original.getTokenid());
    expect(reparsed.getTokenindex()).toBe(original.getTokenindex());
    expect(reparsed.getTokenname()).toBe(original.getTokenname());
    expect(reparsed.getDescription()).toBe(original.getDescription());
    expect(reparsed.getDomainName()).toBe(original.getDomainName());
    expect(reparsed.getDomainNameBlockHash()).toBe(original.getDomainNameBlockHash());
    expect(reparsed.getSignnumber()).toBe(original.getSignnumber());
    expect(reparsed.getTokentype()).toBe(original.getTokentype());
    expect(reparsed.isTokenstop()).toBe(original.isTokenstop());
    expect(reparsed.getPrevblockhash()!.toString()).toBe(original.getPrevblockhash()!.toString());
    expect(reparsed.getAmount()).toBe(original.getAmount());
    expect(reparsed.getDecimals()).toBe(original.getDecimals());
    expect(reparsed.getClassification()).toBe(original.getClassification());
    expect(reparsed.getLanguage()).toBe(original.getLanguage());
    expect(reparsed.getRevoked()).toBe(original.getRevoked());
    expect(reparsed.getBlockHash()!.toString()).toBe(original.getBlockHash()!.toString());
    expect(reparsed.isConfirmed()).toBe(original.isConfirmed());
    expect(reparsed.isSpent()).toBe(original.isSpent());
    expect(reparsed.getTime()).toBe(original.getTime());
  });

  test("testRoundTripWithTokenKeyValues", () => {
    const original = new Token();
    original.setTokenid("kv_token");
    original.setTokenname("KVToken");
    original.setAmount(500n);
    original.setTokentype(TokenType.token);
    original.setSignnumber(1);
    original.setBlockHash(Sha256Hash.of(utf8("kvblock")));
    original.setConfirmed(true);

    const tkv = new TokenKeyValues();
    const kv1 = new KeyValue();
    kv1.setKey("url");
    kv1.setValue("https://example.com");
    tkv.addKeyvalue(kv1);
    const kv2 = new KeyValue();
    kv2.setKey("icon");
    kv2.setValue("data:image/png;base64,abc123");
    tkv.addKeyvalue(kv2);
    original.setTokenKeyValues(tkv);

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe(original.getTokenid());
    expect(reparsed.getTokenname()).toBe(original.getTokenname());
    expect(reparsed.getTokenKeyValues()).not.toBeNull();
    expect(reparsed.getTokenKeyValues()!.getKeyvalues()!.length).toBe(2);
    expect(reparsed.getTokenKeyValues()!.getKeyvalues()![0].getKey()).toBe("url");
    expect(reparsed.getTokenKeyValues()!.getKeyvalues()![0].getValue()).toBe("https://example.com");
    expect(reparsed.getTokenKeyValues()!.getKeyvalues()![1].getKey()).toBe("icon");
  });

  test("testRoundTripGenesisToken", () => {
    const original = Token.genesisToken(params);
    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe(original.getTokenid());
    expect(reparsed.getTokenname()).toBe(original.getTokenname());
    expect(reparsed.getAmount()).toBe(original.getAmount());
    expect(reparsed.getDecimals()).toBe(original.getDecimals());
    expect(reparsed.getTokentype()).toBe(original.getTokentype());
    expect(reparsed.getSignnumber()).toBe(original.getSignnumber());
    expect(reparsed.isTokenstop()).toBe(original.isTokenstop());
    expect(reparsed.getBlockHash()!.toString()).toBe(original.getBlockHash()!.toString());
    expect(reparsed.isConfirmed()).toBe(true);
  });

  test("testRoundTripDomainnameToken", () => {
    const original = Token.buildDomainnameTokenInfo(
      true,
      Sha256Hash.of(utf8("domainprev")),
      "domain_token_1",
      "example.bigtangle",
      "Example Domain",
      1,
      0,
      true,
      "example.bigtangle",
      "prevdomainhash"
    );

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe(original.getTokenid());
    expect(reparsed.getTokenname()).toBe(original.getTokenname());
    expect(reparsed.getDomainName()).toBe(original.getDomainName());
    expect(reparsed.getTokentype()).toBe(original.getTokentype());
    expect(reparsed.isTokenDomainname()).toBe(true);
    expect(reparsed.isTokenstop()).toBe(true);
  });

  test("testRoundTripSubtangleToken", () => {
    const original = Token.buildSubtangleTokenInfo(
      true,
      Sha256Hash.of(utf8("subprev")),
      "subtangle_1",
      "SubTangle",
      "A subtangle chain",
      "subtangle.bigtangle"
    );

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe(original.getTokenid());
    expect(reparsed.getTokenname()).toBe(original.getTokenname());
    expect(reparsed.getDomainName()).toBe(original.getDomainName());
    expect(reparsed.getTokentype()).toBe(original.getTokentype());
    expect(reparsed.isTokenstop()).toBe(true);
    expect(reparsed.getAmount()).toBe(0n);
  });

  test("testRoundTripMinimal", () => {
    const original = new Token();
    original.setTokenid("minimal");
    original.setTokenname("Min");
    original.setAmount(1n);
    original.setBlockHash(Sha256Hash.ZERO_HASH);

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe("minimal");
    expect(reparsed.getTokenname()).toBe("Min");
    expect(reparsed.getAmount()).toBe(1n);
  });

  test("testDeterministic", () => {
    const a = buildSample();
    const b = buildSample();
    const ba = a.toByteArray();
    const bb = b.toByteArray();
    expect(ba.length).toBe(bb.length);
    for (let i = 0; i < ba.length; i++) {
      expect(ba[i]).toBe(bb[i]);
    }
  });

  test("testNullFields", () => {
    const original = new Token();
    original.setTokenid("null_test");
    original.setTokenname("NullTest");
    original.setAmount(10n);
    original.setBlockHash(Sha256Hash.of(utf8("b")));

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getTokenid()).toBe("null_test");
    expect(reparsed.getTokenname()).toBe("NullTest");
    expect(reparsed.getAmount()).toBe(10n);
    expect(reparsed.getTokenindex()).toBe(0);
    expect(reparsed.getDecimals()).toBe(0);
    expect(reparsed.getPrevblockhash()).toBeNull();
  });

  test("testRevokedTrue", () => {
    const original = new Token();
    original.setTokenid("revoked");
    original.setTokenname("RevokedToken");
    original.setAmount(100n);
    original.setRevoked(true);
    original.setBlockHash(Sha256Hash.of(utf8("r")));

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getRevoked()).toBe(true);
  });

  test("testBigIntegerAmount", () => {
    const original = new Token();
    original.setTokenid("big_amount");
    original.setTokenname("BigAmount");
    original.setAmount(999999999999999999999999999999999999n);
    original.setBlockHash(Sha256Hash.of(utf8("big")));

    const bytes = original.toByteArray();
    const reparsed = new Token().parse(bytes);

    expect(reparsed.getAmount()).toBe(original.getAmount());
  });

  function buildSample(): Token {
    const t = new Token();
    t.setTokenid("sample_token");
    t.setTokenindex(1);
    t.setTokenname("Sample");
    t.setDescription("Sample description");
    t.setDomainName("sample.bigtangle");
    t.setDomainNameBlockHash("sampleblockhash");
    t.setSignnumber(1);
    t.setTokentype(TokenType.token);
    t.setTokenstop(false);
    t.setPrevblockhash(Sha256Hash.of(utf8("prevhash")));
    t.setAmount(10000n);
    t.setDecimals(4);
    t.setClassification("test");
    t.setLanguage("en");
    t.setRevoked(false);
    t.setBlockHash(Sha256Hash.of(utf8("blockhash")));
    t.setConfirmed(true);
    t.setSpent(false);
    t.setTime(1000000);
    return t;
  }
});
