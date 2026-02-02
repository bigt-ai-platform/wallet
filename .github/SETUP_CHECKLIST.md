# GitHub Actions Setup Checklist

Use this checklist to set up GitHub Actions for your project.

## ✅ Phase 1: Basic Setup

### Files Created
- [x] `.github/workflows/ci.yml` - CI workflow
- [x] `.github/workflows/publish.yml` - Publish workflow
- [x] `.github/workflows/preview.yml` - Preview workflow
- [x] `expo-app/eas.json` - EAS configuration
- [x] `.github/GITHUB_ACTIONS_SETUP.md` - Setup guide
- [x] `.github/QUICK_REFERENCE.md` - Quick reference
- [x] `.github/BADGES.md` - Badge templates
- [x] `.github/SETUP_CHECKLIST.md` - This checklist

### Repository Setup
- [ ] Push files to GitHub repository
- [ ] Verify workflows appear in Actions tab
- [ ] Enable Actions if disabled

## ✅ Phase 2: Essential Configuration

### Expo Setup
- [ ] Install EAS CLI: `npm install -g eas-cli`
- [ ] Login to Expo: `eas login`
- [ ] Get Expo token: `npx expo token:create`
- [ ] Copy token for GitHub Secrets

### GitHub Secrets (Required for ALL workflows)
Go to **Settings → Secrets and variables → Actions → New repository secret**

- [ ] Add `EXPO_TOKEN`
  - Value: Token from `npx expo token:create`
  - Used by: All workflows

### Test Basic Setup
- [ ] Create test branch
- [ ] Push to trigger CI workflow
- [ ] Verify CI workflow runs
- [ ] Check workflow logs for errors

## ✅ Phase 3: Web Deployment

### GitHub Pages Setup
- [ ] Go to **Settings → Pages**
- [ ] Source: Select "GitHub Actions"
- [ ] Custom domain (optional): Add your domain
- [ ] Verify Pages is enabled

### Update Configuration
- [ ] Edit `.github/workflows/publish.yml`
- [ ] Update `cname` if using custom domain (or remove line)
- [ ] Commit and push changes

### Test Web Deployment
- [ ] Push to `main` branch
- [ ] Verify publish workflow runs
- [ ] Check "publish-web" job succeeds
- [ ] Visit GitHub Pages URL
- [ ] Verify app loads correctly

## ✅ Phase 4: Android Deployment (Optional)

