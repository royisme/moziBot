import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../config";
import { deriveRelayAuthToken, resolveRelayAuthTokenForPort } from "./extension-relay-auth";

describe("extension relay auth", () => {
  it("derives deterministic relay tokens", () => {
    const token = deriveRelayAuthToken("test-relay-seed", 9222);
    const expected = createHmac("sha256", "test-relay-seed")
      .update("mozi-extension-relay-v1:9222")
      .digest("hex");
    expect(token).toBe(expected);
  });

  it("throws when relay auth token is missing", () => {
    const config = {} as MoziConfig;
    expect(() => resolveRelayAuthTokenForPort(config, 9222)).toThrow();
  });
});
