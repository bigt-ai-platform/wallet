import { describe, expect, it, vi } from 'vitest';
import {
  ECKey, MainNetParams, PQKey, SignatureBundle, TestParams, Utils,
} from 'bigtangle-ts';
import type { WalletKey } from '@/lib/walletKeys';
import {
  REDEEM_INTENT_DOMAIN, buildRedeemIntent, intentHash, intentMessage,
  newNonce, signRedeemIntent, submitRedeemIntent,
} from '../redeemIntent';

const DESTINATION = '0x2222222222222222222222222222222222222222';

function intentFor(account: string, network: 'Mainnet' | 'Test' = 'Test') {
  return buildRedeemIntent({
    assetId: 'usdt',
    account,
    amountRaw: '2000000',
    destination: DESTINATION,
    network,
    nonce: 'nonce-0001',
    expiry: 1_760_000_000_000,
  });
}

describe('intent message', () => {
  it('matches the issuer field order', () => {
    const intent = intentFor('abc');
    expect(intentMessage(intent)).toBe(JSON.stringify({
      domain: REDEEM_INTENT_DOMAIN,
      network: 'Test',
      assetId: 'usdt',
      account: 'abc',
      amountRaw: '2000000',
      destination: DESTINATION,
      nonce: 'nonce-0001',
      expiry: 1_760_000_000_000,
    }));
  });

  it('generates a unique hex nonce', () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});

describe('signing', () => {
  const seed = Utils.HEX.encode(new Uint8Array(32).fill(7));
  const pq = PQKey.fromPrivateKeyHex(seed);
  const pqKey: WalletKey = {
    address: pq.toAddressString(new TestParams()),
    pubkey: pq.getPublicKeyAsHex(),
    privateKey: seed,
    keyType: 'PQ',
  };

  it('signs a PQ intent that verifies with the issuer rules', () => {
    const intent = intentFor(pqKey.address);
    const proof = signRedeemIntent(pqKey, intent);
    expect(proof.keyType).toBe('PQ');
    expect(PQKey.verify(
      intentHash(intent),
      SignatureBundle.deserialize(Utils.HEX.decode(proof.signature)),
      Utils.HEX.decode(proof.publicKey),
    )).toBe(true);
  });

  it('signs a legacy EC intent', () => {
    const priv = Utils.HEX.encode(new Uint8Array(32).fill(3));
    const ec = ECKey.fromPrivateString(priv);
    const key: WalletKey = {
      address: ec.toAddressString(new MainNetParams()),
      pubkey: Utils.HEX.encode(ec.getPubKey()),
      privateKey: priv,
      keyType: 'EC',
    };
    const intent = intentFor(key.address, 'Mainnet');
    const proof = signRedeemIntent(key, intent);
    expect(proof.keyType).toBe('EC');
    expect(ECKey.verify(
      intentHash(intent).getBytes(),
      Utils.HEX.decode(proof.signature),
      Utils.HEX.decode(proof.publicKey),
    )).toBe(true);
  });

  it('refuses to sign for an account the key does not control', () => {
    expect(() => signRedeemIntent(pqKey, intentFor('someone-else'))).toThrow(/does not control/);
  });
});

describe('submit', () => {
  const settings = { apiUrl: 'https://issuer.example/', apiToken: 'secret' };
  const intent = intentFor('account');
  const proof = { keyType: 'PQ' as const, publicKey: 'aa', signature: 'bb' };

  it('posts the proof and bearer token', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'op1', status: 'pending' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(submitRedeemIntent(intent, proof, settings)).resolves.toEqual({
      id: 'op1',
      status: 'pending',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://issuer.example/redeem-intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({
        account: 'account',
        assetId: 'usdt',
        amount: '2000000',
        destination: DESTINATION,
        nonce: 'nonce-0001',
        expiry: 1_760_000_000_000,
        keyType: 'PQ',
        publicKey: 'aa',
        signature: 'bb',
      }),
    });
    vi.unstubAllGlobals();
  });

  it('surfaces the issuer error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: 'insufficient balance' }),
    })));
    await expect(submitRedeemIntent(intent, proof, settings)).rejects.toThrow('insufficient balance');
    vi.unstubAllGlobals();
  });
});
