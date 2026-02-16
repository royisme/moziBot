import { describe, expect, it } from "vitest";
import { resolveSessionMetadata, resolveSessionTimestamps } from "./orchestrator-session";

describe("orchestrator-session", () => {
  it("returns session timestamps from existing session", () => {
    const sessionKey = "agent:mozi:telegram:dm:1";
    const createdAt = Date.now() - 1000;
    const updatedAt = Date.now() - 10;

    const sessions = {
      get: (key: string) =>
        key === sessionKey
          ? {
              createdAt,
              updatedAt,
            }
          : undefined,
      getOrCreate: () => ({ createdAt, updatedAt }),
    };

    const result = resolveSessionTimestamps({
      sessionKey,
      sessions: sessions as never,
      agentManager: { resolveDefaultAgentId: () => "mozi" } as never,
    });

    expect(result.createdAt).toBe(createdAt);
    expect(result.updatedAt).toBe(updatedAt);
  });

  it("prefers agentManager metadata over session store metadata", () => {
    const sessionKey = "agent:mozi:telegram:dm:1";

    const result = resolveSessionMetadata({
      sessionKey,
      sessions: {
        get: () => ({ metadata: { source: "session-store" } }),
        getOrCreate: () => ({ metadata: { source: "session-store-created" } }),
      } as never,
      agentManager: {
        getSessionMetadata: () => ({ source: "agent-manager", mode: "override" }),
        resolveDefaultAgentId: () => "mozi",
      } as never,
    });

    expect(result).toEqual({ source: "agent-manager", mode: "override" });
  });
});
