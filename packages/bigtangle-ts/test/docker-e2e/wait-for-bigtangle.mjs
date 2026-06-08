import http from "node:http";
import net from "node:net";

const contextRoot = process.env.TEST_CONTEXT_ROOT || "http://bigtangle:8088/";
const targetUrl = new URL(contextRoot);
const host = process.env.BIGTANGLE_E2E_HOST || targetUrl.hostname;
const port = Number(process.env.BIGTANGLE_E2E_PORT || targetUrl.port || 80);
const timeoutMs = Number(process.env.BIGTANGLE_E2E_TIMEOUT_MS || 300000);
const retryMs = Number(process.env.BIGTANGLE_E2E_RETRY_MS || 2000);
const startedAt = Date.now();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canConnect() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(5000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function hasHttpResponse() {
  return new Promise((resolve) => {
    const request = http.get(targetUrl, (response) => {
      response.resume();
      response.once("end", () => resolve(true));
    });
    request.setTimeout(5000, () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

while (Date.now() - startedAt < timeoutMs) {
  if ((await canConnect()) && (await hasHttpResponse())) {
    console.log(`Bigtangle server is reachable at ${contextRoot}`);
    process.exit(0);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`Waiting for Bigtangle server at ${contextRoot} (${elapsedSeconds}s elapsed)`);
  await wait(retryMs);
}

throw new Error(`Timed out waiting for Bigtangle server at ${contextRoot}`);