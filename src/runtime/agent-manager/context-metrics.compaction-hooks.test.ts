import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SessionStore } from "../session-store";
import { compactSession } from "./context-metrics";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runBeforeCompaction: vi.fn(async () => {}),
    runAfterCompaction: vi.fn(async () => {}),
  },
}));

vi.mock("../hooks", () => ({
  getRuntimeHookRunner: () => hookMocks.runner,
}));

describe("compactSession hook wiring", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runBeforeCompaction.mockClear();
    hookMocks.runner.runAfterCompaction.mockClear();
  });

  it("emits before_compaction and after_compaction hooks", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    const sessionKey = "agent:mozi:telegram:dm:chat-1";
    const agent = {
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }, {}, {}],
      compact: vi.fn(async () => ({ tokensBefore: 100 })),
    } as unknown as AgentSession;

    const sessions = {
      get: vi.fn(() => ({ agentId: "mozi", latestSessionFile: "/tmp/session.jsonl" })),
      update: vi.fn(),
    } as unknown as SessionStore;

    const result = await compactSession({
      sessionKey,
      agents: new Map([[sessionKey, agent]]),
      sessions,
    });

    expect(result.success).toBe(true);
    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 4,
        compactingCount: 4,
        sessionFile: "/tmp/session.jsonl",
      }),
      expect.objectContaining({
        sessionKey,
        agentId: "mozi",
      }),
    );
    expect(hookMocks.runner.runAfterCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        messageCount: 4,
        compactedCount: 0,
      }),
      expect.objectContaining({
        sessionKey,
        agentId: "mozi",
      }),
    );
  });
});
