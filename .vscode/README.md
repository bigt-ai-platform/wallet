# VSCode Debug Configuration

This directory contains VSCode configuration for debugging the Bapp project.

## Prerequisites

### Required Extensions

Install these VSCode extensions (recommended in `extensions.json`):

1. **React Native Tools** (`msjsdiag.vscode-react-native`)
   - Required for React Native debugging
   - Provides launch configurations for iOS/Android

2. **Debugger for Chrome** (`msjsdiag.debugger-for-chrome`)
   - Required for web debugging
   - Allows debugging in Chrome

3. **ESLint** (`dbaeumer.vscode-eslint`)
   - Linting support

4. **Prettier** (`esbenp.prettier-vscode`)
   - Code formatting

5. **Expo Tools** (`expo.vscode-expo-tools`) - Optional but recommended
   - Expo-specific tooling and snippets

**Install all recommended extensions:**
```
Code → Preferences → Extensions → Search "Recommended"
```

### System Requirements

**For iOS:**
- macOS only
- Xcode installed
- iOS Simulator or connected device

**For Android:**
- Android Studio with SDK installed
- Android Emulator or connected device
- `adb` in PATH

**For Web:**
- Chrome or Edge browser

## Debug Configurations

### Web Debugging

#### 1. Debug Web (Chrome)
Launches Chrome and debugs the web version:
- **URL**: http://localhost:8081
- **Breakpoints**: Set in TypeScript/TSX files
- **Auto-starts**: Expo web dev server
- **DevTools**: Available in Chrome

**Usage:**
1. Press `F5` or select "Debug Web (Chrome)"
2. Wait for Metro bundler and browser to open
3. Set breakpoints in your `.tsx` files
4. Interact with app to hit breakpoints

#### 2. Debug Web (Edge)
Same as Chrome but uses Microsoft Edge browser.

### React Native Debugging

#### 3. Attach to Packager
Attaches to an already running Metro bundler:
- **Port**: 8081
- **Use when**: Metro is already running
- **Best for**: Quick re-attach without restarting

**Usage:**
1. Start Metro: `cd expo-app && yarn start`
2. Launch app on device/simulator
3. Select "Attach to Packager (React Native)"
4. Set breakpoints in your code

#### 4. Debug iOS
Launches iOS Simulator and debugs:
- **Target**: Simulator
- **Configuration**: Debug
- **Auto-builds**: Yes

**Usage:**
1. Press `F5` or select "Debug iOS"
2. Wait for build and simulator launch
3. Set breakpoints
4. Use simulator to trigger breakpoints

**Troubleshooting:**
- Ensure Xcode is installed
- Run `yarn prebuild` first if `ios/` folder doesn't exist
- Check simulator is available: `xcrun simctl list devices`

#### 5. Debug iOS (Device)
Same as Debug iOS but targets a connected device:
- **Target**: Physical iPhone/iPad
- **Requires**: Device connected via USB
- **Signing**: Xcode team/certificate required

**Usage:**
1. Connect iPhone/iPad via USB
2. Trust device in Xcode
3. Select "Debug iOS (Device)"

#### 6. Debug Android
Launches Android Emulator and debugs:
- **Target**: Emulator or device
- **Variant**: Debug
- **Auto-builds**: Yes

**Usage:**
1. Start Android Emulator or connect device
2. Press `F5` or select "Debug Android"
3. Wait for build and launch
4. Set breakpoints

**Troubleshooting:**
- Ensure Android Studio is installed
- Run `yarn prebuild` first if `android/` folder doesn't exist
- Check device: `adb devices`
- Enable USB debugging on device

#### 7. Debug Android (Device)
Same as Debug Android but specifically for physical devices:
- **Target**: Connected Android device
- **Requires**: USB debugging enabled

### Expo Go Debugging

#### 8. Debug Expo Go (iOS)
Debugs using Expo Go app (no native build needed):
- **App**: Expo Go from App Store
- **Network**: LAN connection
- **Fast**: No native build required

**Usage:**
1. Install Expo Go from App Store
2. Select "Debug Expo Go (iOS)"
3. Scan QR code with Expo Go
4. App loads and debugger attaches

#### 9. Debug Expo Go (Android)
Same as Expo Go iOS but for Android:
- **App**: Expo Go from Play Store

### Compound Configurations

#### Debug iOS + Packager
Starts both packager and iOS debugger together:
- Automatically attaches to packager
- Launches iOS simulator
- Best for full debugging setup

#### Debug Android + Packager
Same as iOS + Packager but for Android.

## Tasks

Available tasks (Command Palette → "Tasks: Run Task"):

### Development
- **Start Expo Web** - Start web dev server
- **Start Expo Dev Server** - Start Metro bundler
- **Start Expo iOS** - Launch iOS simulator
- **Start Expo Android** - Launch Android emulator

### Build
- **TypeCheck** - Run TypeScript compiler
- **Prebuild** - Generate native iOS/Android projects
- **Clean Build** - Remove all build artifacts and reinstall

### Test
- **Test** - Run Vitest tests

## Breakpoints

### Setting Breakpoints

