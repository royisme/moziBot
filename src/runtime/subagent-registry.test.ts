import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DetachedRunRegistry as SessionDetachedRunRegistry } from "./host/sessions/spawn";
import type { HostSubagentRuntime } from "./subagent-registry";
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

  it("uses resolved prompt mode for detached self subagents when agentId is omitted", async () => {
    const registryDir = mkdtempSync(path.join(os.tmpdir(), "subagent-runtime-test-"));
    const startDetachedPromptRun = vi
      .fn<HostSubagentRuntime["startDetachedPromptRun"]>()
      .mockResolvedValue({ runId: "run-self" });

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
      } as never,
      {
        sessionManager: {
          get: vi.fn(() => ({
            key: "parent-1",
            agentId: "mozi",
            channel: "telegram",
            peerId: "user-1",
            peerType: "dm",
            status: "idle",
            createdAt: new Date(),
            lastActiveAt: new Date(),
          })),
          getOrCreate: vi.fn(async (key: string, defaults: Record<string, unknown>) => ({
            key,
            agentId: (defaults.agentId as string) ?? "mozi",
            channel: (defaults.channel as string) ?? "subagent",
            peerId: (defaults.peerId as string) ?? "peer",
            peerType: (defaults.peerType as "dm" | "group") ?? "dm",
            status: (defaults.status as string) ?? "idle",
            parentKey: defaults.parentKey as string | undefined,
            metadata: defaults.metadata,
            createdAt: new Date(),
            lastActiveAt: new Date(),
          })),
        } as never,
        detachedRunRegistry: new SessionDetachedRunRegistry(registryDir),
        startDetachedPromptRun,
        isDetachedRunActive: vi.fn(() => true),
      },
    );

    try {
      await registry.spawn({
        parentSessionKey: "parent-1",
        parentAgentId: "mozi",
        prompt: "self task",
      });

      expect(startDetachedPromptRun).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "mozi",
          promptMode: "subagent-minimal",
        }),
      );
    } finally {
      (
        registry as unknown as { hostRuntime?: HostSubagentRuntime }
      ).hostRuntime?.detachedRunRegistry.shutdown();
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it("applies default detached timeout and preserves explicit timeout overrides", async () => {
    const registryDir = mkdtempSync(path.join(os.tmpdir(), "subagent-runtime-test-"));
    const detachedRunRegistry = new SessionDetachedRunRegistry(registryDir);
    const startDetachedPromptRun = vi
      .fn<HostSubagentRuntime["startDetachedPromptRun"]>()
      .mockResolvedValueOnce({ runId: "run-default" })
      .mockResolvedValueOnce({ runId: "run-explicit" });

    const sessionManager = {
      get: vi.fn(() => ({
        key: "parent-1",
        agentId: "mozi",
        channel: "telegram",
        peerId: "user-1",
        peerType: "dm",
        status: "idle",
        createdAt: new Date(),
        lastActiveAt: new Date(),
      })),
      getOrCreate: vi.fn(async (key: string, defaults: Record<string, unknown>) => ({
        key,
        agentId: (defaults.agentId as string) ?? "worker",
        channel: (defaults.channel as string) ?? "subagent",
        peerId: (defaults.peerId as string) ?? "peer",
        peerType: (defaults.peerType as "dm" | "group") ?? "dm",
        status: (defaults.status as string) ?? "idle",
        parentKey: defaults.parentKey as string | undefined,
        metadata: defaults.metadata,
        createdAt: new Date(),
        lastActiveAt: new Date(),
      })),
    };

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
      } as never,
      {
        sessionManager: sessionManager as never,
        detachedRunRegistry,
        startDetachedPromptRun,
        isDetachedRunActive: vi.fn(() => true),
      },
    );

    try {
      await registry.spawn({
        parentSessionKey: "parent-1",
        parentAgentId: "mozi",
        agentId: "worker",
        prompt: "default timeout task",
      });

      await registry.spawn({
        parentSessionKey: "parent-1",
        parentAgentId: "mozi",
        agentId: "worker",
        prompt: "explicit timeout task",
        timeoutSeconds: 42,
      });

      expect(startDetachedPromptRun.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ timeoutSeconds: 300 }),
      );
      expect(startDetachedPromptRun.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({ timeoutSeconds: 42 }),
      );
    } finally {
      detachedRunRegistry.shutdown();
      rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it("removes only the failed detached run from active tracking", async () => {
    const registryDir = mkdtempSync(path.join(os.tmpdir(), "subagent-runtime-test-"));
    const sessionManager = {
      get: vi.fn((key: string) => {
        if (key === "parent-1") {
          return {
            key,
            agentId: "mozi",
            channel: "telegram",
            peerId: "user-1",
            peerType: "dm",
            status: "idle",
            createdAt: new Date(),
            lastActiveAt: new Date(),
          };
        }
        return undefined;
      }),
      getOrCreate: vi.fn(async (key: string, defaults: Record<string, unknown>) => ({
        key,
        agentId: (defaults.agentId as string) ?? "worker",
        channel: (defaults.channel as string) ?? "subagent",
        peerId: (defaults.peerId as string) ?? "peer",
        peerType: (defaults.peerType as "dm" | "group") ?? "dm",
        status: (defaults.status as string) ?? "idle",
        parentKey: defaults.parentKey as string | undefined,
        metadata: defaults.metadata,
        createdAt: new Date(),
        lastActiveAt: new Date(),
      })),
    };
    const detachedRunRegistry = new SessionDetachedRunRegistry(registryDir);
    const startDetachedPromptRun = vi
      .fn<HostSubagentRuntime["startDetachedPromptRun"]>()
      .mockResolvedValueOnce({ runId: "run-a" })
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce({ runId: "run-c" })
      .mockResolvedValueOnce({ runId: "run-d" });

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
      } as never,
      {
        sessionManager: sessionManager as never,
        detachedRunRegistry,
        startDetachedPromptRun,
        isDetachedRunActive: vi.fn((runId: string) => runId === "run-a"),
      },
    );

    try {
      const first = await registry.spawn({
        parentSessionKey: "parent-1",
        parentAgentId: "mozi",
        agentId: "worker",
        prompt: "task a",
      });

      await expect(
        registry.spawn({
          parentSessionKey: "parent-1",
          parentAgentId: "mozi",
          agentId: "worker",
          prompt: "task b",
        }),
      ).rejects.toThrow("startup failed");

      const failedRun = detachedRunRegistry
        .listByParent("parent-1")
        .find((run) => run.task === "task b");
      expect(failedRun?.status).toBe("failed");
      expect(failedRun?.error).toBe("startup failed");

      const firstOnTerminal = startDetachedPromptRun.mock.calls[0]?.[0].onTerminal;
      await firstOnTerminal?.({ terminal: "completed" });

      const third = await registry.spawn({
        parentSessionKey: "parent-1",
        parentAgentId: "mozi",
        agentId: "worker",
        prompt: "task c",
      });
      const fourth = await registry.spawn({
        parentSessionKey: "parent-1",
        parentAgentId: "mozi",
        agentId: "worker",
        prompt: "task d",
      });

      expect(first.status).toBe("accepted");
      expect(third.status).toBe("accepted");
      expect(fourth.status).toBe("accepted");
    } finally {
      detachedRunRegistry.shutdown();
      rmSync(registryDir, { recursive: true, force: true });
    }
  });
});
