const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const config = getDefaultConfig(__dirname, {
  // Enable CSS support for web
  isCSSEnabled: true,
});

// The real jackson-js (a CJS UMD) breaks Metro's ESM interop on web, which
// makes the bigtangle-ts SDK classes (decorated with @JsonProperty) fail to
// load. Route it to a web stub: no-op decorators + a minimal JSON mapper.
const JACKSON_STUB = path.join(__dirname, "jackson-stub.js");
// Metro maps Node built-ins (https/http/net/tls) to empty modules on web, so
// the SDK Wallet's axios layer (`new https.Agent(...)`) throws a TypeError in
// the browser. Route them to a stub with a no-op Agent so the SDK Wallet HTTP
// layer (buyOrder/sellOrder/payOnLayer1) works in the web bundle.
const NODE_STUB = path.join(__dirname, "node-web-stub.js");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "jackson-js") {
    return { type: "sourceFile", filePath: JACKSON_STUB };
  }
  if (["https", "http", "net", "tls"].includes(moduleName)) {
    return { type: "sourceFile", filePath: NODE_STUB };
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Enable inlineRequires for proper Reanimated loading
config.transformer.getTransformOptions = async () => ({
  transform: {
    experimentalImportSupport: false,
    inlineRequires: true,
  },
});

module.exports = config;
