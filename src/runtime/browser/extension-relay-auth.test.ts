import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import {
  deriveOpenClawRelayAuthToken,
  deriveRelayAuthToken,
  OPENCLAW_RELAY_AUTH_HEADER,
  RELAY_AUTH_HEADER,
  resolveAllValidRelayTokensForPort,
  resolveRelayAuthTokenForPort,
} from "./extension-relay-auth";

describe("extension relay auth", () => {
  it("derives deterministic relay tokens", () => {
    const token = deriveRelayAuthToken("test-relay-seed", 9222);
    const expected = createHmac("sha256", "test-relay-seed")
      .update("mozi-extension-relay-v1:9222")
      .digest("hex");
    expect(token).toBe(expected);
  });

  it("derives OpenClaw-compatible relay tokens with different context", () => {
    const moziToken = deriveRelayAuthToken("test-relay-seed", 9222);
    const openclawToken = deriveOpenClawRelayAuthToken("test-relay-seed", 9222);

    // They should be different because contexts differ
    expect(openclawToken).not.toBe(moziToken);

    // OpenClaw token should match expected HMAC
    const expectedOpenClaw = createHmac("sha256", "test-relay-seed")
      .update("openclaw-extension-relay-v1:9222")
      .digest("hex");
    expect(openclawToken).toBe(expectedOpenClaw);
  });

  it("throws when relay auth token is missing", () => {
    const config = {} as MoziConfig;
    expect(() => resolveRelayAuthTokenForPort(config, 9222)).toThrow();
  });

  it("resolveAllValidRelayTokensForPort returns both mozi and openclaw tokens", () => {
    const config = { browser: { relay: { authToken: "test-seed" } } } as MoziConfig;
    const tokens = resolveAllValidRelayTokensForPort(config, 9222);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(deriveRelayAuthToken("test-seed", 9222));
    expect(tokens[1]).toBe(deriveOpenClawRelayAuthToken("test-seed", 9222));
  });

  it("exports correct header constants", () => {
    expect(RELAY_AUTH_HEADER).toBe("x-mozibot-relay-token");
    expect(OPENCLAW_RELAY_AUTH_HEADER).toBe("x-openclaw-relay-token");
  });
});
