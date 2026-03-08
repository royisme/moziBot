import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, beforeEach } from "vitest";
import { FlushManager } from "./flush-manager";

describe("FlushManager", () => {
  let manager: FlushManager;

  beforeEach(() => {
    manager = new FlushManager();
  });

  it("returns a flush summary when relevant messages exist", async () => {
    const config = {
      enabled: true,
      onOverflowCompaction: true,
      onNewReset: true,
      preFlushThresholdPercent: 80,
      preFlushCooldownMinutes: 0,
      maxMessages: 2,
      maxChars: 1000,
      timeoutMs: 1500,
    };

    const messages: AgentMessage[] = [
      { role: "user" as const, content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "hi there" }],
        timestamp: Date.now(),
        api: "openai-responses",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          totalTokens: 0,
          cacheWrite: 0,
          cacheRead: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
      },
    ];

    const result = await manager.flush({
      messages,
      config,
    });

    expect(result.ready).toBe(true);
    expect(result.summary).toContain("Session Flush");
    expect(result.summary).toContain("**User:** hello");
    expect(result.summary).toContain("**Assistant:** hi there");
  });

  it("respects maxMessages limit", async () => {
    const config = {
      enabled: true,
      onOverflowCompaction: true,
      onNewReset: true,
      preFlushThresholdPercent: 80,
      preFlushCooldownMinutes: 0,
      maxMessages: 1,
      maxChars: 1000,
      timeoutMs: 1500,
    };

    const messages: AgentMessage[] = [
      { role: "user" as const, content: [{ type: "text", text: "first" }], timestamp: Date.now() },
      { role: "user" as const, content: [{ type: "text", text: "second" }], timestamp: Date.now() },
    ];

    const result = await manager.flush({
      messages,
      config,
    });

    expect(result.summary).not.toContain("first");
    expect(result.summary).toContain("second");
  });

  it("returns false if disabled", async () => {
    const config = {
      enabled: false,
      onOverflowCompaction: true,
      onNewReset: true,
      preFlushThresholdPercent: 80,
      preFlushCooldownMinutes: 0,
      maxMessages: 10,
      maxChars: 1000,
      timeoutMs: 1500,
    };

    const result = await manager.flush({
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
      config,
    });

    expect(result).toEqual({ ready: false, summary: null });
  });
});
