import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: { enabled: false },
  request: vi.fn(),
}));

vi.mock('@/lib/platform', () => ({
  isCapacitorNative: () => mocks.native.enabled,
}));

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: mocks.request },
}));

import { OkHttp3Util } from 'bigtangle-ts/dist/net/bigtangle/utils/OkHttp3Util';
import {
  base64ToBytes,
  bytesToBase64,
  installBinaryTransport,
  postBinary,
} from '../binaryPost';

/**
 * A signed-transaction-shaped body: hash/signature bytes are arbitrary, so
 * most of them are not valid UTF-8. This is exactly what the Capacitor bridge
 * used to mangle.
 */
const TX_BYTES = new Uint8Array([
  0x01, 0x00, 0x00, 0x00, 0x00, 0x7f, 0x80, 0x81, 0x9e, 0xb2, 0xc6, 0xef,
  0xf0, 0xfe, 0xff, 0x00, 0x41, 0x42,
]);

/** What `new TextEncoder().encode(new TextDecoder().decode(bytes))` yields. */
function lossyRoundTrip(bytes: Uint8Array): Uint8Array {
  return new TextEncoder().encode(new TextDecoder().decode(bytes));
}

describe('binaryPost', () => {
  beforeEach(() => {
    mocks.native.enabled = false;
    mocks.request.mockReset();
    OkHttp3Util.setTransport(null);
  });

  afterEach(() => {
    OkHttp3Util.setTransport(null);
  });

  it('round-trips base64 without touching UTF-8', () => {
    expect(Array.from(base64ToBytes(bytesToBase64(TX_BYTES)))).toEqual(Array.from(TX_BYTES));
    // The bridge's TextDecoder path is what corrupted the transaction; make
    // sure the replacement is not silently equal to it.
    expect(Array.from(lossyRoundTrip(TX_BYTES))).not.toEqual(Array.from(TX_BYTES));
  });

  it('sends the exact bytes on native (base64 + dataType file)', async () => {
    mocks.native.enabled = true;
    const responseBytes = new TextEncoder().encode('{"errorcode":0}');
    mocks.request.mockResolvedValue({ status: 200, data: bytesToBase64(responseBytes) });

    const res = await postBinary('https://node.example/submitTransaction', TX_BYTES);

    expect(mocks.request).toHaveBeenCalledTimes(1);
    const options = mocks.request.mock.calls[0][0] as Record<string, unknown>;
    expect(options.url).toBe('https://node.example/submitTransaction');
    expect(options.method).toBe('POST');
    expect(options.dataType).toBe('file');
    expect(options.data).toBe(bytesToBase64(TX_BYTES));
    // The body that reaches the native layer base64-decodes to the input,
    // not to the U+FFFD-inflated text the patch used to produce.
    expect(Array.from(base64ToBytes(options.data as string))).toEqual(Array.from(TX_BYTES));
    expect(options.responseType).toBe('arraybuffer');
    expect((options.headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );

    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.data)).toBe('{"errorcode":0}');
  });

  it('rebuilds the response when the plugin already parsed JSON', async () => {
    mocks.native.enabled = true;
    mocks.request.mockResolvedValue({ status: 200, data: { errorcode: 0, message: 'ok' } });

    const res = await postBinary('https://node.example/saveBlock', TX_BYTES);

    expect(JSON.parse(new TextDecoder().decode(res.data))).toEqual({
      errorcode: 0,
      message: 'ok',
    });
  });

  it('keeps the raw bytes on fetch (browser / Node) and forwards the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 500,
      arrayBuffer: async () => new TextEncoder().encode('boom').buffer,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await postBinary('https://node.example/submitTransaction', TX_BYTES);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(Array.from(init.body as Uint8Array)).toEqual(Array.from(TX_BYTES));
    expect(res.status).toBe(500);
    expect(new TextDecoder().decode(res.data)).toBe('boom');
    vi.unstubAllGlobals();
  });

  it('routes the SDK wallet transport through the byte-exact path', async () => {
    // The payment screen calls Wallet.pay* → submitTransaction → OkHttp3Util.
    mocks.native.enabled = true;
    mocks.request.mockResolvedValue({ status: 200, data: { errorcode: 0 } });

    installBinaryTransport();
    await OkHttp3Util.post('https://node.example/submitTransaction', TX_BYTES);

    expect(mocks.request).toHaveBeenCalledTimes(1);
    const options = mocks.request.mock.calls[0][0] as Record<string, unknown>;
    expect(options.data).toBe(bytesToBase64(TX_BYTES));
    expect(options.dataType).toBe('file');
  });

  it('installs nothing outside Capacitor', async () => {
    const axiosPost = vi
      .fn()
      .mockResolvedValue({ status: 200, data: Buffer.from('{"errorcode":0}') });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(OkHttp3Util as any, 'getAxiosInstance').mockReturnValue({ post: axiosPost } as never);

    installBinaryTransport();
    await OkHttp3Util.post('https://node.example/submitTransaction', TX_BYTES);

    expect(mocks.request).not.toHaveBeenCalled();
    expect(axiosPost).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked((OkHttp3Util as any).getAxiosInstance).mockRestore();
  });

  it('loads the plugin through a static import, never a dynamic one', async () => {
    // Metro compiles `import('@capacitor/core')` to `_asyncRequire(id, {paths})`,
    // which never settles in the Capacitor WebView: the payment hung at
    // "发送中…" with no request ever made. Guard the static import shape.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../binaryPost.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/import\(\s*['"]@capacitor\/core['"]/);
    expect(code).toMatch(/^import \{ CapacitorHttp \} from '@capacitor\/core';$/m);
  });
});
