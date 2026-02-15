import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPromptWithCoordinator } from "./prompt-coordinator";

describe("runPromptWithCoordinator logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs redacted prompt preview and result summary", async () => {
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const agentManager = {
      getAgent: vi.fn(async () => ({
        modelRef: "quotio/gemini-3-flash-preview",
        agent: {
          prompt: vi.fn(async () => {}),
          messages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "ok result" }],
              stopReason: "stop",
            },
          ] as unknown as AgentMessage[],
        },
      })),
      getAgentFallbacks: vi.fn(() => []),
      setSessionModel: vi.fn(async () => {}),
      clearRuntimeModelOverride: vi.fn(() => {}),
      resolvePromptTimeoutMs: vi.fn(() => 30000),
      getSessionMetadata: vi.fn(() => undefined),
      updateSessionMetadata: vi.fn(() => {}),
      compactSession: vi.fn(async () => ({ success: true, tokensReclaimed: 0 })),
      updateSessionContext: vi.fn(() => {}),
      getContextUsage: vi.fn(() => ({ usedTokens: 100, totalTokens: 1000, percentage: 10 })),
    };

    await runPromptWithCoordinator({
      sessionKey: "s1",
      agentId: "mozi",
      text: "token bot12345:ABCDEF1234567890 and key sk-abcdefghijklmnopqrstuvwxyz",
      traceId: "turn:m1",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
    });

    const dispatchCall = logger.debug.mock.calls.find(
      (call) => call[1] === "Prompt dispatch summary",
    );
    expect(dispatchCall).toBeDefined();
    const dispatchPayload = dispatchCall?.[0] as Record<string, unknown>;
    expect(dispatchPayload.traceId).toBe("turn:m1");
    expect(dispatchPayload.promptPreview).toContain("bot<redacted>");
    expect(dispatchPayload.promptPreview).toContain("sk-<redacted>");
    expect(dispatchPayload.promptPreview).not.toContain("ABCDEF1234567890");

    const resultCall = logger.debug.mock.calls.find((call) => call[1] === "Prompt result summary");
    expect(resultCall).toBeDefined();
    const resultPayload = resultCall?.[0] as Record<string, unknown>;
    expect(resultPayload.traceId).toBe("turn:m1");
    expect(resultPayload.assistantRenderedChars).toBe(9);
    expect(resultPayload.stopReason).toBe("stop");
  });

  it("logs empty assistant rendered output diagnostics", async () => {
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };

    const agentManager = {
      getAgent: vi.fn(async () => ({
        modelRef: "quotio/gemini-3-flash-preview",
        agent: {
          prompt: vi.fn(async () => {}),
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "internal only" }],
              stopReason: "stop",
            },
          ] as unknown as AgentMessage[],
        },
      })),
      getAgentFallbacks: vi.fn(() => []),
      setSessionModel: vi.fn(async () => {}),
      clearRuntimeModelOverride: vi.fn(() => {}),
      resolvePromptTimeoutMs: vi.fn(() => 30000),
      getSessionMetadata: vi.fn(() => undefined),
      updateSessionMetadata: vi.fn(() => {}),
      compactSession: vi.fn(async () => ({ success: true, tokensReclaimed: 0 })),
      updateSessionContext: vi.fn(() => {}),
      getContextUsage: vi.fn(() => ({ usedTokens: 100, totalTokens: 1000, percentage: 10 })),
    };

    await runPromptWithCoordinator({
      sessionKey: "s2",
      agentId: "mozi",
      text: "hello",
      traceId: "turn:m2",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
    });

    const resultCall = logger.debug.mock.calls.find((call) => call[1] === "Prompt result summary");
    expect(resultCall).toBeDefined();
    const resultPayload = resultCall?.[0] as Record<string, unknown>;
    expect(resultPayload.assistantRenderedChars).toBe(0);

    const warnCall = logger.warn.mock.calls.find(
      (call) => call[1] === "Assistant produced empty rendered output",
    );
    expect(warnCall).toBeDefined();
    const warnPayload = warnCall?.[0] as Record<string, unknown>;
    expect(warnPayload.traceId).toBe("turn:m2");
  });
});
