const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// Enable inlineRequires for proper Reanimated loading
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
