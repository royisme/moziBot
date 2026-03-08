import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MoziConfig } from "../../../../config";
import type { ResolvedMemoryPersistenceConfig } from "../../../../memory/backend-config";

const flushMock = vi.fn();

vi.mock("../../../../memory/flush-manager", () => ({
  FlushManager: class {
    flush = flushMock;
  },
}));

const baseConfig = {} as MoziConfig;
const persistence: ResolvedMemoryPersistenceConfig = {
  enabled: true,
  onOverflowCompaction: true,
  onNewReset: true,
  preFlushThresholdPercent: 80,
  preFlushCooldownMinutes: 0,
  maxMessages: 12,
  maxChars: 4000,
  timeoutMs: 1000,
};
const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: Date.now() }];

describe("memory flush services", () => {
  beforeEach(() => {
    flushMock.mockReset();
  });

  it("flushMemoryWithLifecycle returns readiness from FlushManager", async () => {
    flushMock.mockResolvedValue({ ready: true, summary: "summary" });
    const logger = { warn: vi.fn() };

    const { flushMemoryWithLifecycle } = await import("./memory-flush");
    const result = await flushMemoryWithLifecycle({
      config: baseConfig,
      sessionKey: "s1",
      agentId: "mozi",
      messages,
      persistence,
      logger,
    });

    expect(result).toBe(true);
    expect(flushMock).toHaveBeenCalledWith({ messages, config: persistence });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("performMemoryFlush returns readiness from FlushManager", async () => {
    flushMock.mockResolvedValue({ ready: false, summary: null });
    const logger = { warn: vi.fn() };

    const { performMemoryFlush } = await import("./preflush");
    const result = await performMemoryFlush({
      sessionKey: "s2",
      agentId: "mozi",
      messages,
      persistenceConfig: persistence,
      deps: { logger, config: baseConfig },
    });

    expect(result).toBe(false);
    expect(flushMock).toHaveBeenCalledWith({ messages, config: persistence });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns false and warns when FlushManager throws", async () => {
    flushMock.mockRejectedValue(new Error("boom"));
    const logger = { warn: vi.fn() };

    const { flushMemoryWithLifecycle } = await import("./memory-flush");
    const result = await flushMemoryWithLifecycle({
      config: baseConfig,
      sessionKey: "s3",
      agentId: "mozi",
      messages,
      persistence,
      logger,
    });

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
