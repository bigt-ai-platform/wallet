import { describe, expect, it, vi } from 'vitest';
import {
  fetchManifest,
  hasUpdate,
  manifestName,
  manifestUrl,
  parseManifest,
  updateInfo,
  type OtaManifest,
} from '../ota';

const VALID = {
  versionName: '1.2.0',
  versionCode: 1002000,
  url: 'https://minio.test/aifeeds-content/releases/wallet-production-release-1.2.0.apk',
  sha256: 'abc123',
  mandatory: false,
};

describe('manifestName / manifestUrl', () => {
  it('names the manifest by channel and type', () => {
    expect(manifestName('production')).toBe('wallet-production-release-latest.json');
    expect(manifestName('preview', 'debug')).toBe('wallet-preview-debug-latest.json');
  });

  it('joins the base without duplicating slashes', () => {
    expect(manifestUrl('https://minio.test/releases', 'production')).toBe(
      'https://minio.test/releases/wallet-production-release-latest.json',
    );
    expect(manifestUrl('https://minio.test/releases/', 'production')).toBe(
      'https://minio.test/releases/wallet-production-release-latest.json',
    );
  });
});

describe('parseManifest', () => {
  it('accepts and normalizes a valid manifest', () => {
    expect(parseManifest(VALID)).toEqual(VALID);
  });

  it('coerces an absent mandatory to false and ignores extra keys', () => {
    const m = parseManifest({ ...VALID, mandatory: undefined, extra: 1 });
    expect(m?.mandatory).toBe(false);
    expect(m).not.toHaveProperty('extra');
  });

  it('rejects payloads without a usable url or versionCode', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('nope')).toBeNull();
    expect(parseManifest({ ...VALID, url: '' })).toBeNull();
    expect(parseManifest({ ...VALID, versionCode: 0 })).toBeNull();
    expect(parseManifest({ ...VALID, versionCode: 'x' })).toBeNull();
    expect(parseManifest({ ...VALID, versionCode: Number.NaN })).toBeNull();
  });
});

describe('hasUpdate / updateInfo', () => {
  const manifest = VALID as OtaManifest;

  it('is true only for a strictly newer build', () => {
    expect(hasUpdate(manifest, 1001000)).toBe(true);
    expect(hasUpdate(manifest, 1002000)).toBe(false);
    expect(hasUpdate(manifest, 1003000)).toBe(false);
    expect(hasUpdate(null, 1)).toBe(false);
    expect(hasUpdate(manifest, Number.NaN)).toBe(false);
  });

  it('carries the current version plus the decision', () => {
    expect(updateInfo(manifest, 1001000)).toMatchObject({
      versionCode: 1002000,
      hasUpdate: true,
      currentVersionCode: 1001000,
    });
  });
});

describe('fetchManifest', () => {
  const ok = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  it('fetches and parses a manifest', async () => {
    const f = vi.fn(async () => ok(VALID)) as unknown as typeof fetch;
    await expect(fetchManifest('https://x/m.json', f)).resolves.toEqual(VALID);
    expect(f).toHaveBeenCalledWith('https://x/m.json', { headers: { Accept: 'application/json' } });
  });

  it('returns null on non-2xx, network error, or malformed body', async () => {
    const notOk = vi.fn(async () => ({ ok: false }) as Response) as unknown as typeof fetch;
    const boom = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const bad = vi.fn(async () => ok({ versionCode: 0 })) as unknown as typeof fetch;
    await expect(fetchManifest('https://x/m.json', notOk)).resolves.toBeNull();
    await expect(fetchManifest('https://x/m.json', boom)).resolves.toBeNull();
    await expect(fetchManifest('https://x/m.json', bad)).resolves.toBeNull();
  });
});
