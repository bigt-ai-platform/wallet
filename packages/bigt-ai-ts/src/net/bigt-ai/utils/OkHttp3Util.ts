// @ts-nocheck
import axios from "axios";
import type {
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import * as https from "https";
import { ObjectMapper } from "jackson-js";

/** A raw POST body exactly as it must reach the node. */
export interface BinaryTransportRequest {
  url: string;
  data: Uint8Array;
  headers: Record<string, string>;
}

/** The node's raw response body and HTTP status. */
export interface BinaryTransportResponse {
  status: number;
  data: Uint8Array;
}

export type BinaryHttpTransport = (
  request: BinaryTransportRequest
) => Promise<BinaryTransportResponse>;

export class OkHttp3Util {
  private static readonly logger = console;
  public static readonly timeoutMinute = 45;
  private static instance: AxiosInstance;

  /**
   * Optional byte-exact POST transport. Axios/XHR is correct in a browser, but
   * the Capacitor Android app runs the web export with `CapacitorHttp`
   * enabled: its native bridge decodes every `Uint8Array` body with
   * `TextDecoder` before handing it to the native layer, so all bytes that
   * are not valid UTF-8 become U+FFFD and a signed transaction arrives
   * mangled (`ProtocolException ... ArrayIndexOutOfBounds ... out of bounds
   * for byte[N]` at the node). The host app installs a transport that sends
   * the exact bytes (base64 + `dataType: 'file'`); this package stays
   * platform-independent.
   */
  private static transport: BinaryHttpTransport | null = null;

  /** Install (or, with null, clear) the byte-exact transport. */
  public static setTransport(transport: BinaryHttpTransport | null): void {
    this.transport = transport;
  }

  /** Headers sent with every request (see the axios request interceptor). */
  private static requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream; charset=utf-8",
    };
    if (this.pubkey) headers["pubkey"] = this.pubkey;
    if (this.signHex) headers["signHex"] = this.signHex;
    if (this.contentHex) headers["contentHex"] = this.contentHex;
    return headers;
  }

  private static readonly objectMapper: ObjectMapper = new ObjectMapper();
  public static readonly contextRoot: string = "";

  private static getAxiosInstance(): AxiosInstance {
    if (!this.instance) {
      // Create custom agent to bypass SSL verification
      const agent = new https.Agent({
        rejectUnauthorized: false,
      });

      this.instance = axios.create({
        httpsAgent: agent,
        timeout: this.timeoutMinute * 60 * 1000,
        responseType: "arraybuffer",
        headers: {
          "Content-Type": "application/octet-stream; charset=utf-8",
        },
      });

      // Add request interceptor for headers
      this.instance.interceptors.request.use(
        async (config: InternalAxiosRequestConfig) => {
          if (this.pubkey) config.headers["pubkey"] = this.pubkey;
          if (this.signHex) config.headers["signHex"] = this.signHex;
          if (this.contentHex) config.headers["contentHex"] = this.contentHex;
          return config;
        }
      );

      // Add response interceptor for decompression
      this.instance.interceptors.response.use(
        async (response: AxiosResponse<Uint8Array>) => {
          return response;
        }
      );
    }
    return this.instance;
  }

  public static async post(url: string, data: Uint8Array): Promise<string> {
    return   this.postStringSingle(url, data);
  }

  public static async postClass<T>(
    reqCmd: string,
    params: any,
    responseClass: new () => T // Ensure responseClass is a constructor that returns T
  ): Promise<T> {
    let dataToSend: Uint8Array;

    // If params is already a Uint8Array, use it directly
    if (params instanceof Uint8Array) {
      dataToSend = params;
    } else {
      // If params is an object, stringify it and convert to Uint8Array
      const jsonPayload = this.objectMapper.stringify(params);
      dataToSend = new TextEncoder().encode(jsonPayload);
    }

    const responseString = await OkHttp3Util.postStringSingle(
      this.contextRoot + reqCmd,
      dataToSend
    );

    try {
      // The CORRECT way to parse
      const result = this.objectMapper.parse<T>(responseString, {
        // Tell the parser the main type to use for deserialization
        mainCreator: () => [responseClass],
      });
      return result;
    } catch (error) {
      // If Jackson parsing fails, try a manual approach
      console.warn(`Jackson parsing failed for response, falling back to manual parsing:`, error);
      // Parse as generic object and return
      return JSON.parse(responseString) as T;
    }
  }
  public static async postAndGetBlock(
    url: string,
    data: string
  ): Promise<string> {
    const response = await this.postStringSingle(url, data); // Now returns string
    const json = JSON.parse(response); // Parse the string directly
    const dataHex = json.dataHex;
    return dataHex;
  }

  public static async postStringSingle(
    url: string,
    data: Uint8Array
  ): Promise<string> {
    this.logger.debug(`POST to ${url}`);

    let requestData = data;
    if (data && data.length === 0) {
      requestData = new Uint8Array(0);
    }

    if (this.transport) {
      const result = await this.transport({
        url,
        data: requestData,
        headers: this.requestHeaders(),
      });
      const responseBuffer = Buffer.from(result.data);
      this.checkResponse(responseBuffer, url, result.status);
      return responseBuffer.toString("utf8");
    }

    const response = await this.getAxiosInstance().post(url, requestData);
    let responseBuffer = response.data;
    if (responseBuffer instanceof ArrayBuffer) {
      responseBuffer = Buffer.from(responseBuffer);
    } else if (responseBuffer instanceof Uint8Array && !(responseBuffer instanceof Buffer)) {
      responseBuffer = Buffer.from(responseBuffer);
    }
    this.checkResponse(responseBuffer, url, response.status);
    return responseBuffer.toString("utf8");
  }

  private static checkResponse(
    responseData: Uint8Array,
    url: string,
    status: number
  ): void {
    if (status < 200 || status >= 300) {
      throw new Error(`Server: ${url} HTTP Error: ${status}`);
    }
    const responseString = responseData.toString("utf8");
    const result = JSON.parse(responseString);

    if (result.errorcode != null) {
      const error = Number(result.errorcode);
      if (error > 0) {
        if (result.message == null) {
          throw new Error(`Server: ${url} Server Error: ${error}`);
        } else {
          throw new Error(`Server: ${url} Server Error: ${result.message}`);
        }
      }
    }
  }
}
