import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("Channels schema", () => {
  it("accepts allowedChats and normalizes to strings", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        telegram: {
          allowedChats: [123, "456"],
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.channels?.telegram?.allowedChats).toEqual(["123", "456"]);
  });

  it("rejects allowedUsers", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        telegram: {
          allowedUsers: [123],
        },
      },
    });

    expect(result.success).toBe(false);
  });

  it("accepts telegram policies and group overrides", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          groupPolicy: "allowlist",
          allowFrom: [1001, "alice"],
          streamMode: "partial",
          dmScope: "per-peer",
          groups: {
            "-1003504669621": {
              requireMention: false,
              allowFrom: [2002],
              agentId: "dev-pm",
            },
          },
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.data.channels?.telegram?.allowFrom).toEqual(["1001", "alice"]);
    expect(result.data.channels?.telegram?.groups?.["-1003504669621"]?.allowFrom).toEqual(["2002"]);
  });

  it("accepts per-channel DM history controls", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        telegram: {
          dmHistoryLimit: 20,
          dms: {
            "1001": { historyLimit: 5 },
          },
        },
        discord: {
          dmHistoryLimit: 15,
          dms: {
            "2002": { historyLimit: 3 },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts local desktop channel config", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        localDesktop: {
          enabled: true,
          host: "127.0.0.1",
          port: 3987,
          authToken: "local-dev-token",
          allowOrigins: ["http://127.0.0.1:5173", "tauri://localhost"],
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts telegram polling resilience config", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        telegram: {
          polling: {
            timeoutSeconds: 30,
            maxRetryTimeMs: 120000,
            retryInterval: "exponential",
            silentRunnerErrors: true,
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects invalid local desktop port", () => {
    const result = MoziConfigSchema.safeParse({
      channels: {
        localDesktop: {
          port: 70000,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
