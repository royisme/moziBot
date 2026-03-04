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

  it("accepts extension profile without cdpUrl when relay enabled with port", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension" },
        },
        defaultProfile: "chrome",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects extension profile without cdpUrl when relay not enabled", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: false, port: 9222, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension" },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some((i) => i.message.includes("browser.relay.enabled=true"))).toBe(true);
    }
  });

  it("rejects extension profile without cdpUrl when relay port not set", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension" },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some((i) => i.message.includes("browser.relay.port"))).toBe(true);
    }
  });

  it("accepts cdp profile with explicit cdpUrl", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        profiles: {
          chrome: { driver: "cdp", cdpUrl: "http://127.0.0.1:9222" },
        },
        defaultProfile: "chrome",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects cdp profile without cdpUrl", () => {
    const result = MoziConfigSchema.safeParse({
      browser: {
        profiles: {
          chrome: { driver: "cdp" },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      expect(issues.some((i) => i.message.includes("cdp driver requires cdpUrl"))).toBe(true);
    }
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

  it("rejects extension profile with mismatched relay port when cdpUrl provided", () => {
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

  it("allows extension profile without cdpUrl when relay port differs from implicit port", () => {
    // When cdpUrl is omitted, there's no port to validate against relay.port
    const result = MoziConfigSchema.safeParse({
      browser: {
        relay: { enabled: true, port: 9222, authToken: "test-token" },
        profiles: {
          chrome: { driver: "extension" },
        },
        defaultProfile: "chrome",
      },
    });

    expect(result.success).toBe(true);
  });
});
