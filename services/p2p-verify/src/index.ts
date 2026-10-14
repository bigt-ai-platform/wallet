export {
  RAILS,
  parseRailEntry,
  verdictFromEntry,
  type Rail,
  type UiElement,
  type ParsedEntry,
  type VerifySpec,
} from "./extract.js";
export {
  McpGateway,
  McpHttpGateway,
  connectFromGrant,
  localMobileMcpEntry,
  parseAppsText,
  parseDevicesText,
  type DeviceApp,
  type DeviceGateway,
  type McpDevice,
  type McpGatewayOptions,
  type McpHttpGatewayOptions,
  type PairingEndpoint,
} from "./gateway.js";
export {
  canonicalJson,
  sha256Hex,
  authBase,
  didAuthHeaders,
  ed25519Signer,
  type RequestSigner,
} from "./did-auth.js";
export {
  verifyPayment,
  verifyPaymentViaNotification,
  type VerifyOptions,
  type VerifyResult,
} from "./worker.js";
export {
  detectRail,
  parseReceiptNotification,
  selectReceiptNotification,
} from "./notifications.js";
export {
  amountsMatch,
  createPayout,
  getCaptureStatus,
  paypalAccessToken,
  paypalApiBase,
  paypalConfig,
  paypalEnabled,
  verifyPaypalCapture,
  verifyWebhookSignature,
  type CaptureInfo,
  type PayPalConfig,
  type PaypalCaptureVerifyResult,
  type PayoutResult,
} from "./paypal.js";
export { parseCliArgs, main as cliMain, type CliOptions } from "./cli.js";
