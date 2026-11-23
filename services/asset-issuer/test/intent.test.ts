import { describe, expect, it } from 'vitest';
import { ECKey, MainNetParams, PQKey, TestParams, Utils } from 'bigtangle-ts';
import {
  REDEEM_INTENT_DOMAIN,
  intentHash,
  intentMessage,
  validateIntentFields,
  verifyRedeemIntent,
  type RedeemIntent,
} from '../src/intent.js';

const DESTINATION = '0x2222222222222222222222222222222222222222';

function intent(over: Partial<RedeemIntent> = {}): RedeemIntent {
  return {
    domain: REDEEM_INTENT_DOMAIN,
    network: 'Test',
    assetId: 'usdt',
    account: 'account',
    amountRaw: '1000000',
    destination: DESTINATION,
    nonce: 'nonce-0001',
    expiry: Date.now() + 60_000,
    ...over,
  };
}

describe('intent message', () => {
  it('is fixed-order and changes with every field', () => {
    const base = intent();
    expect(intentMessage(base)).toBe(intentMessage({ ...base }));
    expect(intentMessage({ ...base, amountRaw: '2' })).not.toBe(intentMessage(base));
    expect(intentMessage({ ...base, destination: '0x3333333333333333333333333333333333333333' }))
      .not.toBe(intentMessage(base));
  });
});

describe('PQ signature', () => {
  const key = PQKey.fromMLDSA(new Uint8Array(32).fill(7));
  const account = key.toAddressString(new TestParams());
  const signed = intent({ account });
  const proof = {
    keyType: 'PQ' as const,
    publicKey: key.getPublicKeyAsHex(),
    signature: Utils.HEX.encode(key.sign(intentHash(signed)).serialize()),
  };

  it('verifies the L1 account and rejects a changed amount', () => {
    expect(verifyRedeemIntent(signed, proof)).toEqual({ ok: true });
    expect(verifyRedeemIntent({ ...signed, amountRaw: '2' }, proof)).toEqual({
      ok: false,
      error: 'signature does not verify',
    });
  });

  it('rejects a valid signature from a key that is not the account', () => {
    const other = PQKey.fromMLDSA(new Uint8Array(32).fill(8));
    expect(verifyRedeemIntent(signed, {
      keyType: 'PQ',
      publicKey: other.getPublicKeyAsHex(),
      signature: Utils.HEX.encode(other.sign(intentHash(signed)).serialize()),
    })).toEqual({
      ok: false,
      error: 'public key does not match the account',
    });
  });
});

describe('EC signature', () => {
  const key = ECKey.fromPrivate(new Uint8Array(32).fill(3));
  const account = key.toAddressString(new MainNetParams());
  const signed = intent({ account, network: 'Mainnet' });
  const proof = {
    keyType: 'EC' as const,
    publicKey: Utils.HEX.encode(key.getPubKey()),
    signature: Utils.HEX.encode(key.sign(intentHash(signed)).encodeToBitcoin()),
  };

  it('verifies the legacy EC account', () => {
    expect(verifyRedeemIntent(signed, proof)).toEqual({ ok: true });
    expect(verifyRedeemIntent({ ...signed, destination: DESTINATION.replace('2', '3') }, proof).ok)
      .toBe(false);
  });
});

describe('field validation', () => {
  const now = 1_700_000_000_000;
  const valid = intent({ expiry: now + 60_000 });

  it('accepts a well-formed intent', () => {
    expect(validateIntentFields(valid, now)).toEqual({ ok: true });
  });

  it('rejects expiry, amount, destination and unknown nonce', () => {
    expect(validateIntentFields({ ...valid, expiry: now - 1 }, now)).toMatchObject({ ok: false });
    expect(validateIntentFields({ ...valid, expiry: now + 8 * 24 * 60 * 60 * 1000 }, now))
      .toMatchObject({ ok: false });
    expect(validateIntentFields({ ...valid, amountRaw: '0' }, now)).toMatchObject({ ok: false });
    expect(validateIntentFields({ ...valid, destination: '0x12' }, now)).toMatchObject({ ok: false });
    expect(validateIntentFields({ ...valid, nonce: 'short' }, now)).toMatchObject({ ok: false });
  });
});
