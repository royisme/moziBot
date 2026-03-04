import { describe, expect, it } from "vitest";
import { MoziConfigSchema } from "./index";

describe("ACP schema defaults", () => {
  it("applies ACP defaults when acp block exists", () => {
    const parsed = MoziConfigSchema.parse({ acp: {} });
    expect(parsed.acp?.enabled).toBe(true);
    expect(parsed.acp?.dispatch?.enabled).toBe(false);
    expect(parsed.acp?.allowedAgents).toEqual([]);
    expect(parsed.acp?.runtime?.ttlMinutes).toBe(0);
  });

  it("keeps explicit values", () => {
    const parsed = MoziConfigSchema.parse({
      acp: {
        enabled: false,
        dispatch: { enabled: true },
        allowedAgents: ["main"],
        runtime: { ttlMinutes: 15 },
      },
    });

    expect(parsed.acp?.enabled).toBe(false);
    expect(parsed.acp?.dispatch?.enabled).toBe(true);
    expect(parsed.acp?.allowedAgents).toEqual(["main"]);
    expect(parsed.acp?.runtime?.ttlMinutes).toBe(15);
  });

  it("accepts legacy acp.dispatchEnabled when dispatch block omitted", () => {
    const parsed = MoziConfigSchema.parse({
      acp: {
        dispatchEnabled: true,
      },
    });
    expect(parsed.acp?.dispatchEnabled).toBe(true);
  });

  it("rejects conflicting dispatchEnabled and dispatch.enabled", () => {
    const result = MoziConfigSchema.safeParse({
      acp: {
        dispatchEnabled: false,
        dispatch: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative ttlMinutes", () => {
    const result = MoziConfigSchema.safeParse({
      acp: {
        runtime: { ttlMinutes: -1 },
      },
    });
    expect(result.success).toBe(false);
  });
});
