import { describe, it, expect } from "vitest";
import { MAX_GRANT_TTL_MS, grantAllows, validatePairingGrant, type PairingGrant } from "../src/pairing.js";

const now = 1_700_000_000_000;

const grant: PairingGrant = {
  did: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  endpoint: "http://127.0.0.1:8787",
  deviceId: "emulator-5554",
  token: "a".repeat(64),
  swapId: "swap-0123456789abcdef",
  issuedAt: now,
  expiresAt: now + 60 * 60 * 1000,
  pairingId: "pairing-0001",
};

describe("device pairing grant (docs/p2p.md §12)", () => {
  it("accepts a well-formed grant", () => {
    expect(validatePairingGrant(grant, now)).toEqual({ ok: true });
    expect(validatePairingGrant({ ...grant, swapId: undefined }, now)).toEqual({ ok: true });
  });

  it("fails closed on malformed fields", () => {
    expect(validatePairingGrant({ ...grant, did: "alice" }, now).error).toMatch(/did/);
    expect(validatePairingGrant({ ...grant, endpoint: "file:///etc/passwd" }, now).error).toMatch(/endpoint/);
    expect(validatePairingGrant({ ...grant, deviceId: "" }, now).error).toMatch(/deviceId/);
    expect(validatePairingGrant({ ...grant, swapId: "swap-XYZ" }, now).error).toMatch(/swapId/);
    expect(validatePairingGrant({ ...grant, pairingId: "short" }, now).error).toMatch(/pairingId/);
    expect(validatePairingGrant({ ...grant, token: "" }, now).error).toMatch(/token/);
    expect(validatePairingGrant({ ...grant, issuedAt: 0 }, now).error).toMatch(/issuedAt/);
    expect(validatePairingGrant({ ...grant, expiresAt: grant.issuedAt }, now).error).toMatch(/expiresAt/);
  });

  it("bounds the lifetime and rejects stale grants", () => {
    expect(validatePairingGrant({ ...grant, expiresAt: now + MAX_GRANT_TTL_MS + 1 }, now).error).toMatch(/ttl/);
    expect(validatePairingGrant(grant, grant.expiresAt + 1).error).toMatch(/expired/);
  });

  it("scopes a grant to its swap or to its owner", () => {
    expect(grantAllows(grant, "swap-0123456789abcdef", now)).toBe(true);
    expect(grantAllows(grant, "swap-ffffffffffffffff", now)).toBe(false);
    const open = { ...grant, swapId: undefined };
    expect(grantAllows(open, "swap-ffffffffffffffff", now)).toBe(true);
    expect(grantAllows(grant, "swap-0123456789abcdef", grant.expiresAt)).toBe(false);
  });
});
