const variant = process.env.APP_ENV || 'development';
const name = "Wallet";
const bundleId = {
    development: "com.example.bapp.dev",
    preview: "com.example.bapp.preview",
    production: "com.example.bapp"
}[variant];

export default {
    expo: {
        name,
        slug: "j0904",
        owner: "j0904s-team",
        version: "1.0.0",
        runtimeVersion: "1",
        orientation: "default",
        splash: {
            image: "./sources/assets/images/splash.png",
            backgroundColor: "#F5F5F5",
            resizeMode: "contain",
        },
        icon: "./sources/assets/images/icon.png",
        scheme: "bigtai",
        userInterfaceStyle: "automatic",
        newArchEnabled: true,
        notification: {
            icon: "./sources/assets/images/icon-notification.png",
            iosDisplayInForeground: true
        },
        ios: {
            supportsTablet: true,
            bundleIdentifier: bundleId,
            config: {
                usesNonExemptEncryption: false
            },
            infoPlist: {
                NSMicrophoneUsageDescription: "Allow $(PRODUCT_NAME) to access your microphone.",
                NSLocalNetworkUsageDescription: "Allow $(PRODUCT_NAME) to find and connect to local devices on your network.",
                NSBonjourServices: ["_http._tcp", "_https._tcp"]
            }
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./sources/assets/images/icon-adaptive.png",
                monochromeImage: "./sources/assets/images/icon-monochrome.png",
                backgroundColor: "#18171C"
            },
            permissions: [
                "android.permission.ACCESS_NETWORK_STATE"
            ],
            edgeToEdgeEnabled: true,
            package: bundleId
        },
        web: {
            bundler: "metro",
            output: "single",
            favicon: "./sources/assets/images/favicon.png"
        },
        plugins: [
            [
                "expo-router",
                {
                    root: "./sources/app"
                }
            ],
            "expo-asset",
            "expo-localization",
            "expo-secure-store",
            "expo-web-browser",
            [
                'expo-splash-screen',
                {
                    image: "./sources/assets/images/splash.png",
                    resizeMode: "contain",
                    ios: {
                        backgroundColor: "#F2F2F7",
                        dark: {
                            backgroundColor: "#1C1C1E",
                        }
                    },
                    android: {
                        backgroundColor: "#F5F5F5",
                        dark: {
                            backgroundColor: "#1e1e1e",
                        }
                    }
                }
            ]
        ],
        experiments: {
            typedRoutes: true
        },
        extra: {
            eas: {
                projectId: "5c47005b-17aa-4139-b824-c054b5b7f90e"
            },
            router: {
                root: "./sources/app"
            }
        }
    }
};
