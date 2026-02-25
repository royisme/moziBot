import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Browser schema", () => {
  it("accepts extension profile on loopback", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension", cdpUrl: "http://127.0.0.1:9222" },
        },
        defaultProfile: "chrome",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects non-loopback extension profile cdpUrl", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension", cdpUrl: "http://10.0.0.5:9222" },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects defaultProfile missing from profiles", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        profiles: {
          local: { driver: "cdp", cdpUrl: "http://127.0.0.1:9223" },
        },
        defaultProfile: "missing",
      },
    });

    expect(result.success).toBe(false);
  });

  it("requires relay auth token when relay enabled", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222 },
        profiles: {
          chrome: { driver: "extension", cdpUrl: "http://127.0.0.1:9222" },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-loopback relay bindHost", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222, bindHost: "0.0.0.0", authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension", cdpUrl: "http://127.0.0.1:9222" },
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects extension profile with mismatched relay port", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension", cdpUrl: "http://127.0.0.1:9333" },
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
