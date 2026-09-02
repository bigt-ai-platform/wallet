import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { View, TouchableOpacity, useWindowDimensions } from 'react-native';
import { WalletProvider } from '@/state/wallet';
import Sidebar from '@/components/Sidebar';
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
                        <Stack.Screen name="home/payment" options={{ title: t('sidebar.payment') }} />
                        <Stack.Screen name="home/keys" options={{ title: t('sidebar.keys') }} />
                        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                        <Stack.Screen name="balance" options={{ headerShown: false }} />
                        <Stack.Screen name="chart" options={{ headerShown: false }} />
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
        (async () => {
            try {
                setIsReady(true);
            } catch (error) {
                console.error('Error initializing:', error);
            }
        })();
    }, []);

    React.useEffect(() => {
        if (isReady) {
            setTimeout(() => {
                SplashScreen.hideAsync();
            }, 100);
        }
    }, [isReady]);

    if (!isReady) {
        return null;
    }

    return (
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
            <GestureHandlerRootView style={{ flex: 1 }}>
                <ThemeProvider value={navigationTheme}>
                    <WalletProvider>
                        <SidebarProvider>
                            <AppShell />
                            <MobileSidebar />
                        </SidebarProvider>
                    </WalletProvider>
                </ThemeProvider>
            </GestureHandlerRootView>
        </SafeAreaProvider>
    );
}
