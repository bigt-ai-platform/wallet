import { describe, it, expect } from "vitest";
import { PQKey, Utils } from "bigtangle-ts";
import {
  engineKeyring,
  engineSigner,
  engineSignerFor,
} from "../src/escrowSpend.js";
import { loadSecretFiles } from "../src/secrets.js";

const pub = (k: PQKey) => Utils.HEX.encode(k.getPrefixedPublicKeyBytes());

/** env: the first key is current, the rest are retained (rotated) keys. */
function envWith(keys: PQKey[]): NodeJS.ProcessEnv {
  const [primary, ...rest] = keys;
  return {
    SETTLEMENT_ENGINE_KEY: primary.getPrivateKeySeedAsHex() ?? "",
    SETTLEMENT_ENGINE_PUBKEY: pub(primary),
    SETTLEMENT_ENGINE_KEYS: rest
      .map((k) => k.getPrivateKeySeedAsHex() ?? "")
      .join(","),
  };
}

describe("engine keyring (rotation)", () => {
  it("holds the current key and every retained key, keyed by pubkey", () => {
    const a = PQKey.createNew();
    const b = PQKey.createNew();
    const ring = engineKeyring(envWith([a, b]));
    expect(ring.has(pub(a))).toBe(true);
    expect(ring.has(pub(b))).toBe(true);
  });

  it("selects the key pinned on the swap, including a retired one", () => {
    const current = PQKey.createNew();
    const retired = PQKey.createNew();
    const env = envWith([current, retired]);
    expect(pub(engineSignerFor(env, pub(retired))!)).toBe(pub(retired));
    expect(pub(engineSignerFor(env, pub(current))!)).toBe(pub(current));
  });

  it("fails closed on an unknown pinned key and defaults to current when unpinned", () => {
    const a = PQKey.createNew();
    const b = PQKey.createNew();
    const env = envWith([a, b]);
    expect(engineSignerFor(env, "05" + "ab".repeat(2600))).toBeNull();
    expect(pub(engineSignerFor(env, undefined)!)).toBe(pub(a));
  });

  it("a dedicated SETTLEMENT_ESCROW_KEY co-signs instead of the anchor key", () => {
    const anchorKey = PQKey.createNew();
    const escrowKey = PQKey.createNew();
    const env = {
      SETTLEMENT_ENGINE_KEY: anchorKey.getPrivateKeySeedAsHex() ?? "",
      SETTLEMENT_ESCROW_KEY: escrowKey.getPrivateKeySeedAsHex() ?? "",
      SETTLEMENT_ENGINE_PUBKEY: pub(escrowKey),
    };
    expect(pub(engineSigner(env))).toBe(pub(escrowKey));
    expect(engineKeyring(env).has(pub(anchorKey))).toBe(false);
  });
});

describe("loadSecretFiles", () => {
  it("reads <VAR>_FILE into <VAR> and refuses both or an empty file", () => {
    const files: Record<string, string> = {
      "/s/escrow": "abc\n",
      "/s/empty": "  ",
    };
    const read = (p: string) => files[p];
    const env: NodeJS.ProcessEnv = { SETTLEMENT_ESCROW_KEY_FILE: "/s/escrow" };
    loadSecretFiles(env, read);
    expect(env.SETTLEMENT_ESCROW_KEY).toBe("abc");
    expect(() =>
      loadSecretFiles(
        {
          SETTLEMENT_ADMIN_TOKEN: "x",
          SETTLEMENT_ADMIN_TOKEN_FILE: "/s/escrow",
        },
        read,
      ),
    ).toThrow(/not both/);
    expect(() =>
      loadSecretFiles({ SETTLEMENT_BLOB_KEY_FILE: "/s/empty" }, read),
    ).toThrow(/empty/);
  });
});
