import { describe, expect, it } from 'vitest';
import {
  AuthError,
  assertAuthAllowsNetwork,
  authFromEnv,
  canonicalJson,
  checkBearer,
  checkHmac,
  signRequest,
} from '../src/auth.js';

describe('auth configuration', () => {
  it('defaults to off on Test but refuses off outside Test', () => {
    const auth = authFromEnv({});
    expect(auth.mode).toBe('off');
    expect(() => assertAuthAllowsNetwork(auth, 'Test')).not.toThrow();
    expect(() => assertAuthAllowsNetwork(auth, 'Mainnet')).toThrow(/without authentication/);
  });

  it('requires the material for the selected mode', () => {
    expect(() => authFromEnv({ AUTH_MODE: 'bearer' })).toThrow(/API_TOKEN/);
    expect(() => authFromEnv({ AUTH_MODE: 'hmac' })).toThrow(/API_HMAC_SECRET/);
    expect(() => authFromEnv({ AUTH_MODE: 'nope' })).toThrow(/AUTH_MODE/);
    expect(authFromEnv({ AUTH_MODE: 'bearer', API_TOKEN: 't' })).toMatchObject({
      mode: 'bearer',
      token: 't',
    });
  });
});

describe('bearer', () => {
  it('accepts the configured token and rejects everything else', () => {
    const auth = authFromEnv({ AUTH_MODE: 'bearer', API_TOKEN: 'secret' });
    expect(() => checkBearer(auth, 'Bearer secret')).not.toThrow();
    expect(() => checkBearer(auth, undefined)).toThrow(AuthError);
    expect(() => checkBearer(auth, 'Bearer other')).toThrow(/invalid/);
  });
});

describe('account-bound HMAC', () => {
  const auth = authFromEnv({ AUTH_MODE: 'hmac', API_HMAC_SECRET: 'hmac-secret' });
  const now = 1_700_000_000_000;
  const input = {
    method: 'POST',
    path: '/transfers',
    account: 'wallet-1',
    timestamp: String(now),
    body: { to: 'wallet-2', amount: '10', assetId: 'hkd', account: 'wallet-1' },
  };

  it('accepts a correctly signed request regardless of body key order', () => {
    const signature = signRequest('hmac-secret', input);
    expect(() => checkHmac(auth, input, {
      account: 'wallet-1', timestamp: input.timestamp, signature,
    }, now)).not.toThrow();

    const reordered = { body: { amount: '10', account: 'wallet-1', assetId: 'hkd', to: 'wallet-2' } };
    expect(canonicalJson(reordered.body)).toBe(canonicalJson(input.body));
  });

  it('rejects a different account, a stale timestamp and a tampered body', () => {
    const signature = signRequest('hmac-secret', input);
    expect(() => checkHmac(auth, input, {
      account: 'wallet-2', timestamp: input.timestamp, signature,
    }, now)).toThrow(/does not match/);
    expect(() => checkHmac(auth, input, {
      account: 'wallet-1', timestamp: input.timestamp, signature,
    }, now + 301_000)).toThrow(/skew/);
    expect(() => checkHmac(
      auth,
      { ...input, body: { ...input.body, amount: '1000' } },
      { account: 'wallet-1', timestamp: input.timestamp, signature },
      now,
    )).toThrow(/signature/);
  });

  it('requires headers on account routes', () => {
    expect(() => checkHmac(auth, input, {}, now)).toThrow(/x-timestamp/);
    expect(() => checkHmac(auth, input, {
      timestamp: input.timestamp, signature: 'x',
    }, now)).toThrow(/x-account/);
  });
});
