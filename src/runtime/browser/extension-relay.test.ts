import net from "node:net";
import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay";
import {
  RELAY_AUTH_HEADER,
  RELAY_BROWSER_NAME,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth";

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) {
          resolve(address.port);
        } else {
          reject(new Error("Failed to resolve port"));
        }
      });
    });
  });
}

describe("extension relay server", () => {
  it("requires auth for /json/version", async () => {
    const port = await getFreePort();
    const cdpUrl = `http://127.0.0.1:${port}`;
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;
    const relay = await ensureChromeExtensionRelayServer({ cdpUrl, config });

    const unauthorized = await fetch(`${relay.baseUrl}/json/version`);
    expect(unauthorized.status).toBe(401);

    const token = resolveRelayAuthTokenForPort(config, port);
    const authorized = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [RELAY_AUTH_HEADER]: token },
    });
    expect(authorized.status).toBe(200);
    const payload = (await authorized.json()) as { Browser?: string };
    expect(payload.Browser).toBe(RELAY_BROWSER_NAME);

    await stopChromeExtensionRelayServer({ cdpUrl });
  });
});