### Google Play Console Setup
- [ ] Go to [Google Play Console](https://play.google.com/console)
- [ ] Create app (if not exists)
- [ ] Go to **Settings → API Access**
- [ ] Create service account
- [ ] Grant permissions: "Release apps to production"
- [ ] Download JSON key file

### Add Android Secrets
- [ ] Add `GOOGLE_SERVICE_ACCOUNT_JSON`
  - Value: Content of JSON key file
  - Used by: Publish workflow (Android)

### Update EAS Configuration
- [ ] Edit `expo-app/eas.json`
- [ ] Update Android submission config:
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
- [ ] Optionally save JSON locally: `mkdir expo-app/secrets`
- [ ] Add to `.gitignore`: `expo-app/secrets/*.json`

### Test Android Build
- [ ] Run locally first: `eas build --platform android --profile production`
- [ ] Verify build succeeds on EAS
- [ ] Push to `main` to trigger workflow
- [ ] Check "publish-android" job
- [ ] Verify submission to Play Store

## ✅ Phase 5: iOS Deployment (Optional)

### Apple Developer Setup
- [ ] Go to [Apple Developer](https://developer.apple.com)
- [ ] Note your Team ID (Membership section)
- [ ] Go to [App Store Connect](https://appstoreconnect.apple.com)
- [ ] Create app (if not exists)
- [ ] Note App Store Connect App ID (App → General → App Information)

### Create App-Specific Password
- [ ] Go to [appleid.apple.com](https://appleid.apple.com)
- [ ] Sign in
- [ ] Security → App-Specific Passwords
- [ ] Generate new password
- [ ] Copy password (shown only once!)

### Add iOS Secrets
- [ ] Add `APPLE_ID`
  - Value: Your Apple Developer email
  - Used by: Publish workflow (iOS)

- [ ] Add `APPLE_APP_SPECIFIC_PASSWORD`
  - Value: App-specific password from above
  - Used by: Publish workflow (iOS)

- [ ] Add `APPLE_TEAM_ID`
  - Value: Team ID from developer.apple.com
  - Used by: Publish workflow (iOS)

- [ ] Add `ASC_APP_ID`
  - Value: App Store Connect App ID
  - Used by: Publish workflow (iOS)

### Update EAS Configuration
- [ ] Edit `expo-app/eas.json`
- [ ] Update iOS submission config:
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

### Test iOS Build
- [ ] Run locally first: `eas build --platform ios --profile production`
- [ ] Verify build succeeds on EAS
- [ ] Push to `main` to trigger workflow
- [ ] Check "publish-ios" job
- [ ] Verify submission to App Store

## ✅ Phase 6: Testing & Validation

### Test CI Workflow
- [ ] Create feature branch
- [ ] Make a small change
- [ ] Push and create PR
- [ ] Verify CI workflow runs
- [ ] Check all jobs pass:
  - [ ] Lint & Type Check
  - [ ] Unit Tests
  - [ ] Build Check
  - [ ] Security Audit

### Test Preview Workflow
- [ ] Verify preview workflow runs on PR
- [ ] Check bot comments on PR
- [ ] Download web preview artifact
- [ ] Test web preview locally
- [ ] Verify EAS Update published

### Test Publish Workflow
- [ ] Merge PR to `main`
- [ ] Verify publish workflow runs
- [ ] Check all platforms build:
  - [ ] Web deployment
  - [ ] Android build (if configured)
  - [ ] iOS build (if configured)

### Test Release Process
- [ ] Update version in `expo-app/package.json`
- [ ] Create git tag: `git tag v1.0.0`
- [ ] Push tag: `git push origin v1.0.0`
- [ ] Verify publish workflow runs
- [ ] Check GitHub Release created
- [ ] Verify release artifacts

## ✅ Phase 7: Optimization

### Branch Protection
- [ ] Go to **Settings → Branches**
- [ ] Add rule for `main` branch
- [ ] Enable:
  - [ ] Require status checks to pass
  - [ ] Require branches to be up to date
  - [ ] Require pull request reviews
  - [ ] Require linear history

### Workflow Optimization
- [ ] Review workflow run times
- [ ] Identify slow jobs
- [ ] Add caching if needed
- [ ] Consider running E2E tests only on main

### Notifications
- [ ] Go to **Settings → Notifications**
- [ ] Enable Actions notifications
- [ ] Choose notification method (email/web/mobile)
- [ ] Consider adding Slack/Discord webhook (optional)

### Documentation
- [ ] Add status badges to README
  - See `.github/BADGES.md` for templates
- [ ] Update README with deployment info
- [ ] Add contributing guidelines
- [ ] Document release process

## ✅ Phase 8: Monitoring & Maintenance

### Regular Checks
- [ ] Monitor workflow success rate
- [ ] Review failed workflows promptly
- [ ] Check artifact storage usage
- [ ] Monitor GitHub Actions minutes usage

### Maintenance Tasks
- [ ] Update Node version quarterly
- [ ] Update dependencies monthly
- [ ] Rotate secrets every 90 days
- [ ] Review and update workflows as needed

### Security
- [ ] Enable Dependabot alerts
- [ ] Enable security advisories
- [ ] Review security audit results
- [ ] Keep secrets secure and rotated

## 🎯 Quick Status Check

### Minimum Setup (Basic CI)
- [x] Workflows committed to repository
- [ ] `EXPO_TOKEN` secret added
- [ ] CI workflow running successfully

### Web Deployment
- [ ] GitHub Pages enabled
- [ ] Web deployment successful
- [ ] App accessible via Pages URL

### Mobile Deployment (Android)
- [ ] Service account created
- [ ] Secrets configured
- [ ] Android builds deploying

### Mobile Deployment (iOS)
- [ ] Apple credentials obtained
- [ ] Secrets configured
- [ ] iOS builds deploying

## 📋 Troubleshooting

If you encounter issues, check:

1. **Workflow fails to start**
   - [ ] Verify workflows are in `.github/workflows/`
   - [ ] Check YAML syntax is valid
   - [ ] Ensure Actions are enabled in repository

2. **"EXPO_TOKEN not found" error**
   - [ ] Verify secret name is exactly `EXPO_TOKEN`
   - [ ] Check secret value is correct token
   - [ ] Ensure secret is in repository (not organization)

3. **Build failures**
   - [ ] Check workflow logs for specific error
   - [ ] Test build locally first
   - [ ] Verify all dependencies are installed

4. **Deployment failures**
   - [ ] Verify platform credentials are correct
   - [ ] Check service account has proper permissions
   - [ ] Review EAS dashboard for build status

## 📚 Resources

- Setup Guide: `.github/GITHUB_ACTIONS_SETUP.md`
- Quick Reference: `.github/QUICK_REFERENCE.md`
- Badge Templates: `.github/BADGES.md`
- Expo EAS: https://docs.expo.dev/eas/
- GitHub Actions: https://docs.github.com/actions

## ✅ Completion

When all phases are complete, you'll have:
- ✅ Automated CI testing on every PR
- ✅ Preview builds for code review
- ✅ Production deployments to all platforms
- ✅ Release management with GitHub Releases
- ✅ Comprehensive monitoring and notifications

---

**Start with Phase 1-2 for basic CI, then add platforms as needed.**

**Estimated setup time**:
- Phase 1-2: 15-30 minutes (Basic CI)
- Phase 3: 10-15 minutes (Web)
- Phase 4: 20-30 minutes (Android)
- Phase 5: 20-30 minutes (iOS)
- Phase 6-8: 30-60 minutes (Testing & optimization)

**Total**: 1.5-3 hours for complete setup
