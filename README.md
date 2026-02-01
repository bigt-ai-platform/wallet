# Bapp - Bigtangle Mobile Application

A cross-platform (Android, iOS, Web) mobile application for Bigtangle blockchain, built with React Native and Expo.

## Features

### Core Features ✅
- **Wallet Management**: Create, import, and manage encrypted wallets
- **Transaction Payments**: Send tokens with UTXO-based transactions
- **Market Prices**: View live token prices and trading information
- **Token Browser**: Search and browse available tokens
- **AI Chat**: Interactive AI assistant for blockchain queries
- **Settings**: Network configuration (mainnet/testnet) and server selection

### Transaction System ✅
- **UTXO Selection**: Automatic selection of optimal UTXOs for transactions
- **Transaction Signing**: Secure signing using bigtangle-ts with SIGHASH_ALL
- **Fee Estimation**: Smart fee calculation based on transaction size
- **Change Handling**: Automatic change output creation
- **Memo Support**: Optional transaction notes

### Security Features
- **Encrypted Storage**: Scrypt-based wallet encryption
- **Auto-Lock**: Wallet automatically locks on app background
- **In-Memory Keys**: Private keys never persisted unencrypted
- **Secure Signing**: All signing happens on-device

## Project Structure

```
bapp/
├── expo-app/              # Main application code
│   ├── sources/
│   │   ├── app/           # Expo Router screens (file-based routing)
│   │   ├── components/    # Reusable UI components
│   │   ├── hooks/         # Custom React hooks
│   │   ├── utils/         # Utility functions
│   │   ├── assets/        # Images, fonts, and other assets
│   │   ├── constants/     # App constants
│   │   ├── types/         # TypeScript type definitions
│   │   ├── unistyles/     # Theme configuration
│   │   └── text/          # Internationalization (i18n)
│   ├── app.config.js      # Expo configuration
│   ├── babel.config.js    # Babel configuration
│   ├── metro.config.js    # Metro bundler configuration
│   ├── tsconfig.json      # TypeScript configuration
│   └── package.json       # Dependencies and scripts
├── package.json           # Root workspace configuration
└── README.md             # This file
```

## Technology Stack

- **Framework**: React Native 0.81.4 with Expo SDK 54
- **Language**: TypeScript 5.9.2 (strict mode)
- **Routing**: Expo Router v6 (file-based routing)
- **Styling**: React Native Unistyles 3.0.21
- **State Management**: Zustand 5.0.6
- **Navigation**: React Navigation 7
- **Package Manager**: Yarn 1.22.22

## Prerequisites

- Node.js 18+
- Yarn 1.22.22 (will be enforced by packageManager field)
- For iOS development: macOS with Xcode installed
- For Android development: Android Studio with SDK installed
- Expo CLI (will be installed via dependencies)

## Getting Started

### 1. Install Dependencies

```bash
cd bapp
yarn install
```

### 2. Add Assets

Before running the app, you need to add the required assets to `expo-app/sources/assets/images/`:

- `icon.png` (1024x1024) - App icon
- `icon-adaptive.png` (1024x1024) - Android adaptive icon
- `icon-monochrome.png` (1024x1024) - Android monochrome icon
- `icon-notification.png` (1024x1024) - Notification icon
- `favicon.png` (48x48+) - Web favicon

You can generate these using tools like [icon.kitchen](https://icon.kitchen/).

### 3. Start Development Server

```bash
cd expo-app
yarn start
```

This will start the Expo development server. You can then:
- Press `i` to open iOS simulator
- Press `a` to open Android emulator
- Press `w` to open in web browser
- Scan QR code with Expo Go app on your device

## Development Scripts

### Expo App (run from `expo-app/` directory)

```bash
# Development
yarn start              # Start Expo dev server
yarn ios                # Run on iOS simulator
yarn android            # Run on Android emulator
yarn web                # Run in web browser

# Build variants
yarn ios:dev            # iOS development build
yarn ios:preview        # iOS preview build
yarn ios:production     # iOS production build
yarn android:dev        # Android development build
yarn android:preview    # Android preview build
yarn android:production # Android production build

# Type checking and testing
yarn typecheck          # Run TypeScript type checking
yarn test               # Run tests

# Native project generation
yarn prebuild           # Generate native iOS and Android directories
```

## Project Configuration

### Environment Variants

The app supports three build variants:

- **development** - Local development with debug features
- **preview** - Testing/staging environment
- **production** - Production release

Set the variant using the `APP_ENV` environment variable:

```bash
APP_ENV=development yarn start
```

### Bundle IDs

- Development: `ai.bigt.bapp.dev`
- Preview: `ai.bigt.bapp.preview`
- Production: `ai.bigt.bapp`

Update these in `app.config.js` to match your organization.

## Building for Production

### iOS

```bash
cd expo-app
yarn ios:production
```

Or use EAS Build:

```bash
npx eas build --platform ios
```

### Android

```bash
cd expo-app
yarn android:production
```

Or use EAS Build:

```bash
npx eas build --platform android
```

### Web

```bash
cd expo-app
npx expo export:web
```

## Architecture

### File-Based Routing

This app uses Expo Router for navigation. Routes are defined by the file structure in `sources/app/`:

- `sources/app/index.tsx` - Home screen (/)
- `sources/app/settings.tsx` - Settings screen (/settings)
- `sources/app/_layout.tsx` - Root layout

### Styling with Unistyles

All styling uses React Native Unistyles for cross-platform theming:

```typescript
import { StyleSheet } from 'react-native-unistyles';

const styles = StyleSheet.create((theme) => ({
    container: {
        backgroundColor: theme.colors.surface,
        padding: theme.margins.lg,
    },
}));
```

### Internationalization

All user-facing strings use the `t()` function from `@/text`:

```typescript
import { t } from '@/text';

const title = t('home.title');
```

Add new translations in `sources/text/translations/`.

## Path Aliases

TypeScript path alias `@/*` maps to `sources/*`:

```typescript
import { t } from '@/text';
import { MyComponent } from '@/components/MyComponent';
```

## Platform Support

- ✅ iOS 14+
- ✅ Android 6.0+ (API level 23+)
- ✅ Web (modern browsers)

## License

[Your License Here]

## Contributing

[Your Contributing Guidelines Here]
