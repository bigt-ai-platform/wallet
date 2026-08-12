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
    return JSON.parse(value);
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
