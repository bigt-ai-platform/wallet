import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return { store };
});

vi.mock('@/storage', () => ({
  device: {
    get: (key: string[]) => mocks.store.get(key.join('.')),
    set: (key: string[], value: string) => { mocks.store.set(key.join('.'), value); },
    remove: (key: string[]) => { mocks.store.delete(key.join('.')); },
  },
}));

import {
  DISTRIBUTOR_NOT_CONFIGURED,
  distributorAccount,
  getDistributorSettings,
  getExternalBalances,
  getExternalCatalog,
  getExternalCatalogEntries,
  getExternalOperation,
  getExternalStatement,
  getListedExternalAssets,
  isDistributorConfigured,
  requestExternalMint,
  requestExternalRedeem,
  setDistributorSettings,
  submitExternalTransfer,
  validateTransfer,
} from '../distributor';

const WALLET = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const RECIPIENT = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, init };
    calls.push(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => handler(call),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function configure() {
  setDistributorSettings({ apiUrl: 'https://dist.example/api/', token: 'tok-1' });
}

describe('distributor settings', () => {
  beforeEach(() => mocks.store.clear());
  afterEach(() => vi.unstubAllGlobals());

  it('is unconfigured by default and refuses to call out', async () => {
    expect(isDistributorConfigured()).toBe(false);
    await expect(getExternalBalances(WALLET)).rejects.toThrow(DISTRIBUTOR_NOT_CONFIGURED);
  });

  it('round-trips settings and trims them', () => {
    setDistributorSettings({ apiUrl: '  https://d.example  ', token: ' t ', accountId: ' acc ' });
    expect(getDistributorSettings()).toEqual({
      apiUrl: 'https://d.example',
      token: 't',
      accountId: 'acc',
    });
    expect(isDistributorConfigured()).toBe(true);
  });

  it('falls back to the wallet address when no account id is set', () => {
    configure();
    expect(distributorAccount(WALLET)).toBe(WALLET);
    setDistributorSettings({ accountId: 'ACC-42' });
    expect(distributorAccount(WALLET)).toBe('ACC-42');
  });
});

describe('distributor reads', () => {
  beforeEach(() => { mocks.store.clear(); configure(); });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer token and account, and strips the trailing slash', async () => {
    const calls = mockFetch(() => ({ items: [] }));
    await getExternalBalances(WALLET);
    expect(calls[0].url).toBe(`https://dist.example/api/balances?account=${encodeURIComponent(WALLET)}`);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
  });

  it('keeps known assets and drops unknown or malformed balances', async () => {
    mockFetch(() => ({
      items: [
        { assetId: 'hkdap', available: '1500000', pending: '200000' },
        { assetId: 'hkdap', available: '0' },
        { assetId: 'fake', available: '999' },
        { assetId: 'hkdap' },
        null,
        'nonsense',
      ],
    }));
    expect(await getExternalBalances(WALLET)).toEqual([
      { assetId: 'hkdap', available: '1500000', pending: '200000' },
      { assetId: 'hkdap', available: '0' },
    ]);
  });

  it('parses a statement and defaults an unknown status to pending', async () => {
    mockFetch(() => ({
      items: [
        { id: 'm1', assetId: 'hkdap', direction: 'in', amount: '5000000', status: 'completed', hash: '0xabc' },
        { id: 'm2', assetId: 'hkdap', direction: 'out', amount: '1000000', status: 'weird' },
        { id: 'm3', assetId: 'hkdap', direction: 'sideways', amount: '1' },
        { id: 'm4', assetId: 'fake', direction: 'in', amount: '1' },
      ],
    }));
    const rows = await getExternalStatement(WALLET, 10);
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(rows[0].status).toBe('completed');
    expect(rows[1].status).toBe('pending');
  });

  it('surfaces an HTTP error instead of an empty list', async () => {
    mockFetch(() => ({ items: [] }), 503);
    await expect(getExternalBalances(WALLET)).rejects.toThrow(/HTTP 503/);
  });

  it('serves a catalog merged over the bundled registry, dropping unknown ids', async () => {
    const calls = mockFetch(() => ({
      items: [
        { assetId: 'hkd' },
        { id: 'GOLD' },
        { assetId: 'hkd' },
        { assetId: 'fake-coin' },
        { assetId: 'hkdap' },
        null,
      ],
    }));
    // hkd, xau and hkdap all resolve; duplicates and unknown ids do not.
    expect(await getExternalCatalog()).toEqual(['hkd', 'gold', 'hkdap']);
    expect(calls[0].url).toBe('https://dist.example/api/assets');
    const listed = await getListedExternalAssets();
    expect(listed.map((a) => a.symbol)).toEqual(['HKD', 'GOLD', 'HKDAP']);
  });

  it('carries funding instructions and falls back to the bundled rail', async () => {
    const calls = mockFetch(() => ({
      items: [
        {
          assetId: 'hkd', depositKind: 'bank', referencePrefix: 'HKD',
          depositInstructions: 'Bank: 012-345-678',
        },
        { assetId: 'eth', depositKind: 'evm', depositAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' },
        { assetId: 'gold', depositKind: 'nonsense' },
      ],
    }));
    const entries = await getExternalCatalogEntries();
    expect(calls[0].url).toBe('https://dist.example/api/assets');
    expect(entries).toEqual([
      { assetId: 'hkd', depositKind: 'bank', depositInstructions: 'Bank: 012-345-678', referencePrefix: 'HKD' },
      { assetId: 'eth', depositKind: 'evm', depositAddress: '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf' },
      // unknown rail falls back to the registry, never to the server's string
      { assetId: 'gold', depositKind: 'vault' },
    ]);
  });

  it('returns an empty catalog when the distributor omits items', async () => {
    mockFetch(() => ({}));
    expect(await getExternalCatalog()).toEqual([]);
  });
});

