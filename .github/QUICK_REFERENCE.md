# GitHub Actions Quick Reference

## 🚀 Quick Start

### 1. Add Required Secrets

Go to **Settings → Secrets and variables → Actions** and add:

```
EXPO_TOKEN=<your-expo-token>
```

Get token:
```bash
npx expo login
npx expo whoami
```

### 2. Push Code

```bash
git add .
git commit -m "Your changes"
git push origin main
```

CI workflow runs automatically! ✅

## 📋 Common Commands

### Get Expo Token
```bash
npx expo login
npx expo token:create
```

### Test Build Locally
```bash
cd expo-app

# iOS
npm run e2e:build:ios
npm run e2e:test:ios

# Android
npm run e2e:build:android
npm run e2e:test:android

# Web
npx expo export:web
```

### Build with EAS
```bash
# Preview build
eas build --platform ios --profile preview
eas build --platform android --profile preview

# Production build
eas build --platform all --profile production
```

### Publish EAS Update
```bash
# Publish update without full build
eas update --branch production
```

## 🔄 Workflows at a Glance

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| **CI** | Push, PR | Run tests, checks |
| **Publish** | Push to main, tags | Deploy to stores |
| **Preview** | Pull Request | Preview builds |

## 🏷️ Release Process

### 1. Create Release Tag
```bash
# Version bump in package.json
cd expo-app
npm version patch  # or minor, major

# Push with tags
git push && git push --tags
```

### 2. Automatic Deployment
- Tag triggers publish workflow
- Builds all platforms
- Creates GitHub release
- Submits to stores

### 3. Monitor Progress
- Go to **Actions** tab on GitHub
- Watch workflow runs
- Download artifacts if needed

## ✅ Workflow Status

### Check Status
- **Actions Tab**: All workflow runs
- **Commit**: Green ✅ or red ❌ checkmark
- **PR**: Checks section at bottom

### View Logs
1. Go to Actions tab
2. Click workflow run
3. Click job name
4. Expand steps to see logs

## 🐛 Troubleshooting

### Build Failing?

**Check**:
1. Workflow logs for error message
2. Secrets are configured correctly
3. Dependencies are up to date

**Common fixes**:
```bash
# Update dependencies
cd expo-app
npm update

# Clear cache
npm ci

# Fix type errors
npm run typecheck
```

### Tests Failing?

**Run locally first**:
```bash
# Type check
npm run typecheck

# Unit tests
npm test

# E2E tests
npm run e2e:test:ios
```

## 📦 Artifacts

Download build artifacts from workflow runs:

1. Go to **Actions** → Workflow run
2. Scroll to **Artifacts** section
3. Click artifact name to download

**Available artifacts**:
- `web-build` - Web build files
- `*-test-results` - Test results
- `e2e-screenshots-*` - E2E screenshots

## 🔐 Security

### Protect Secrets
- ✅ Never commit secrets to code
- ✅ Use GitHub Secrets
- ✅ Rotate tokens regularly
- ✅ Use service accounts

### Branch Protection
Enable on main branch:
- Require PR reviews
- Require status checks
- Require up-to-date branches

## 🎯 Manual Workflow Trigger

### Run Workflow Manually

1. Go to **Actions** tab
2. Select workflow (e.g., "Publish App")
3. Click **Run workflow** button
4. Choose options:
   - Branch: `main`
   - Platform: `all`, `web`, `android`, `ios`
   - Profile: `production`, `preview`
5. Click **Run workflow**

### Example: Emergency Web Deploy
```
Actions → Publish App → Run workflow
  Branch: main
  Platform: web
  Profile: production
  → Run workflow
```

## 📱 Platform-Specific

### Web Only
```bash
# Workflow dispatch
Platform: web

# Or push tag
git tag web-v1.0.0
git push origin web-v1.0.0
```

### Android Only
```bash
# Workflow dispatch
Platform: android

# Manual submit
eas submit --platform android
```

### iOS Only
```bash
# Workflow dispatch
Platform: ios

# Manual submit
eas submit --platform ios
```

## 🔄 Update Workflows

### Modify Workflow
```bash
# Edit workflow file
nano .github/workflows/ci.yml

# Test in branch first
git checkout -b update-workflow
git add .github/workflows/ci.yml
git commit -m "Update workflow"
git push origin update-workflow

# Create PR to test
```

### Update Dependencies
```bash
cd expo-app
npm update
npm audit fix

# Commit and push
git add package*.json
git commit -m "Update dependencies"
git push
```

## 📊 Monitoring

### Check Build Status

**Badge in README**:
```markdown
![CI](https://github.com/username/repo/workflows/CI/badge.svg)
```

**Email notifications**:
Settings → Notifications → Actions

**Slack/Discord**:
Add webhook in workflow:
```yaml
- name: Notify
  uses: slackapi/slack-github-action@v1
  with:
    webhook: ${{ secrets.SLACK_WEBHOOK }}
```

## 💡 Tips

### Speed Up Builds
- ✅ Cache dependencies
- ✅ Run tests in parallel
- ✅ Use faster runners for simple tasks
- ✅ Skip unnecessary steps

### Save Money
- ✅ Use Ubuntu for Android (10x cheaper than macOS)
- ✅ Only run E2E tests when needed
- ✅ Use EAS Updates for small changes
- ✅ Cancel duplicate workflow runs

### Best Practices
- ✅ Test locally before pushing
- ✅ Use semantic versioning
- ✅ Write descriptive commit messages
- ✅ Review workflow logs regularly

## 🆘 Quick Fixes

### "EXPO_TOKEN not found"
```bash
# Add secret in GitHub
Settings → Secrets → New repository secret
Name: EXPO_TOKEN
Value: <your-token>
```

### "Build failed: Dependencies"
```bash
cd expo-app
rm -rf node_modules package-lock.json
npm install
git add package-lock.json
git commit -m "Fix dependencies"
git push
```

### "E2E tests timeout"
Increase timeout in workflow:
```yaml
timeout-minutes: 60  # Increase this
```

### "Service account not found"
Check `eas.json` has correct path:
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

## 📚 More Help

- Full setup: `.github/GITHUB_ACTIONS_SETUP.md`
- GitHub Actions: https://docs.github.com/actions
- EAS: https://docs.expo.dev/eas/
- Detox CI: https://wix.github.io/Detox/docs/introduction/ci-setup/

## Summary

**To deploy**:
1. Add `EXPO_TOKEN` secret
2. Push to main or create tag
3. Workflow runs automatically
4. Check Actions tab for status

**To test PR**:
1. Create PR
2. Preview workflow runs
3. Review preview builds
4. Merge when tests pass

---

**Quick Links**:
- [Full Setup Guide](./.github/GITHUB_ACTIONS_SETUP.md)
- [Workflows Directory](./.github/workflows/)
- [EAS Configuration](../expo-app/eas.json)