1. **In Source Files**
   ```typescript
   // sources/app/index.tsx
   export default function HomeScreen() {
     debugger; // ← Or click in gutter
     const data = fetchData();
     console.log(data);
     return <View>...</View>;
   }
   ```

2. **Conditional Breakpoints**
   - Right-click on breakpoint
   - Select "Edit Breakpoint"
   - Add condition: `data === null`

3. **Logpoints**
   - Right-click in gutter
   - Select "Add Logpoint"
   - Enter message: `Data: {data}`

### Breakpoint Tips

- ✅ **DO**: Set breakpoints in `.tsx` and `.ts` files
- ✅ **DO**: Use conditional breakpoints for specific cases
- ❌ **DON'T**: Set breakpoints in `node_modules`
- ❌ **DON'T**: Set too many breakpoints (slows debugging)

## Debugging Tips

### Console Logging

```typescript
// Will appear in Debug Console
console.log('Value:', value);
console.warn('Warning:', warning);
console.error('Error:', error);
```

### Inspecting Variables

In Debug Console:
```javascript
> value
> typeof value
> JSON.stringify(value, null, 2)
> Object.keys(value)
```

### Call Stack

- View in Debug sidebar
- Click frames to navigate
- See variable values at each frame

### Watch Expressions

Add expressions to watch:
1. Debug sidebar → "WATCH" section
2. Click `+` to add expression
3. Example: `state.wallet.publicInfo?.address`

### Performance Profiling

For React Native:
1. Open React DevTools
2. Navigate to "Profiler"
3. Record interactions
4. Analyze component renders

## Common Issues

### "Cannot connect to Metro"

**Solution:**
```bash
cd expo-app
rm -rf .expo node_modules
yarn install
yarn start
```

### "No debugger available"

**Solution:**
1. Install React Native Tools extension
2. Reload VSCode window
3. Try again

### "Source maps not working"

**Check:**
- `sourceMaps: true` in launch config ✓
- Metro bundler is running
- Clear Metro cache: `yarn start --clear`

### iOS Simulator not found

**Solution:**
```bash
# Check available simulators
xcrun simctl list devices

# Boot a simulator
open -a Simulator

# Or install Xcode from App Store
```

### Android Emulator not starting

**Solution:**
```bash
# Check devices
adb devices

# Start emulator from Android Studio
# Or use command:
emulator -avd <device-name>
```

## Editor Settings

### Format on Save

Already configured in `settings.json`:
- Auto-format with Prettier on save
- Auto-fix ESLint issues on save

### TypeScript IntelliSense

- Uses workspace TypeScript version
- Path aliases (`@/*`) work automatically
- Import suggestions from all packages

### Path Intellisense

Auto-complete for imports:
```typescript
import { useWallet } from '@/state/wallet';
//                        ↑ Auto-completes
```

## Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|--------------|-------|
| Start Debugging | `F5` | `F5` |
| Stop Debugging | `Shift+F5` | `Shift+F5` |
| Restart Debugging | `Ctrl+Shift+F5` | `Cmd+Shift+F5` |
| Continue | `F5` | `F5` |
| Step Over | `F10` | `F10` |
| Step Into | `F11` | `F11` |
| Step Out | `Shift+F11` | `Shift+F11` |
| Toggle Breakpoint | `F9` | `F9` |
| Run Task | `Ctrl+Shift+B` | `Cmd+Shift+B` |

## Advanced Debugging

### Remote Debugging (Device)

For physical devices on same network:

1. **Find device IP**
   ```bash
   # iOS
   Settings → WiFi → (i) → IP Address

   # Android
   Settings → About → Status → IP Address
   ```

2. **Set up port forwarding**
   ```bash
   # Android
   adb reverse tcp:8081 tcp:8081

   # iOS - use same network, no forwarding needed
   ```

3. **Use "Attach to Packager" configuration**

### Chrome DevTools

For React Native:
1. Shake device to open menu
2. Select "Debug"
3. Opens Chrome with DevTools
4. Works alongside VSCode debugger

### React DevTools

```bash
# Install globally
npm install -g react-devtools

# Run
react-devtools

# In app, shake device → "Toggle Element Inspector"
```

### Network Debugging

Use Reactotron for network debugging:
```bash
npm install -g reactotron-cli
reactotron
```

## Resources

- [React Native Debugging Docs](https://reactnative.dev/docs/debugging)
- [Expo Debugging Guide](https://docs.expo.dev/debugging/runtime-issues/)
- [VSCode Debugging Docs](https://code.visualstudio.com/docs/editor/debugging)
- [React DevTools](https://react.dev/learn/react-developer-tools)

## Troubleshooting Checklist

- [ ] React Native Tools extension installed
- [ ] Metro bundler running (`yarn start`)
- [ ] Correct platform selected (iOS/Android/Web)
- [ ] Device/simulator connected
- [ ] USB debugging enabled (Android)
- [ ] Developer mode enabled (iOS)
- [ ] Correct network (same WiFi for devices)
- [ ] Breakpoints set in correct files
- [ ] Source maps enabled in launch config

## Support

If debugging isn't working:

1. Check this README
2. Restart VSCode
3. Clear Metro cache: `yarn start --clear`
4. Rebuild app: `yarn prebuild`
5. Check React Native Tools output panel

---

Happy Debugging! 🐛🔍
