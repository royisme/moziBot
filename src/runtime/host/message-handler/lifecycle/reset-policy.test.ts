import { describe, expect, it } from "vitest";
import type { MoziConfig } from "../../../../config";
import {
  computeDailyResetBoundaryMs,
  resolveSessionResetPolicy,
  resolveSessionType,
  shouldRotateSessionForResetPolicy,
} from "./reset-policy";

describe("reset policy", () => {
  it("returns null when no reset config is provided", () => {
    const policy = resolveSessionResetPolicy({
      config: {} as MoziConfig,
      sessionType: "direct",
      channelId: "telegram",
    });
    expect(policy).toBeNull();
  });

  it("resolves session type with thread priority", () => {
    expect(resolveSessionType({ peerType: "dm", threadId: "t1" })).toBe("thread");
    expect(resolveSessionType({ peerType: "dm" })).toBe("direct");
    expect(resolveSessionType({ peerType: "group" })).toBe("group");
  });

  it("rotates for daily boundary", () => {
    const now = new Date(2026, 1, 23, 10, 0, 0).getTime();
    const boundary = computeDailyResetBoundaryMs(now, 4);
    const policy = { mode: "daily" as const, atHour: 4 };
    const shouldRotate = shouldRotateSessionForResetPolicy(
      policy,
      {
        createdAt: boundary - 5 * 60 * 1000,
        updatedAt: boundary - 5 * 60 * 1000,
      },
      now,
    );
    expect(shouldRotate).toBe(true);
  });

  it("rotates for idle-only policy", () => {
    const now = new Date(2026, 1, 23, 10, 0, 0).getTime();
    const policy = { mode: "idle" as const, atHour: 4, idleMinutes: 30 };
    const shouldRotate = shouldRotateSessionForResetPolicy(
      policy,
      {
        createdAt: now - 40 * 60 * 1000,
        updatedAt: now - 40 * 60 * 1000,
      },
      now,
    );
    expect(shouldRotate).toBe(true);
  });

  it("prefers channel-specific reset policies", () => {
    const config = {
      session: {
        reset: { mode: "daily", atHour: 4 },
        resetByType: {
          direct: { mode: "idle", idleMinutes: 120 },
        },
        resetByChannel: {
          telegram: { mode: "idle", idleMinutes: 5 },
        },
      },
    } as MoziConfig;

    const policy = resolveSessionResetPolicy({
      config,
      sessionType: "direct",
      channelId: "telegram",
    });

    expect(policy).not.toBeNull();
    expect(policy?.mode).toBe("idle");
    expect(policy?.idleMinutes).toBe(5);
  });
});
