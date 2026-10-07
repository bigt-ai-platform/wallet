import { describe, it, expect, vi } from "vitest";
import { PQKey } from "bigtangle-ts";
import { Utils } from "bigtangle-ts";
import { didFromPQKey } from "did/pq";
import { verifyRecordSig } from "record-sig";
import { anchorFromEnv, swapEventRecord, signSwapRecord, l1Anchor } from "../src/anchor.js";
import type { P2pSwapEvent } from "../src/types.js";

const seed = new Uint8Array(32).fill(7);
const pqKey = PQKey.fromMLDSA(seed);
const did = didFromPQKey(pqKey);
const seedHex = Utils.HEX.encode(seed);

function event(overrides: Partial<P2pSwapEvent> = {}): P2pSwapEvent {
  return {
    swapId: "swap-0123456789abcdef",
    seq: 5,
    status: "ESCROW_RELEASED",
    eventType: "release",
    orderId: "ord-0123456789abcdef",
    sellerDid: "did:key:zSELLER",
    buyerDid: "did:key:zBUYER",
    giveChain: "L0",
    giveToken: "USDT",
    giveAmount: "100",
    wantAmount: "101",
    wantRail: "paypal",
    wantCurrency: "USD",
    escrowAddress: "ESC",
    escrowTxHash: "f".repeat(64),
    releaseTxHash: "b".repeat(64),
    paymentRail: "paypal",
    paymentRef: "PAY-1",
    payoutRef: "PO-1",
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("L1-SOCIAL chain anchor (docs/p2p.md step 8)", () => {
  it("resolves the anchor identity from URL + PQ seed, matching the declared did", () => {
    expect(anchorFromEnv({} as never)).toBeNull();
    expect(anchorFromEnv({ SETTLEMENT_L1_URL: "http://l1" } as never)).toBeNull();
    expect(anchorFromEnv({ SETTLEMENT_ENGINE_KEY: seedHex } as never)).toBeNull();
    expect(anchorFromEnv({ SETTLEMENT_L1_URL: "http://l1", SETTLEMENT_ENGINE_KEY: "not-hex" } as never)).toBeNull();
    expect(
      anchorFromEnv({ SETTLEMENT_L1_URL: "http://l1", SETTLEMENT_ENGINE_KEY: seedHex, SETTLEMENT_ENGINE_DID: "did:key:zOTHER" } as never),
    ).toBeNull();

    const ok = anchorFromEnv({
      SETTLEMENT_L1_SOCIAL_URL: "http://l1/",
      SETTLEMENT_ENGINE_KEY: seedHex,
      SETTLEMENT_ENGINE_DID: did,
    } as never)!;
    expect(ok.l1Url).toBe("http://l1");
    expect(ok.did).toBe(did);
    expect(ok.pqKey.getPrefixedPublicKeyBytes()).toEqual(pqKey.getPrefixedPublicKeyBytes());
  });

  it("maps an event to a record with no PII or store-only fields", () => {
    const rec = swapEventRecord(
      event({ buyerEmail: "buyer@x", receiveAddress: "1Recv", paypalAccount: "s@x.com", invoiceId: "INV-1" }),
      did,
    );
    expect(rec).toMatchObject({
      type: "social.p2p-swap",
      from: did,
      to: "swap-0123456789abcdef",
      status: "ESCROW_RELEASED",
      swapSeq: 5,
      giveAmount: "100",
      wantAmount: "101",
      payoutRef: "PO-1",
      ts: 1_700_000_000_000,
    });
    for (const pii of ["buyerEmail", "receiveAddress", "paypalAccount", "invoiceId", "invoiceUrl", "payoutStatus", "dispute"]) {
      expect((rec as Record<string, unknown>)[pii]).toBeUndefined();
    }
  });

  it("signs records the wallet's record-sig verifier accepts (mldsa)", () => {
    const signed = signSwapRecord(swapEventRecord(event(), did), pqKey);
    expect(signed.sigScheme).toBe("mldsa");
    expect(verifyRecordSig(signed)).toBe(true);
    expect(verifyRecordSig({ ...signed, status: "COMPLETED" })).toBe(false);
  });

  it("submits the signed record to L1-SOCIAL and fails closed", async () => {
    const submit = vi.fn(async () => "a".repeat(64));
    const hook = l1Anchor({ l1Url: "http://l1", pqKey, did }, submit);
    const res = await hook(event());
    expect(res.txid).toBe("a".repeat(64));
    expect(submit).toHaveBeenCalledOnce();
    const [url, key, record] = submit.mock.calls[0];
    expect(url).toBe("http://l1");
    expect(key).toBe(pqKey);
    expect(verifyRecordSig(record as never)).toBe(true);

    const failing = l1Anchor({ l1Url: "http://l1", pqKey, did }, async () => {
      throw new Error("l1 down");
    });
    await expect(failing(event())).rejects.toThrow(/l1 down/);
  });
});
