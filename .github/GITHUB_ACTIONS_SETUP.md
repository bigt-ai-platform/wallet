# GitHub Actions CI/CD Setup Guide

## Overview

This project uses GitHub Actions for continuous integration and deployment across three platforms:
- **Web**: Expo web build deployed to GitHub Pages
- **Android**: APK/AAB builds submitted to Google Play
- **iOS**: IPA builds submitted to App Store

## Workflows

### 1. CI Workflow (`ci.yml`)

**Trigger**: Push to `main`/`develop`, Pull Requests

**Jobs**:
- ✅ Lint & Type Check
- ✅ Unit Tests
- ✅ E2E Tests (iOS)
- ✅ E2E Tests (Android)
- ✅ API Tests
- ✅ Build Check
- ✅ Security Audit

**Purpose**: Validates all code changes before merge.

### 2. Publish Workflow (`publish.yml`)

**Trigger**: Push to `main`, tags `v*`, manual dispatch

**Jobs**:
- 🌐 Publish Web → GitHub Pages
- 🤖 Publish Android → Google Play
- 🍎 Publish iOS → App Store
- 📦 Create GitHub Release
- 📢 Notify Status

**Purpose**: Deploys production builds to all platforms.

### 3. Preview Workflow (`preview.yml`)

**Trigger**: Pull Requests

**Jobs**:
- 🌐 Preview Web Build
- 📱 Preview Mobile (EAS Update)
- 🧪 Quick Tests

**Purpose**: Creates preview builds for PR review.

## Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

### Essential Secrets

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `EXPO_TOKEN` | Expo authentication token | `npx expo login && npx expo whoami` |
| `GITHUB_TOKEN` | GitHub access token | Automatically provided |

### Android Secrets (for Play Store submission)

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Play service account | Google Play Console → API Access |

### iOS Secrets (for App Store submission)

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `APPLE_ID` | Apple ID email | Your Apple Developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password | appleid.apple.com → Security |
| `APPLE_TEAM_ID` | Apple Team ID | Apple Developer → Membership |
| `ASC_APP_ID` | App Store Connect App ID | App Store Connect → App → General |

## Setup Instructions

### Step 1: Configure Expo

1. Install EAS CLI:
```bash
npm install -g eas-cli
```

2. Login to Expo:
```bash
cd expo-app
eas login
```

3. Configure EAS:
```bash
eas build:configure
```

### Step 2: Get Expo Token

```bash
npx expo whoami
npx expo token:create --non-interactive
```

Copy the token and add it to GitHub Secrets as `EXPO_TOKEN`.

### Step 3: Configure Android

1. Create a service account in Google Play Console:
   - Go to **Google Play Console** → **Settings** → **API Access**
   - Create a new service account
   - Grant permissions: **Release apps to production**
   - Download JSON key

2. Add to project:
```bash
mkdir -p expo-app/secrets
# Copy your JSON file to expo-app/secrets/google-service-account.json
```

3. Add JSON content to GitHub Secret `GOOGLE_SERVICE_ACCOUNT_JSON`

4. Update `eas.json`:
```json
{
  "submit": {
    "production": {
      "android": {
        "serviceAccountKeyPath": "./secrets/google-service-account.json"
      }
    }
  }
}
```

### Step 4: Configure iOS

1. Get your credentials:
   - **Apple ID**: Your Apple Developer email
   - **Team ID**: developer.apple.com → Membership
   - **ASC App ID**: App Store Connect → Your App → General → App Information

2. Create app-specific password:
   - Go to appleid.apple.com
   - Sign in
   - Security → App-Specific Passwords
   - Generate new password

3. Update `eas.json`:
```json
{
  "submit": {
    "production": {
      "ios": {
        "appleId": "your-email@example.com",
        "ascAppId": "1234567890",
        "appleTeamId": "ABCD123456"
      }
    }
  }
}
```

4. Add secrets to GitHub:
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`
   - `ASC_APP_ID`

### Step 5: Configure GitHub Pages (Web)

1. Go to **Settings → Pages**
2. Source: **GitHub Actions**
3. Custom domain (optional): Add your domain

Update `publish.yml` with your domain:
```yaml
- name: Deploy to GitHub Pages
  uses: peaceiris/actions-gh-pages@v3
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: ./expo-app/web-build
    cname: your-domain.com  # Optional
```

### Step 6: Test Workflows

1. **Test CI**: Create a PR
```bash
git checkout -b test-ci
git push origin test-ci
# Create PR on GitHub
```

2. **Test Preview**: PR will trigger preview builds

3. **Test Publish**: Merge to main or create a tag
```bash
git tag v1.0.0
git push origin v1.0.0
```

## Workflow Triggers

### CI Workflow
```yaml
on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]
```

### Publish Workflow
```yaml
on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:  # Manual trigger
```

### Preview Workflow
```yaml
on:
  pull_request:
    branches: [main, develop]
