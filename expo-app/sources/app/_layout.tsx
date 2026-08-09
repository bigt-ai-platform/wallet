import * as React from 'react';
import * as SplashScreen from 'expo-splash-screen';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';
import { WalletProvider } from '@/state/wallet';
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
        // Initialize app
        (async () => {
            try {
                // Add any initialization logic here (fonts, etc.)
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
                        <Stack>
                            <Stack.Screen
                                name="(tabs)"
                                options={{
                                    headerShown: false,
                                }}
                            />
                            <Stack.Screen
                                name="balance"
                                options={{
                                    headerShown: false,
                                }}
                            />
                            <Stack.Screen
                                name="chart"
                                options={{
                                    headerShown: false,
                                }}
                            />
                            <Stack.Screen
                                name="wallet/keys"
                                options={{
                                    title: 'Manage Keys',
                                    presentation: 'modal',
                                }}
                            />
                        </Stack>
                    </WalletProvider>
                </ThemeProvider>
            </GestureHandlerRootView>
        </SafeAreaProvider>
    );
}
