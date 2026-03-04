import { createHmac } from "node:crypto";
import type { MoziConfig } from "../../config";

const RELAY_TOKEN_CONTEXT = "mozi-extension-relay-v1";
const OPENCLAW_RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";
const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;

export const RELAY_BROWSER_NAME = "Mozi/extension-relay";
export const RELAY_AUTH_HEADER = "x-mozibot-relay-token";
export const OPENCLAW_RELAY_AUTH_HEADER = "x-openclaw-relay-token";

export function resolveRelayAuthTokenSeed(config: MoziConfig): string | null {
  const token = config.browser?.relay?.authToken?.trim();
  return token && token.length > 0 ? token : null;
}

export function deriveRelayAuthToken(gatewayToken: string, port: number): string {
  return createHmac("sha256", gatewayToken).update(`${RELAY_TOKEN_CONTEXT}:${port}`).digest("hex");
}

/**
 * Derive OpenClaw-compatible relay token from the same seed.
 * OpenClaw uses a different HMAC context: "openclaw-extension-relay-v1:{port}"
 */
export function deriveOpenClawRelayAuthToken(gatewayToken: string, port: number): string {
  return createHmac("sha256", gatewayToken)
    .update(`${OPENCLAW_RELAY_TOKEN_CONTEXT}:${port}`)
    .digest("hex");
}

export function resolveRelayAuthTokenForPort(config: MoziConfig, port: number): string {
  const seedToken = resolveRelayAuthTokenSeed(config);
  if (!seedToken) {
    throw new Error("extension relay requires browser.relay.authToken (set in config)");
  }
  return deriveRelayAuthToken(seedToken, port);
}

/**
 * Resolve all valid relay tokens for a port.
 * Returns both Mozi and OpenClaw derived tokens from the same seed,
 * allowing clients using either format to authenticate.
 */
export function resolveAllValidRelayTokensForPort(config: MoziConfig, port: number): string[] {
  const seedToken = resolveRelayAuthTokenSeed(config);
  if (!seedToken) {
    throw new Error("extension relay requires browser.relay.authToken (set in config)");
  }
  return [deriveRelayAuthToken(seedToken, port), deriveOpenClawRelayAuthToken(seedToken, port)];
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
