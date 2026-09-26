/**
 * Platform detection for the web/Android split.
 *
 * The Android app is a Capacitor wrap of the web export, so `Platform.OS` is
 * still "web" on device (see storage/secureWeb.ts). The network layer must
 * treat that case as native — direct chain endpoints, not the browser's
 * same-origin /l0/ /l1/ proxy, which only the deploy stack serves.
 */

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
}

/** True when the Capacitor bridge reports a native (Android/iOS) platform. */
export function isCapacitorNative(cap?: CapacitorGlobal | null): boolean {
  const c = cap ?? (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  return !!c?.isNativePlatform?.();
}
