/**
 * Browser device-unlock via WebAuthn (platform authenticator).
 *
 * On a phone the confirmation uses the native `DeviceAuth` plugin. In a browser
 * there is no such call, so — when the page is a secure context and the browser
 * has a platform authenticator (Windows Hello / Touch ID / Android fingerprint)
 * — the gate uses WebAuthn: it registers a passkey for this device once, then
 * asserts it (a user-verification gesture) before an important transaction.
 *
 * This is a *local* confirmation gesture, not a server authentication: the
 * challenge is client-generated and never verified by a server, so it only
 * proves the person at the device unlocked it. Callers without WebAuthn fall
 * back to the wallet password.
 */
import { device } from '@/storage';

/** device-storage slot for the enrolled credential id (base64url). */
const CRED_KEY = ['webauthn', 'deviceUnlock'];

export type WebAuthnResult = 'ok' | 'denied' | 'unavailable';

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rnd(n: number): Uint8Array<ArrayBuffer> {
  const a = new Uint8Array(new ArrayBuffer(n));
  crypto.getRandomValues(a);
  return a;
}

/** True when the browser can run the platform-authenticator flow here. */
export function webAuthnSupported(): boolean {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  if (typeof PublicKeyCredential === 'undefined') return false;
  return typeof navigator?.credentials?.create === 'function' && typeof navigator.credentials.get === 'function';
}

/** Whether a built-in authenticator (Hello/Touch ID/fingerprint) is available. */
export async function platformAuthenticatorAvailable(): Promise<boolean> {
  if (!webAuthnSupported()) return false;
  const fn = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable;
  if (typeof fn !== 'function') return false;
  try {
    return await fn.call(PublicKeyCredential);
  } catch {
    return false;
  }
}

/** Enrol once, then reuse the stored credential id. */
async function ensureCredential(): Promise<{ id: Uint8Array<ArrayBuffer> } | { cancelled: true } | 'unavailable'> {
  const saved = device.get(CRED_KEY);
  if (saved) return { id: fromB64url(saved) };
  if (!(await platformAuthenticatorAvailable())) return 'unavailable';
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: rnd(32),
        rp: { name: 'bigT Wallet' },
        user: { id: rnd(16), name: 'wallet', displayName: 'bigT Wallet' },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60_000,
        attestation: 'none',
      },
    })) as PublicKeyCredential | null;
    if (!cred) return { cancelled: true };
    device.set(CRED_KEY, b64url(cred.rawId));
    return { id: new Uint8Array(cred.rawId) };  } catch (e) {
    return (e as { name?: string })?.name === 'NotAllowedError' ? { cancelled: true } : 'unavailable';
  }
}

/**
 * Show the browser's device-unlock prompt. `unavailable` → the caller falls back
 * to the wallet password; `denied` → the user cancelled, abort the transaction.
 */
export async function confirmWithPlatformAuthenticator(): Promise<WebAuthnResult> {
  const cred = await ensureCredential();
  if (cred === 'unavailable') return 'unavailable';
  // Declining the one-time enrolment is not a failed confirmation — fall back.
  if ('cancelled' in cred) return 'unavailable';
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: rnd(32),
        allowCredentials: [{ type: 'public-key', id: cred.id }],
        userVerification: 'required',
        timeout: 60_000,
      },
    });
    return assertion ? 'ok' : 'denied';
  } catch (e) {
    return (e as { name?: string })?.name === 'NotAllowedError' ? 'denied' : 'unavailable';
  }
}
