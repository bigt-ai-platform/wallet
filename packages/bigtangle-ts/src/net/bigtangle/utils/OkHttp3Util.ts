// @ts-nocheck
import axios from "axios";
import type {
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import * as zlib from "zlib";
import { promisify } from "util";
import * as https from "https";
import { ObjectMapper } from "jackson-js";
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export class OkHttp3Util {
  private static readonly logger = console;
  public static readonly timeoutMinute = 45;
  private static instance: AxiosInstance;

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

      // Add request interceptor for headers and compression
      this.instance.interceptors.request.use(
        async (config: InternalAxiosRequestConfig) => {
          // Add authentication headers
          if (this.pubkey) config.headers["pubkey"] = this.pubkey;
          if (this.signHex) config.headers["signHex"] = this.signHex;
          if (this.contentHex) config.headers["contentHex"] = this.contentHex;

          // Compress request body if needed
          if (config.data && !config.headers["Content-Encoding"]) {
            // Only compress if data is not empty
            if (config.data && config.data.length > 0) {
              config.data = await gzip(config.data);
              config.headers["Content-Encoding"] = "gzip";
            } else if (
              typeof config.data === "string" &&
              config.data.length > 0
            ) {
              config.data = await gzip(new TextEncoder().encode(config.data));
              config.headers["Content-Encoding"] = "gzip";
            }
            // For empty data, we send it as-is without compression
          }

          return config;
        }
      );

      // Add response interceptor for decompression
      this.instance.interceptors.response.use(
        async (response: AxiosResponse<Uint8Array>) => {
          if (response.headers["content-encoding"] === "gzip") {
            // Convert to Buffer for browserify-zlib compatibility
            let data = response.data;
            if (data instanceof ArrayBuffer) {
              data = Buffer.from(data);
            } else if (data instanceof Uint8Array && !(data instanceof Buffer)) {
              data = Buffer.from(data);
            }
            response.data = await gunzip(data);
          }
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
    // Change return type to string
    this.logger.debug(`POST to ${url}`);

    // Handle empty data case
    let requestData = data;
    if (data && data.length === 0) {
      // For empty data, we need to ensure it's properly handled
      requestData = new Uint8Array(0);
    }

    const response = await this.getAxiosInstance().post(url, requestData);
    let responseBuffer = response.data;
    // Convert to Buffer for browserify-zlib compatibility
    if (responseBuffer instanceof ArrayBuffer) {
      responseBuffer = Buffer.from(responseBuffer);
    } else if (responseBuffer instanceof Uint8Array && !(responseBuffer instanceof Buffer)) {
      responseBuffer = Buffer.from(responseBuffer);
    }
    responseBuffer = await gunzip(responseBuffer);
    this.checkResponse(responseBuffer, url, response.status);
    return responseBuffer.toString("utf8"); // Convert to string here
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
