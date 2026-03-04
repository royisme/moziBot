import net from "node:net";
import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay";
import {
  OPENCLAW_RELAY_AUTH_HEADER,
  RELAY_AUTH_HEADER,
  RELAY_BROWSER_NAME,
  deriveOpenClawRelayAuthToken,
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

  it("starts relay from port without cdpUrl", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;

    const relay = await ensureChromeExtensionRelayServer({ config, port });

    expect(relay.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(relay.port).toBe(port);

    // Verify it's accessible
    const token = resolveRelayAuthTokenForPort(config, port);
    const response = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [RELAY_AUTH_HEADER]: token },
    });
    expect(response.status).toBe(200);

    await stopChromeExtensionRelayServer({ port });
  });

  it("starts relay with bindHost from port", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;

    const relay = await ensureChromeExtensionRelayServer({ config, port, bindHost: "localhost" });

    expect(relay.baseUrl).toBe(`http://localhost:${port}`);
    expect(relay.host).toBe("localhost");

    const token = resolveRelayAuthTokenForPort(config, port);
    const response = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [RELAY_AUTH_HEADER]: token },
    });
    expect(response.status).toBe(200);

    await stopChromeExtensionRelayServer({ port });
  });

  it("starts relay with IPv6 bindHost ::1", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;

    const relay = await ensureChromeExtensionRelayServer({ config, port, bindHost: "::1" });

    // IPv6 should be bracketed in URLs
    expect(relay.baseUrl).toBe(`http://[::1]:${port}`);
    expect(relay.host).toBe("::1");
    expect(relay.cdpWsUrl).toBe(`ws://[::1]:${port}/cdp`);

    const token = resolveRelayAuthTokenForPort(config, port);
    const response = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [RELAY_AUTH_HEADER]: token },
    });
    expect(response.status).toBe(200);

    await stopChromeExtensionRelayServer({ port });
  });

  it("throws error when neither cdpUrl nor port provided", async () => {
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;

    await expect(ensureChromeExtensionRelayServer({ config })).rejects.toThrow(
      "extension relay requires either cdpUrl or port",
    );
  });

  it("stops relay by port", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;

    const relay = await ensureChromeExtensionRelayServer({ config, port });
    expect(relay.baseUrl).toBeDefined();

    const stopped = await stopChromeExtensionRelayServer({ port });
    expect(stopped).toBe(true);
  });

  // OpenClaw compatibility tests
  it("accepts OpenClaw token via x-openclaw-relay-token header on /json/version", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;
    const relay = await ensureChromeExtensionRelayServer({ config, port });

    // Use OpenClaw-derived token with OpenClaw header
    const openclawToken = deriveOpenClawRelayAuthToken("test-token", port);
    const response = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [OPENCLAW_RELAY_AUTH_HEADER]: openclawToken },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { Browser?: string };
    expect(payload.Browser).toBe(RELAY_BROWSER_NAME);

    await stopChromeExtensionRelayServer({ port });
  });

  it("accepts OpenClaw token via query parameter", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;
    const relay = await ensureChromeExtensionRelayServer({ config, port });

    // Use OpenClaw-derived token as query parameter
    const openclawToken = deriveOpenClawRelayAuthToken("test-token", port);
    const response = await fetch(`${relay.baseUrl}/json/version?token=${openclawToken}`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { Browser?: string };
    expect(payload.Browser).toBe(RELAY_BROWSER_NAME);

    await stopChromeExtensionRelayServer({ port });
  });

  it("accepts Mozi token via query parameter", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;
    const relay = await ensureChromeExtensionRelayServer({ config, port });

    // Use Mozi-derived token as query parameter
    const moziToken = resolveRelayAuthTokenForPort(config, port);
    const response = await fetch(`${relay.baseUrl}/json/version?token=${moziToken}`);
    expect(response.status).toBe(200);

    await stopChromeExtensionRelayServer({ port });
  });

  it("rejects invalid token", async () => {
    const port = await getFreePort();
    const config = { browser: { relay: { authToken: "test-token" } } } as MoziConfig;
    const relay = await ensureChromeExtensionRelayServer({ config, port });

    // Wrong token via header
    const response1 = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [RELAY_AUTH_HEADER]: "wrong-token" },
    });
    expect(response1.status).toBe(401);

    // Wrong token via query
    const response2 = await fetch(`${relay.baseUrl}/json/version?token=wrong-token`);
    expect(response2.status).toBe(401);

    // Token derived from different seed
    const wrongSeedToken = deriveOpenClawRelayAuthToken("different-seed", port);
    const response3 = await fetch(`${relay.baseUrl}/json/version`, {
      headers: { [OPENCLAW_RELAY_AUTH_HEADER]: wrongSeedToken },
    });
    expect(response3.status).toBe(401);

    await stopChromeExtensionRelayServer({ port });
  });
});
