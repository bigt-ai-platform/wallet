/**
 * Byte-exact POST transport.
 *
 * Chain writes (`submitTransaction`, `saveBlock`, `signToken`, peg-in, …) take
 * a *binary* transaction body. In a browser `fetch`/XHR sends a `Uint8Array`
 * untouched, but the Capacitor Android app runs this web export with
 * `CapacitorHttp` enabled, and its native bridge (`native-bridge.js`,
 * `convertBody()`) does `new TextDecoder().decode(body)` before handing the
 * body to the native layer. Every byte that is not valid UTF-8 becomes U+FFFD
 * (EF BF BD), and the native side then writes `string.getBytes(UTF_8)`, so the
 * signed transaction reaches the node larger and mangled:
 *
 *   net.bigtangle.exception.ProtocolException:
 *     java.lang.ArrayIndexOutOfBoundsException: arraycopy:
 *     last source index 658 out of bounds for byte[547]
 *       at net.bigtangle.core.Message.readBytes(Message.java:313)
 *       at net.bigtangle.core.TransactionOutput.parse(...)
 *
 * The plugin's only byte-exact request path is `dataType: 'file'`, which the
 * Android side base64-decodes (`CapacitorHttpUrlConnection.setRequestBody`)
 * instead of writing the text back as UTF-8. So on native we call the plugin
 * directly with base64 + `dataType: 'file'`; everywhere else we keep plain
 * `fetch` with the raw bytes. Both return the response bytes unchanged.
 */

import { CapacitorHttp } from '@capacitor/core';
import { isCapacitorNative } from '@/lib/platform';
import { OkHttp3Util } from 'bigtangle-ts/dist/net/bigtangle/utils/OkHttp3Util';

/** Raw bytes + status, exactly as the node answered. */
export interface BinaryResponse {
  status: number;
  data: Uint8Array;
}

interface NativeHttpResult {
  status: number;
  data: unknown;
}

interface NativeHttpPlugin {
  request(options: Record<string, unknown>): Promise<NativeHttpResult>;
}

export const BINARY_CONTENT_TYPE = 'application/octet-stream';

/** base64 → bytes (no UTF-8 round-trip anywhere). */
export function bytesToBase64(bytes: Uint8Array): string {
  const buf = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (buf) return buf.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** base64 → bytes. */
export function base64ToBytes(base64: string): Uint8Array {
  const buf = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (buf) {
    const decoded = buf.from(base64, 'base64');
    return new Uint8Array(decoded.buffer, decoded.byteOffset, decoded.length);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The CapacitorHttp plugin object.
 *
 * This MUST be a static import. A `import('@capacitor/core')` (dynamic) is
 * compiled by Metro to `_asyncRequire(moduleId, {paths})`, which never settles
 * in the Capacitor WebView — the payment sat at "发送中…" forever with no
 * request made. `@capacitor/core` is part of the main bundle anyway (the rest
 * of the app imports it the same way), so a static import costs nothing.
 */
function getNativeHttp(): NativeHttpPlugin {
  const plugin = CapacitorHttp as unknown as NativeHttpPlugin;
  if (typeof plugin?.request !== 'function') {
    throw new Error('CapacitorHttp plugin unavailable');
  }
  return plugin;
}

/** Rebuild the response bytes from a CapacitorHttp result. */
function nativeResponseBytes(data: unknown): Uint8Array {
  if (data == null) return new Uint8Array(0);
  // `responseType: 'arraybuffer'` → base64 for non-JSON bodies; the plugin
  // parses `application/json` bodies and hands back an object.
  if (typeof data === 'string') return base64ToBytes(data);
  return new TextEncoder().encode(JSON.stringify(data));
}

async function postBinaryNative(
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string>
): Promise<BinaryResponse> {
  const plugin = getNativeHttp();
  const result = await plugin.request({
    url,
    method: 'POST',
    headers: {
      'Content-Type': BINARY_CONTENT_TYPE,
      ...headers,
    },
    // `dataType: 'file'` is the only request encoding the native layer
    // base64-decodes; anything else is written back as text.
    dataType: 'file',
    data: bytesToBase64(bytes),
    responseType: 'arraybuffer',
    connectTimeout: OkHttp3Util.timeoutMinute * 60 * 1000,
    readTimeout: OkHttp3Util.timeoutMinute * 60 * 1000,
  });
  return { status: result.status, data: nativeResponseBytes(result.data) };
}

async function postBinaryFetch(
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string>
): Promise<BinaryResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': BINARY_CONTENT_TYPE, ...headers },
    body: bytes as unknown as BodyInit,
  });
  return {
    status: response.status,
    data: new Uint8Array(await response.arrayBuffer()),
  };
}

/**
 * POST `bytes` to `url` without altering a single byte of the body, and return
 * the response body as bytes. Uses the native plugin on Capacitor, plain
 * `fetch` elsewhere (browser, Node/tests).
 */
export function postBinary(
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {}
): Promise<BinaryResponse> {
  return isCapacitorNative()
    ? postBinaryNative(url, bytes, headers)
    : postBinaryFetch(url, bytes, headers);
}

/**
 * Route the bigtangle-ts SDK (`OkHttp3Util`) through `postBinary`, so
 * `Wallet.submitTransaction` / `saveBlock` / `signToken` send the exact signed
 * bytes on Android too. No-op outside Capacitor; safe to call more than once.
 */
export function installBinaryTransport(): void {
  if (!isCapacitorNative()) return;
  OkHttp3Util.setTransport(({ url, data, headers }) => postBinary(url, data, headers));
}
