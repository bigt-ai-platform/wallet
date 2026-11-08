import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { loadWallet, loadPlainWalletSync, isPlainWalletJson, type WalletFile } from '@/screens/wallet/WalletHelper';
import { device } from '@/storage';
import { confirmWithDeviceUnlock, isDeviceUnlockPromptActive, isDeviceUnlockSupported, onDeviceUnlockSettled } from '@/services/deviceAuth';
import {
  forgetWalletUnlock,
  getRememberedWalletUnlock,
  hasRememberedWalletUnlock,
  rememberWalletUnlock,
} from '@/services/walletRecall';
import i18n from '@/lib/i18n';

/**
 * Wallet State Management
 *
 * Security considerations:
 * 1. Private keys are NEVER stored in plain text
 * 2. Only the encrypted wallet file content is persisted
 * 3. The decrypted wallet is held in memory only while actively used
 * 4. When app goes to background, the decrypted wallet is cleared
 * 5. Access to the private key requires the password each time
 */

// Types
export interface WalletPublicInfo {
  address: string;
  hasEncryptedWallet: boolean;
}

interface WalletStateContext {
  publicInfo: WalletPublicInfo | null;
  isUnlocked: boolean;
  isLoading: boolean;
}

interface WalletApiContext {
  storeEncryptedWallet: (
    encryptedContent: string,
    address: string,
    password?: string,
  ) => Promise<void>;
  unlockWallet: (password: string) => Promise<WalletFile>;
  /**
   * Unlock with the OS credential (fingerprint/face/PIN) instead of the wallet
   * password, using the unlock remembered on this device. `null` when the
   * device cannot offer it (web, no stored unlock, prompt unavailable).
   */
  unlockWithDevice: () => Promise<WalletFile | null>;
  /** True when the lock screen should offer the credential button. */
  canUnlockWithDevice: () => boolean;
  lockWallet: () => void;
  clearWallet: () => Promise<void>;
  hasWallet: () => boolean;
  getUnlockedWallet: () => WalletFile | null;
  getPassword: () => string | null;
}

// Storage keys
const WALLET_ENCRYPTED_CONTENT_KEY = 'walletEncryptedContent';
const WALLET_ADDRESS_KEY = 'walletAddress';

// Contexts
const WalletStateCtx = createContext<WalletStateContext>({
  publicInfo: null,
  isUnlocked: false,
  isLoading: false,
});
WalletStateCtx.displayName = 'WalletStateContext';

const WalletApiCtx = createContext<WalletApiContext>({
  storeEncryptedWallet: async () => {},
  unlockWallet: async () => {
    throw new Error('WalletProvider not initialized');
  },
  unlockWithDevice: async () => null,
  canUnlockWithDevice: () => false,
  lockWallet: () => {},
  clearWallet: async () => {},
  hasWallet: () => false,
  getUnlockedWallet: () => null,
  getPassword: () => null,
});
WalletApiCtx.displayName = 'WalletApiContext';

