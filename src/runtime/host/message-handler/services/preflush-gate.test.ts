import { describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../../../config";
import { maybePreFlushBeforePrompt } from "./preflush-gate";

function createConfig(overrides?: {
  preFlushThresholdPercent?: number;
  preFlushCooldownMinutes?: number;
}): MoziConfig {
  return {
    memory: {
      backend: "builtin",
      citations: "auto",
      persistence: {
        enabled: true,
        onOverflowCompaction: true,
        onNewReset: true,
        preFlushThresholdPercent: overrides?.preFlushThresholdPercent ?? 80,
        preFlushCooldownMinutes: overrides?.preFlushCooldownMinutes ?? 0,
        maxMessages: 12,
        maxChars: 4000,
        timeoutMs: 1000,
      },
    },
  };
}

describe("maybePreFlushBeforePrompt", () => {
  it("skips when below threshold", async () => {
    const flushMemory = vi.fn(async () => true);
    const agentManager = {
      getContextUsage: () => ({ percentage: 50 }),
      getAgent: vi.fn(async () => ({ agent: { messages: [] } })),
      getSessionMetadata: () => undefined,
      updateSessionMetadata: vi.fn(),
    };

    await maybePreFlushBeforePrompt({
      sessionKey: "s1",
      agentId: "mozi",
      config: createConfig({ preFlushThresholdPercent: 90 }),
      agentManager,
      flushMemory,
    });

    expect(flushMemory).not.toHaveBeenCalled();
    expect(agentManager.getAgent).not.toHaveBeenCalled();
  });

  it("respects preflush cooldown", async () => {
    const flushMemory = vi.fn(async () => true);
    const agentManager = {
      getContextUsage: () => ({ percentage: 95 }),
      getAgent: vi.fn(async () => ({ agent: { messages: [] } })),
      getSessionMetadata: () => ({
        memoryFlush: { trigger: "pre_overflow", lastTimestamp: Date.now() },
      }),
      updateSessionMetadata: vi.fn(),
    };

    await maybePreFlushBeforePrompt({
      sessionKey: "s1",
      agentId: "mozi",
      config: createConfig({ preFlushCooldownMinutes: 10 }),
      agentManager,
      flushMemory,
    });

    expect(flushMemory).not.toHaveBeenCalled();
  });

  it("flushes when cooldown expired", async () => {
    const flushMemory = vi.fn(async () => true);
    const agentManager = {
      getContextUsage: () => ({ percentage: 95 }),
      getAgent: vi.fn(async () => ({ agent: { messages: [{ role: "user", content: "hi" }] } })),
      getSessionMetadata: () => ({
        memoryFlush: {
          trigger: "pre_overflow",
          lastTimestamp: Date.now() - 11 * 60 * 1000,
        },
      }),
      updateSessionMetadata: vi.fn(),
    };

    await maybePreFlushBeforePrompt({
      sessionKey: "s1",
      agentId: "mozi",
      config: createConfig({ preFlushCooldownMinutes: 10 }),
      agentManager,
      flushMemory,
    });

    expect(flushMemory).toHaveBeenCalledTimes(1);
    expect(agentManager.updateSessionMetadata).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({
        memoryFlush: expect.objectContaining({ trigger: "pre_overflow" }),
      }),
    );
  });
});
