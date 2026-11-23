import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  share: vi.fn(),
  writeAsStringAsync: vi.fn(),
  isAvailableAsync: vi.fn(),
  shareAsync: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ save: mocks.save, share: mocks.share }),
}));

vi.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/user/documents/',
  writeAsStringAsync: mocks.writeAsStringAsync,
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: mocks.isAvailableAsync,
  shareAsync: mocks.shareAsync,
}));

/** Re-import so the plugin proxy cache starts empty for each runtime. */
async function load() {
  vi.resetModules();
  return import('../walletFile');
}

const CONTENT = '{"wallet":{"address":"abc"},"keys":[]}';
const NAME = 'wallet_abc_1.json';

beforeEach(() => {
  mocks.save.mockReset();
  mocks.share.mockReset();
  mocks.writeAsStringAsync.mockReset();
  mocks.isAvailableAsync.mockReset();
  mocks.shareAsync.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saveWalletFileToDevice — Android app (Capacitor)', () => {
  beforeEach(() => {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
  });

  it('saves through the native plugin and opens the share sheet', async () => {
    mocks.save.mockResolvedValue({
      uri: 'content://media/external/downloads/42',
      fileName: NAME,
      location: `Downloads/Wallet/${NAME}`,
    });
    mocks.share.mockResolvedValue({ shared: true });

    const { saveWalletFileToDevice, isNativeWalletFileSaveSupported } = await load();
    expect(isNativeWalletFileSaveSupported()).toBe(true);

    await expect(saveWalletFileToDevice(CONTENT, NAME)).resolves.toEqual({
      fileName: NAME,
      location: `Downloads/Wallet/${NAME}`,
    });
    expect(mocks.save).toHaveBeenCalledWith({
      fileName: NAME,
      content: CONTENT,
      mimeType: 'application/json',
    });
    expect(mocks.share).toHaveBeenCalledWith({
      uri: 'content://media/external/downloads/42',
      fileName: NAME,
      mimeType: 'application/json',
    });
  });

  it('keeps the save successful when the share sheet is dismissed', async () => {
    mocks.save.mockResolvedValue({ uri: 'content://x', fileName: NAME, location: 'Downloads/Wallet/x' });
    mocks.share.mockRejectedValue(new Error('no activity'));

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).resolves.toMatchObject({
      fileName: NAME,
    });
  });

  it('reports a native save failure (path is not silently swallowed)', async () => {
    mocks.save.mockRejectedValue(new Error('could not save wallet file: denied'));

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).rejects.toThrow(/denied/);
  });
});

describe('saveWalletFileToDevice — browser', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: vi.fn(),
      body: { appendChild: vi.fn() },
    });
  });

  it('uses the File System Access picker when present', async () => {
    const write = vi.fn(async (_blob: Blob) => undefined);
    const close = vi.fn(async () => undefined);
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    vi.stubGlobal('showSaveFilePicker', picker);

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).resolves.toEqual({ fileName: NAME });

    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: NAME }),
    );
    expect(write).toHaveBeenCalledTimes(1);
    expect(await (write.mock.calls[0][0] as Blob).text()).toBe(CONTENT);
    expect(close).toHaveBeenCalledTimes(1);
    expect(document.createElement).not.toHaveBeenCalled();
  });

  it('surfaces AbortError so the screen can say "cancelled"', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    vi.stubGlobal('showSaveFilePicker', vi.fn(async () => Promise.reject(abort)));

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('falls back to an anchor download', async () => {
    const click = vi.fn();
    const link = { href: '', download: '', click, remove: vi.fn() };
    (document.createElement as ReturnType<typeof vi.fn>).mockReturnValue(link);
    const createObjectURL = vi.fn(() => 'blob:wallet');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).resolves.toEqual({ fileName: NAME });

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(link.href).toBe('blob:wallet');
    expect(link.download).toBe(NAME);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:wallet');
  });
});

describe('saveWalletFileToDevice — React-Native native build', () => {
  it('writes to the legacy documents dir and shares the file', async () => {
    mocks.isAvailableAsync.mockResolvedValue(true);
    mocks.shareAsync.mockResolvedValue(undefined);

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).resolves.toEqual({
      fileName: NAME,
      location: `file:///data/user/documents/${NAME}`,
    });

    expect(mocks.writeAsStringAsync).toHaveBeenCalledWith(
      `file:///data/user/documents/${NAME}`,
      CONTENT,
    );
    expect(mocks.shareAsync).toHaveBeenCalledWith(
      `file:///data/user/documents/${NAME}`,
      expect.objectContaining({ mimeType: 'application/json' }),
    );
  });

  it('still saves when the platform cannot share', async () => {
    mocks.isAvailableAsync.mockResolvedValue(false);

    const { saveWalletFileToDevice } = await load();
    await expect(saveWalletFileToDevice(CONTENT, NAME)).resolves.toMatchObject({ fileName: NAME });
    expect(mocks.writeAsStringAsync).toHaveBeenCalledTimes(1);
    expect(mocks.shareAsync).not.toHaveBeenCalled();
  });
});
