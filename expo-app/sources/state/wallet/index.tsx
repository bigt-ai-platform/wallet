import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { loadWallet, type WalletFile } from '@/screens/wallet/WalletHelper';
import { device } from '@/storage';

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
    const address = device.get(['device', WALLET_ADDRESS_KEY]);
    const hasEncrypted = !!device.get(['device', WALLET_ENCRYPTED_CONTENT_KEY]);

    return {
      publicInfo:
        address && hasEncrypted
          ? {
              address,
              hasEncryptedWallet: true,
            }
          : null,
      isUnlocked: false,
      isLoading: false,
    };
  });

  // Clear decrypted wallet when app goes to background
  React.useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        if (decryptedWalletRef.current || passwordRef.current) {
          if (decryptedWalletRef.current) {
            const wallet = decryptedWalletRef.current;
            if (wallet.wallet.privateKey) {
              (wallet.wallet as any).privateKey = '0'.repeat(64);
            }
            decryptedWalletRef.current = null;
          }
          if (passwordRef.current) {
            passwordRef.current = null;
          }
          setState((prev) => ({ ...prev, isUnlocked: false }));
        }
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription?.remove();
  }, []);

  const storeEncryptedWallet = useCallback(
    async (encryptedContent: string, address: string, password?: string) => {
      setState((prev) => ({ ...prev, isLoading: true }));
      try {
        device.set(['device', WALLET_ENCRYPTED_CONTENT_KEY], encryptedContent);
        device.set(['device', WALLET_ADDRESS_KEY], address);

        if (password) {
          passwordRef.current = password;
        }

        setState({
          publicInfo: {
            address,
            hasEncryptedWallet: true,
          },
          isUnlocked: !!password,
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
        throw new Error('No wallet found');
      }

      const wallet = await loadWallet(encryptedContent, password);

      decryptedWalletRef.current = wallet;
      passwordRef.current = password;

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

  const clearWallet = useCallback(async () => {
    lockWallet();

    device.remove(['device', WALLET_ENCRYPTED_CONTENT_KEY]);
    device.remove(['device', WALLET_ADDRESS_KEY]);

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
    return decryptedWalletRef.current;
  }, []);

  const getPassword = useCallback(() => {
    return passwordRef.current;
  }, []);

  const api = useMemo<WalletApiContext>(
    () => ({
      storeEncryptedWallet,
      unlockWallet,
      lockWallet,
      clearWallet,
      hasWallet,
      getUnlockedWallet,
      getPassword,
    }),
    [
      storeEncryptedWallet,
      unlockWallet,
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
