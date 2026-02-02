# Status Badges for README

Add these badges to your README.md to show build status:

## CI Status

```markdown
![CI](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/CI%20-%20Test%20%26%20Lint/badge.svg)
```

## Publish Status

```markdown
![Publish](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Publish%20App%20(Web,%20Android,%20iOS)/badge.svg)
```

## Combined Badges

```markdown
[![CI](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/CI%20-%20Test%20%26%20Lint/badge.svg)](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/ci.yml)
[![Publish](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Publish%20App%20(Web,%20Android,%20iOS)/badge.svg)](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/publish.yml)
```

## Platform-Specific Badges

### Web
```markdown
[![Deploy Web](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Publish%20App%20(Web,%20Android,%20iOS)/badge.svg)](https://your-app-url.github.io)
```

### Android
```markdown
[![Google Play](https://img.shields.io/badge/Google%20Play-Download-green?logo=google-play)](https://play.google.com/store/apps/details?id=YOUR_APP_ID)
```

### iOS
```markdown
[![App Store](https://img.shields.io/badge/App%20Store-Download-blue?logo=apple)](https://apps.apple.com/app/YOUR_APP_ID)
```

## Version Badge

```markdown
![Version](https://img.shields.io/github/v/tag/YOUR_USERNAME/YOUR_REPO?label=version)
```

## License Badge

```markdown
![License](https://img.shields.io/github/license/YOUR_USERNAME/YOUR_REPO)
```

## Full Example README Section

```markdown
# BigTangle Mobile App

[![CI](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/CI%20-%20Test%20%26%20Lint/badge.svg)](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/ci.yml)
[![Publish](https://github.com/YOUR_USERNAME/YOUR_REPO/workflows/Publish%20App%20(Web,%20Android,%20iOS)/badge.svg)](https://github.com/YOUR_USERNAME/YOUR_REPO/actions/workflows/publish.yml)
![Version](https://img.shields.io/github/v/tag/YOUR_USERNAME/YOUR_REPO?label=version)

A mobile blockchain wallet application built with React Native and Expo.

## Download

- [🌐 Web App](https://your-app-url.github.io)
- [🤖 Google Play](https://play.google.com/store/apps/details?id=YOUR_APP_ID)
- [🍎 App Store](https://apps.apple.com/app/YOUR_APP_ID)

## Build Status

| Platform | Status |
|----------|--------|
| Web | ✅ Deployed to GitHub Pages |
| Android | ✅ Available on Google Play |
| iOS | ✅ Available on App Store |

## Development

See [Contributing Guide](CONTRIBUTING.md) for development setup.

## License

MIT License - see [LICENSE](LICENSE) file.
```

## Custom Badges

### Test Coverage
```markdown
![Coverage](https://img.shields.io/codecov/c/github/YOUR_USERNAME/YOUR_REPO)
```

### Dependencies
```markdown
![Dependencies](https://img.shields.io/librariesio/github/YOUR_USERNAME/YOUR_REPO)
```

### Last Commit
```markdown
![Last Commit](https://img.shields.io/github/last-commit/YOUR_USERNAME/YOUR_REPO)
```

### Contributors
```markdown
![Contributors](https://img.shields.io/github/contributors/YOUR_USERNAME/YOUR_REPO)
```

## Instructions

1. Replace `YOUR_USERNAME` with your GitHub username
2. Replace `YOUR_REPO` with your repository name
3. Replace `YOUR_APP_ID` with your actual app IDs
4. Add badges to top of README.md
5. Commit and push changes

## Preview

Before committing, verify badges work:
1. Copy badge markdown
2. Paste into GitHub Gist
3. Preview to ensure they render correctly
4. Update URLs if needed

---

**Tip**: Use shields.io for custom badges: https://shields.io
