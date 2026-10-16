import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { View, TouchableOpacity, useWindowDimensions } from 'react-native';
import { WalletProvider } from '@/state/wallet';
import { initSecureStorage, type BootPhase } from '@/storage';
import { checkForUpdate, confirmUpdate, installFailureText, installUpdate, notify } from '@/services/updater';
import i18n from '@/lib/i18n';
import { startAutoSelection, stopAutoSelection } from '@/services/discovery';
import Sidebar from '@/components/Sidebar';
import BootScreen from '@/components/BootScreen';
import { TransactionConfirmProvider } from '@/components/TransactionConfirm';
import { SidebarProvider, useSidebar } from '@/components/SidebarProvider';
import { MenuIcon } from '@/components/Icons';
import { useTranslation } from 'react-i18next';
import '../unistyles';
import '../lib/i18n';

export {
    ErrorBoundary,
} from 'expo-router';

SplashScreen.setOptions({
    fade: true,
    duration: 300,
});
SplashScreen.preventAutoHideAsync();

const DESKTOP_BREAKPOINT = 768;

function AppShell() {
    const { theme } = useUnistyles();
    const { width } = useWindowDimensions();
    const isDesktop = width >= DESKTOP_BREAKPOINT;
    const { setOpen } = useSidebar();
    const { t } = useTranslation();

    const headerLeft = () => (
        <TouchableOpacity onPress={() => setOpen(true)} style={{ paddingLeft: 16, paddingRight: 8, paddingVertical: 4 }}
            accessibilityRole="button" accessibilityLabel={t('sidebar.menu')}>
            <MenuIcon size={22} color={theme.colors.text.primary} />
        </TouchableOpacity>
    );

    return (
        <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.groupped.background }}>
            {isDesktop && <Sidebar visible onClose={() => setOpen(false)} persistent />}
            <View style={{ flex: 1, alignItems: isDesktop ? 'center' : undefined }}>
                <View style={{ flex: 1, width: '100%', maxWidth: isDesktop ? 820 : undefined }}>
                    <Stack
                        screenOptions={{
                            headerLeft: isDesktop ? undefined : headerLeft,
                            headerStyle: { backgroundColor: theme.colors.groupped.background },
                            headerTintColor: theme.colors.text.primary,
                        }}
                    >
                        <Stack.Screen name="index" options={{ title: t('sidebar.home') }} />
                        <Stack.Screen name="home/payment" options={{ title: t('sidebar.payment') }} />
                        <Stack.Screen name="home/keys" options={{ title: t('sidebar.keys') }} />
                        <Stack.Screen name="receive" options={{ headerShown: false }} />
                        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                        <Stack.Screen name="balance" options={{ headerShown: false }} />
                        <Stack.Screen name="public-balance" options={{ headerShown: false }} />
                        <Stack.Screen name="blocks" options={{ headerShown: false }} />
                        <Stack.Screen name="network" options={{ headerShown: false }} />
                        <Stack.Screen name="dashboard" options={{ headerShown: false }} />
                        <Stack.Screen name="trade" options={{ headerShown: false }} />
                        <Stack.Screen name="p2p" options={{ title: t('p2p.title') }} />
                        <Stack.Screen name="device" options={{ title: t('device.title') }} />
                    </Stack>
                </View>
            </View>
        </View>
    );
}

function MobileSidebar() {
    const { open, setOpen } = useSidebar();
    return <Sidebar visible={open} onClose={() => setOpen(false)} />;
}

export default function RootLayout() {
    const { theme } = useUnistyles();
    const [isReady, setIsReady] = React.useState(false);
    const [bootPhase, setBootPhase] = React.useState<BootPhase>('platform');

    const navigationTheme = React.useMemo(() => {
        if (theme.dark) {
            return {
                ...DarkTheme,
                colors: {
                    ...DarkTheme.colors,
                    background: theme.colors.groupped.background,
                }
            };
        }
        return {
            ...DefaultTheme,
            colors: {
                ...DefaultTheme.colors,
                background: theme.colors.groupped.background,
            }
        };
    }, [theme.dark]);

    React.useEffect(() => {
        // Hide the native splash as soon as React has mounted (the boot screen
        // below paints in the same commit) so the startup steps are visible
        // instead of a blank frame while the Keystore cache loads.
        SplashScreen.hideAsync().catch(() => {});
        (async () => {
            try {
                // In the Capacitor app, load key material from Keystore-backed
                // storage before anything reads the wallet. Each phase is
                // reported to the boot screen (and the log) so a slow start is
                // traceable instead of a hang on a blank frame.
                await initSecureStorage((phase, detail) => {
                    setBootPhase(phase);
                    console.info('[boot]', phase, detail ?? '');
                });
            } catch (error) {
                console.error('Error initializing:', error);
            } finally {
                setIsReady(true);
            }
        })();
    }, []);

    // OTA check (native Android only): a newer tagged APK in the release bucket
    // offers an in-place upgrade. Delayed after first paint so it never blocks
    // render, and a failure is silent.
    React.useEffect(() => {
        if (!isReady) return;
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const info = await checkForUpdate();
                    if (!info?.hasUpdate) return;
                    if (!info.mandatory && !(await confirmUpdate(info.versionName))) return;
                    const res = await installUpdate(info);
                    // A blocked/failed install (Play Protect, storage, a
                    // downgrade) must not vanish — the app just looks stuck on
                    // the old version otherwise.
                    if (!res.ok) notify(i18n.t('updates.title'), installFailureText(res));
                } catch {
                    /* update checks must never break startup */
                }
            })();
        }, 4000);
        return () => clearTimeout(timer);
    }, [isReady]);

    // Background server selection (auto-discover setting, default ON): pick the
    // healthiest L0/L1 endpoints by the checkchains.sh criteria and keep
    // re-checking every AUTO_SELECT_INTERVAL_MS. A no-op when the setting is
    // off (the tick re-reads the flag).
    React.useEffect(() => {
        if (!isReady) return;
        startAutoSelection();
        return () => stopAutoSelection();
    }, [isReady]);

    if (!isReady) {
        return <BootScreen phase={bootPhase} />;
    }

    return (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <GestureHandlerRootView style={{ flex: 1 }}>
                <ThemeProvider value={navigationTheme}>
                    <WalletProvider>
                        <TransactionConfirmProvider>
                            <SidebarProvider>
                                <AppShell />
                                <MobileSidebar />
                            </SidebarProvider>
                        </TransactionConfirmProvider>
                    </WalletProvider>
                </ThemeProvider>
            </GestureHandlerRootView>
        </SafeAreaProvider>
    );
}
