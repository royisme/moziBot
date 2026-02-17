import { describe, expect, it, vi } from "vitest";
import { SubagentRegistry } from "./subagent-registry";

describe("SubagentRegistry", () => {
  it("uses subagent-minimal prompt mode for allowlisted subagent runs", async () => {
    const getAgent = vi.fn(async () => ({
      agent: {
        prompt: async () => {},
        state: {
          messages: [{ role: "assistant", content: "done" }],
        },
      },
    }));

    const registry = new SubagentRegistry(
      {
        get: () => ({ id: "quotio/gemini-3-flash-preview" }),
      } as never,
      {
        resolveApiKey: () => "test-key",
      } as never,
      {
        getAgentEntry: () => ({ subagents: { allow: ["worker"] } }),
        resolveSubagentPromptMode: () => "minimal",
        getAgent,
      } as never,
    );

    const result = await registry.run({
      parentSessionKey: "agent:mozi:telegram:dm:chat-1",
      parentAgentId: "mozi",
      agentId: "worker",
      prompt: "Do task",
    });

    expect(result).toBe("done");
    expect(getAgent).toHaveBeenCalledWith("worker::agent:mozi:telegram:dm:chat-1", "worker", {
      promptMode: "subagent-minimal",
    });
  });
});
