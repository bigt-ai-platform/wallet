/*
 * Web-build Buffer polyfill.
 *
 * The bigtangle-ts SDK uses Node's global `Buffer` (e.g. Utils.hexToBuffer,
 * allocBuffer). In the browser bundle `Buffer` is undefined, so we install the
 * `buffer` npm package polyfill on globalThis before the SDK modules load.
 * Import this module FIRST (before expo-router/entry) in the app entry.
 */
import { Buffer } from 'buffer';

if (typeof (globalThis as any).Buffer === 'undefined') {
  (globalThis as any).Buffer = Buffer;
}