// Provider component
export function WalletProvider({ children }: { children: React.ReactNode }) {
  const decryptedWalletRef = React.useRef<WalletFile | null>(null);
  const passwordRef = React.useRef<string | null>(null);

  const [state, setState] = React.useState<WalletStateContext>(() => {
    const encryptedContent = device.get(['device', WALLET_ENCRYPTED_CONTENT_KEY]);
    const hasEncrypted = !!encryptedContent;

    // An unencrypted wallet file needs no password — treat it as unlocked.
    // Re-derive the address from the stored private key so a stale saved address
    // (e.g. an older PQ-hex one, or an older network-encoded base58) self-heals
    // to the currently selected network's encoding.
    const isPlain = hasEncrypted && isPlainWalletJson(String(encryptedContent));
    let address = device.get(['device', WALLET_ADDRESS_KEY]);
    if (isPlain) {
      try {
        address = loadPlainWalletSync(String(encryptedContent)).wallet.address;
      } catch {
        try {
          const keys = JSON.parse(String(encryptedContent)).keys;
          if (keys?.length && typeof keys[0]?.address === 'string') {
            address = keys[0].address;
          }
        } catch {
          // keep the stored address
        }
      }
    }

    return {
      publicInfo:
        address && hasEncrypted
          ? {
              address,
              hasEncryptedWallet: true,
            }
          : null,
      isUnlocked: isPlain,
      isLoading: false,
    };
  });

  /**
   * Wipe the decrypted key from memory. An unencrypted wallet is never locked:
   * its only copy is the plain JSON already in localStorage, and it has no
   * password — a "locked" state there dead-ends on a password prompt the user
   * never set.
   */
  const lockWallet = useCallback(() => {
    if (decryptedWalletRef.current) {
      const wallet = decryptedWalletRef.current;
      if (wallet.wallet.privateKey) {
        (wallet.wallet as any).privateKey = '0'.repeat(64);
      }
      decryptedWalletRef.current = null;
    }
    passwordRef.current = null;
    setState((prev) => ({ ...prev, isUnlocked: false }));
  }, []);

  // Clear the decrypted wallet when the app goes to the background.
  //
  // Only `background` locks: an `inactive` transition also happens for the OS
  // unlock prompt and the system dialogs we open ourselves, and locking on it
  // would wipe the wallet mid-unlock (the user then has to start over).
  React.useEffect(() => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearSettleTimer = () => {
      if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
    };
    const lockOnBackground = () => {
      const stored = device.get(['device', WALLET_ENCRYPTED_CONTENT_KEY]);
      if (stored && isPlainWalletJson(String(stored))) return;
      lockWallet();
    };
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'active') { clearSettleTimer(); return; }
      if (nextAppState !== 'background') return;
      // Our own OS unlock prompt is a separate system activity on several
      // OEM builds, so the app "backgrounds" while the user authenticates.
      // Locking here wiped the wallet the create/pay flow was about to use.
      if (isDeviceUnlockPromptActive()) return;
      lockOnBackground();
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    const offPromptSettled = onDeviceUnlockSettled(() => {
      // If the user really left the app while the prompt was up, lock shortly
      // after it settles — long enough for the resumed WebView to report
      // `active` again (which cancels this), so a normal unlock never locks.
      if (settleTimer) return;
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (AppState.currentState === 'background') handleAppStateChange('background');
      }, 1500);
    });
    return () => { clearSettleTimer(); subscription?.remove(); offPromptSettled(); };
  }, [lockWallet]);

  const storeEncryptedWallet = useCallback(
    async (encryptedContent: string, address: string, password?: string) => {
      setState((prev) => ({ ...prev, isLoading: true }));
      try {
        device.set(['device', WALLET_ENCRYPTED_CONTENT_KEY], encryptedContent);
        device.set(['device', WALLET_ADDRESS_KEY], address);

        if (password) {
          passwordRef.current = password;
          // A freshly created/imported wallet is remembered for credential
          // unlock straight away, like the password-unlock path.
          rememberWalletUnlock(password);
          // The wallet is now unlocked — populate the in-memory decrypted
          // wallet so getUnlockedWallet() works immediately (import /
          // create flows save with a password and continue unlocked).
          try {
            decryptedWalletRef.current = await loadWallet(encryptedContent, password);
          } catch {
            // Unlock later through the normal unlock flow.
          }
        } else if (isPlainWalletJson(encryptedContent)) {
          // A plain wallet is rewritten without a password (e.g. adding a key
          // to an unencrypted wallet). Refresh the in-memory copy so the UI
          // sees the new key list immediately.
          passwordRef.current = null;
          try {
            decryptedWalletRef.current = loadPlainWalletSync(encryptedContent);
          } catch {
            // Keep the previous copy; the next boot re-reads from storage.
          }
        }

        // Unencrypted wallets are never locked.
        const unlocked = !!password || isPlainWalletJson(encryptedContent);

        setState({
          publicInfo: {
            address,
            hasEncryptedWallet: true,
          },
          isUnlocked: unlocked,
          isLoading: false,
        });
      } catch (error) {
        setState((prev) => ({ ...prev, isLoading: false }));
        throw error;
      }
    },
    [],
  );

  const unlockWallet = useCallback(async (password: string) => {
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const encryptedContent = device.get([
        'device',
        WALLET_ENCRYPTED_CONTENT_KEY,
      ]);

      if (!encryptedContent) {
        throw new Error(i18n.t('errors.noWalletFound'));
      }

      const wallet = await loadWallet(encryptedContent, password);

      decryptedWalletRef.current = wallet;
      passwordRef.current = password;
      // Remember the unlock for the OS credential ("remember this device",
      // like ../dai): the next lock screen offers fingerprint/face instead of
      // the password. Native only, and removed with the wallet.
      rememberWalletUnlock(password);

      setState((prev) => ({
        ...prev,
        isUnlocked: true,
        isLoading: false,
      }));

      return wallet;
    } catch (error) {
      setState((prev) => ({ ...prev, isLoading: false }));
      throw error;
    }
  }, []);

  const canUnlockWithDevice = useCallback(() => {
    return isDeviceUnlockSupported() && hasRememberedWalletUnlock();
  }, []);

  /**
   * Unlock with the OS credential. The remembered password is read only after
   * the OS prompt succeeded; a denied/unavailable prompt returns null so the
   * screen can fall back to the password field.
   */
  const unlockWithDevice = useCallback(async () => {
    if (!isDeviceUnlockSupported()) return null;
    const remembered = getRememberedWalletUnlock();
    if (!remembered) return null;
    const res = await confirmWithDeviceUnlock({
      title: i18n.t('wallet.deviceUnlockTitle'),
      subtitle: i18n.t('wallet.deviceUnlockSubtitle'),
      reason: i18n.t('wallet.deviceUnlockReason'),
    });
    if (res !== 'ok') return null;
    return unlockWallet(remembered);
  }, [unlockWallet]);

  const clearWallet = useCallback(async () => {
    lockWallet();

    device.remove(['device', WALLET_ENCRYPTED_CONTENT_KEY]);
    device.remove(['device', WALLET_ADDRESS_KEY]);
    // The remembered unlock must never outlive the wallet it belongs to.
    forgetWalletUnlock();

    setState({
      publicInfo: null,
      isUnlocked: false,
      isLoading: false,
    });
  }, [lockWallet]);

  const hasWallet = useCallback(() => {
    return !!device.get(['device', WALLET_ENCRYPTED_CONTENT_KEY]);
  }, []);

  const getUnlockedWallet = useCallback(() => {
    if (decryptedWalletRef.current) {
      return decryptedWalletRef.current;
    }
    // A plain (unencrypted) wallet is stored directly and never goes through
    // unlockWallet(), so load it lazily on demand — synchronously, since no
    // scrypt derivation is involved.
    const encryptedContent = device.get([
      'device',
      WALLET_ENCRYPTED_CONTENT_KEY,
    ]);
    if (encryptedContent && isPlainWalletJson(String(encryptedContent))) {
      try {
        decryptedWalletRef.current = loadPlainWalletSync(String(encryptedContent));
      } catch {
        return null;
      }
    }
    return decryptedWalletRef.current;
  }, []);

  const getPassword = useCallback(() => {
    return passwordRef.current;
  }, []);

  const api = useMemo<WalletApiContext>(
    () => ({
      storeEncryptedWallet,
      unlockWallet,
      unlockWithDevice,
      canUnlockWithDevice,
      lockWallet,
      clearWallet,
      hasWallet,
      getUnlockedWallet,
      getPassword,
    }),
    [
      storeEncryptedWallet,
      unlockWallet,
      unlockWithDevice,
      canUnlockWithDevice,
      lockWallet,
      clearWallet,
      hasWallet,
      getUnlockedWallet,
      getPassword,
    ],
  );

  return (
    <WalletStateCtx.Provider value={state}>
      <WalletApiCtx.Provider value={api}>{children}</WalletApiCtx.Provider>
    </WalletStateCtx.Provider>
  );
}

// Hooks
export function useWalletState(): WalletStateContext {
  return useContext(WalletStateCtx);
}

export function useWalletApi(): WalletApiContext {
  return useContext(WalletApiCtx);
}

export function useWallet() {
  const state = useWalletState();
  const api = useWalletApi();
  return { ...state, ...api };
}