describe('transfer validation', () => {
  it('rejects an unknown asset', () => {
    expect(validateTransfer({ account: WALLET, assetId: 'fake', to: RECIPIENT, amount: '1' }))
      .toBe('errAsset');
  });

  it('rejects a missing account, recipient or amount', () => {
    expect(validateTransfer({ account: '', assetId: 'hkdap', to: RECIPIENT, amount: '1' }))
      .toBe('errAccount');
    expect(validateTransfer({ account: WALLET, assetId: 'hkdap', to: '  ', amount: '1' }))
      .toBe('errAddress');
    expect(validateTransfer({ account: WALLET, assetId: 'hkdap', to: RECIPIENT, amount: '0' }))
      .toBe('errAmount');
    expect(validateTransfer({ account: WALLET, assetId: 'hkdap', to: RECIPIENT, amount: 'x' }))
      .toBe('errAmount');
  });

  it('rejects an address with a broken EIP-55 checksum', () => {
    const poisoned = '0x7E5F4552091A69125d5DfCb7b8C2659029395bdE';
    expect(validateTransfer({ account: WALLET, assetId: 'hkdap', to: poisoned, amount: '1' }))
      .toBe('errAddress');
  });

  it('accepts a checksummed address and a plain lowercase one', () => {
    expect(validateTransfer({ account: WALLET, assetId: 'hkdap', to: RECIPIENT, amount: '1.25' }))
      .toBeNull();
    expect(validateTransfer({ account: WALLET, assetId: 'hkdap', to: RECIPIENT.toLowerCase(), amount: '1' }))
      .toBeNull();
  });
});

describe('distributor writes', () => {
  beforeEach(() => { mocks.store.clear(); configure(); });
  afterEach(() => vi.unstubAllGlobals());

  it('posts a transfer in smallest units, with a checksummed recipient', async () => {
    const calls = mockFetch(() => ({ id: 't1', status: 'pending' }));
    const result = await submitExternalTransfer({
      account: WALLET,
      assetId: 'HKDAP',
      to: RECIPIENT.toLowerCase(),
      amount: '1.5',
      memo: ' invoice 7 ',
    });
    expect(result).toEqual({ id: 't1', status: 'pending' });
    expect(calls[0].url).toBe('https://dist.example/api/transfers');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      account: WALLET,
      assetId: 'hkdap',
      to: RECIPIENT,
      amount: '1500000',
      memo: 'invoice 7',
    });
  });

  it('posts mint and redeem requests to their own endpoints', async () => {
    const calls = mockFetch(() => ({ id: 'op', status: 'processing' }));
    expect((await requestExternalMint('hkdap', WALLET, '10', 'wire-1')).status).toBe('processing');
    expect((await requestExternalRedeem('hkdap', WALLET, '2')).id).toBe('op');
    expect(calls.map((c) => c.url)).toEqual([
      'https://dist.example/api/mint-requests',
      'https://dist.example/api/redeem-requests',
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      account: WALLET, assetId: 'hkdap', amount: '10000000', reference: 'wire-1',
    });
  });

  it('polls an operation and rejects a response without an id', async () => {
    mockFetch(() => ({ id: 't1', status: 'completed' }));
    expect(await getExternalOperation('t1')).toEqual({ id: 't1', status: 'completed' });
    mockFetch(() => ({ status: 'completed' }));
    await expect(getExternalOperation('t2')).rejects.toThrow(/operation id/);
  });
});
