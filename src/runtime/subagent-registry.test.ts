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

  it("throws error when max subagent spawn depth is reached", async () => {
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
        getAgentEntry: (id: string) => {
          // Both mozi and worker have maxDepth=1
          if (id === "mozi" || id === "worker") {
            return { subagents: { allow: ["worker"], maxDepth: 1 } };
          }
          return { subagents: { allow: ["worker"] } };
        },
        resolveSubagentPromptMode: () => "minimal",
        getAgent,
      } as never,
    );

    // First level spawn (depth 0 -> 1)
    await registry.run({
      parentSessionKey: "agent:mozi:telegram:dm:chat-1",
      parentAgentId: "mozi",
      agentId: "worker",
      prompt: "Do task",
    });

    // Second level spawn should fail (depth 1 -> 2, but maxDepth is 1)
    await expect(
      registry.run({
        parentSessionKey: "worker::agent:mozi:telegram:dm:chat-1",
        parentAgentId: "worker",
        agentId: "worker",
        prompt: "Do nested task",
      }),
    ).rejects.toThrow("Max subagent spawn depth (1) reached");
  });

  it("correctly tracks depth across nested subagent calls", async () => {
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

    // Level 0 -> 1: spawn worker as subagent of mozi (depth 1)
    await registry.run({
      parentSessionKey: "agent:mozi:telegram:dm:chat-1",
      parentAgentId: "mozi",
      agentId: "worker",
      prompt: "Do task",
    });

    // Level 1 -> 2: spawn worker as subagent of worker (depth 2, allowed since maxDepth=2)
    await registry.run({
      parentSessionKey: "worker::agent:mozi:telegram:dm:chat-1",
      parentAgentId: "worker",
      agentId: "worker",
      prompt: "Do nested task",
    });

    // Level 2 -> 3: should fail (depth 3 > maxDepth 2)
    await expect(
      registry.run({
        parentSessionKey: "worker::worker::agent:mozi:telegram:dm:chat-1",
        parentAgentId: "worker",
        agentId: "worker",
        prompt: "Do deeply nested task",
      }),
    ).rejects.toThrow("Max subagent spawn depth (2) reached");
  });

  it("uses default maxDepth of 2 when not specified", async () => {
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

    // Level 0 -> 1: allowed (depth 1)
    await registry.run({
      parentSessionKey: "session-1",
      parentAgentId: "mozi",
      agentId: "worker",
      prompt: "task 1",
    });

    // Level 1 -> 2: allowed (depth 2, maxDepth=2 means depth <= 2 is ok)
    await registry.run({
      parentSessionKey: "worker::session-1",
      parentAgentId: "worker",
      agentId: "worker",
      prompt: "task 2",
    });

    // Level 2 -> 3: should fail (depth 3 > maxDepth 2)
    await expect(
      registry.run({
        parentSessionKey: "worker::worker::session-1",
        parentAgentId: "worker",
        agentId: "worker",
        prompt: "task 3",
      }),
    ).rejects.toThrow("Max subagent spawn depth (2) reached");
  });
});
