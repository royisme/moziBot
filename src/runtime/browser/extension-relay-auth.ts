import { createHmac } from "node:crypto";
import type { MoziConfig } from "../../config";

const RELAY_TOKEN_CONTEXT = "mozi-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;

export const RELAY_BROWSER_NAME = "Mozi/extension-relay";
export const RELAY_AUTH_HEADER = "x-mozibot-relay-token";

export function resolveRelayAuthTokenSeed(config: MoziConfig): string | null {
  const token = config.browser?.relay?.authToken?.trim();
  return token && token.length > 0 ? token : null;
}

export function deriveRelayAuthToken(gatewayToken: string, port: number): string {
  return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

export function resolveRelayAuthTokenForPort(config: MoziConfig, port: number): string {
  const seedToken = resolveRelayAuthTokenSeed(config);
  if (!seedToken) {
    throw new Error("extension relay requires browser.relay.authToken (set in config)");
  }
  return deriveRelayAuthToken(seedToken, port);
}

export async function probeAuthenticatedRelay(params: {
  baseUrl: string;
  relayAuthHeader: string;
  relayAuthToken: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS,
  );
  try {
    const versionUrl = new URL("/json/version", `${params.baseUrl}/`).toString();
    const res = await fetch(versionUrl, {
      signal: controller.signal,
      headers: { [params.relayAuthHeader]: params.relayAuthToken },
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { Browser?: unknown };
    const browserName = typeof body?.Browser === "string" ? body.Browser.trim() : "";
    return browserName === RELAY_BROWSER_NAME;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
