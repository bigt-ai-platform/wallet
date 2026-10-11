/*
 * Web-build shim for `jackson-js`.
 *
 * The real jackson-js ships as a CommonJS UMD whose interop breaks under
 * Metro (default import resolves to undefined), so the SDK classes that
 * decorate with `@JsonProperty()` fail to load in the web bundle.
 *
 * The SDK only needs jackson-js at class-load time (decorator metadata) and
 * for its own HTTP layer (`Json.jsonmapper()`), which this app does not use
 * (all app HTTP goes through `httpService` with plain fetch). So we provide
 * no-op decorators and a minimal JSON mapper here.
 */

function noopDecorator() {
  return function noop() {};
}

class JsonStringifier {
  stringify() {
    return '';
  }
}

class JsonParser {
  parse() {
    return null;
  }
}

class ObjectMapper {
  stringify(value) {
    return JSON.stringify(value);
  }
  parse(value, context) {
    const parsed = JSON.parse(value);
    // The real jackson-js instantiates `mainCreator` so the class getters
    // (getTokenindex() etc.) exist. The SDK Wallet relies on those, so mimic
    // it: construct the creator and copy the parsed fields onto the instance.
    const creator = context && typeof context.mainCreator === 'function' ? context.mainCreator() : null;
    const ctor = Array.isArray(creator) ? creator[0] : creator;
    if (typeof ctor !== 'function' || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return parsed;
    }
    const instance = new ctor();
    for (const key of Object.keys(parsed)) instance[key] = parsed[key];
    return instance;
  }
}

const impl = {
  ObjectMapper,
  JsonProperty: noopDecorator,
  JsonClassType: noopDecorator,
  JsonStringifier,
  JsonParser,
};

module.exports = impl;
module.exports.default = impl;
module.exports.__esModule = true;
