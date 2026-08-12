/*
 * Web-build shim for Node built-in modules the bigtangle-ts SDK references
 * (https/http/net/tls).
 *
 * The SDK's OkHttp3Util creates an axios instance with a custom
 * `https.Agent({ rejectUnauthorized: false })`. In the browser axios ignores
 * agent configuration (it uses the XHR adapter), but the `new https.Agent()`
 * call still runs — and Metro maps Node built-ins to empty modules on web, so
 * `https.Agent` is `undefined` and throws a TypeError on the first SDK Wallet
 * HTTP call. Provide a no-op Agent so the axios instance can be created and
 * the SDK Wallet (buyOrder/sellOrder/payOnLayer1) works in the web bundle.
 */

class Agent {
  constructor() {}
  createConnection() {
    return null;
  }
}

const impl = {
  Agent,
  globalAgent: new Agent(),
};

module.exports = impl;
module.exports.default = impl;
module.exports.__esModule = true;