```

## Manual Workflow Dispatch

Run workflows manually from GitHub Actions tab:

1. Go to **Actions** tab
2. Select workflow (e.g., "Publish App")
3. Click **Run workflow**
4. Choose options:
   - Platform: `all`, `web`, `android`, or `ios`
   - Profile: `production` or `preview`

## Build Profiles

Defined in `eas.json`:

### Development
- Local development builds
- Debug mode
- Fast builds

### Preview
- Internal testing
- APK for Android
- Simulator builds for iOS

### Production
- App store releases
- AAB for Android
- Optimized builds

## Troubleshooting

### Build Failures

**Issue**: Build fails with "EXPO_TOKEN not found"
**Solution**: Add `EXPO_TOKEN` to GitHub Secrets

**Issue**: Android build fails with "Service account not found"
**Solution**: Check `google-service-account.json` path in `eas.json`

**Issue**: iOS build fails with "Invalid credentials"
**Solution**: Verify Apple ID and app-specific password

### E2E Test Failures

**Issue**: iOS simulator not found
**Solution**: Check simulator name in workflow matches available simulators

**Issue**: Android emulator fails to start
**Solution**: Increase timeout or use different API level

### Deploy Failures

**Issue**: GitHub Pages deploy fails
**Solution**: Enable GitHub Pages in repository settings

**Issue**: Play Store submission fails
**Solution**: Check service account permissions in Google Play Console

## Monitoring Builds

### View Build Status

1. **GitHub Actions Tab**: See all workflow runs
2. **Pull Request Checks**: See checks in PR
3. **Commit Status**: See status badges on commits

### Artifacts

Workflows create artifacts:
- **Web builds**: `web-build` artifact
- **Test results**: `*-test-results` artifacts
- **Screenshots**: `e2e-screenshots-*` artifacts

Download from workflow run page.

### Notifications

Configure notifications:
1. Go to **Settings → Notifications**
2. Enable **Actions** notifications
3. Choose: email, web, or mobile

## Best Practices

### 1. Branch Protection

Enable branch protection on `main`:
- Require status checks to pass
- Require review before merge
- Require up-to-date branches

### 2. Secrets Management

- Never commit secrets to repository
- Rotate secrets regularly
- Use service accounts for automation

### 3. Build Optimization

- Cache dependencies
- Use appropriate runners (Ubuntu for Android, macOS for iOS)
- Run tests in parallel where possible

### 4. Version Management

Use semantic versioning for releases:
```bash
# Patch release (1.0.0 → 1.0.1)
git tag v1.0.1

# Minor release (1.0.0 → 1.1.0)
git tag v1.1.0

# Major release (1.0.0 → 2.0.0)
git tag v2.0.0

git push origin --tags
```

## Cost Optimization

### GitHub Actions Minutes

- **Ubuntu runners**: 1x multiplier
- **macOS runners**: 10x multiplier
- **Windows runners**: 2x multiplier

**Tips**:
- Use Ubuntu for Android (cheaper)
- Only run iOS tests when necessary
- Use matrix builds efficiently
- Cache dependencies

### EAS Builds

Free tier includes limited builds per month. Optimize:
- Use EAS Updates for OTA changes (doesn't count as build)
- Run full builds only on production releases
- Use preview builds for testing

## Updating Workflows

### Modify Workflows

1. Edit workflow files in `.github/workflows/`
2. Test changes in a branch first
3. Verify workflow runs successfully
4. Merge to main

### Add New Jobs

```yaml
new-job:
  name: New Job Name
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Run task
      run: echo "Hello"
```

### Update Node Version

Update `NODE_VERSION` in workflows:
```yaml
env:
  NODE_VERSION: '20'  # Update this
```

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Expo EAS Build](https://docs.expo.dev/build/introduction/)
- [Expo EAS Submit](https://docs.expo.dev/submit/introduction/)
- [Detox CI Configuration](https://wix.github.io/Detox/docs/introduction/ci-setup/)

## Support

For issues with:
- **GitHub Actions**: Check workflow logs
- **EAS Builds**: Check EAS dashboard
- **App Store/Play Store**: Check respective consoles

## Summary

✅ **CI Workflow**: Runs tests on every PR
✅ **Publish Workflow**: Deploys to production
✅ **Preview Workflow**: Creates preview builds for PRs

All workflows are configured and ready to use once secrets are added.

---

**Last Updated**: 2026-02-02
**Status**: Ready for production
