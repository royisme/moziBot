/**
 * dual-write.test.ts
 *
 * Verifies that recordTurnToTape() is correctly called in the prompt-coordinator
 * flow. Tape is now the sole persistence path for session history.
 *
 * We test this by:
 *  1. Calling runPromptWithCoordinator with a mock agentManager that
 *     provides a real TapeService via getTapeService().
 *  2. After the call, asserting that the tape contains the expected user +
 *     assistant messages.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { runPromptWithCoordinator } from "../runtime/host/message-handler/services/prompt-coordinator.js";
import { createTapeService } from "./integration.js";
import { TapeStore } from "./tape-store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTapeStore(tempDir: string): TapeStore {
  return new TapeStore(tempDir, "/test/workspace");
}

function makeAssistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  } as unknown as AgentMessage;
}

function makeAgentManager(
  messages: AgentMessage[],
  tapeServiceFn?: (sessionKey: string) => ReturnType<typeof createTapeService> | null,
) {
  return {
    getAgent: vi.fn(async () => ({
      modelRef: "test/model",
      agent: {
        prompt: vi.fn(async () => {}),
        messages,
      },
    })),
    getAgentFallbacks: vi.fn(() => []),
    setSessionModel: vi.fn(async () => {}),
    clearRuntimeModelOverride: vi.fn(() => {}),
    resolvePromptTimeoutMs: vi.fn(() => 30000),
    getSessionMetadata: vi.fn(() => undefined),
    updateSessionMetadata: vi.fn(() => {}),
    compactSession: vi.fn(async () => ({ success: true, tokensReclaimed: 0 })),
    getContextUsage: vi.fn(() => ({ usedTokens: 100, totalTokens: 1000, percentage: 10 })),
    getTapeService: tapeServiceFn ?? vi.fn(() => null),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tape write in prompt-coordinator", () => {
  let tempDir: string;
  let tapeStore: TapeStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tape-dual-write-test-"));
    tapeStore = makeTapeStore(tempDir);
    vi.clearAllMocks();
  });

  it("records user + assistant messages to tape on successful turn", async () => {
    const tapeService = createTapeService(tapeStore, "session:s1");
    const messages = [makeAssistantMessage("Hello from assistant")];
    const agentManager = makeAgentManager(messages, () => tapeService);

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: "s1",
      agentId: "test-agent",
      text: "Hello from user",
      traceId: "trace-1",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
    });

    const entries = tapeService.readAll()!;
    const messageEntries = entries.filter((e) => e.kind === "message");

    // Should have user + assistant messages
    expect(messageEntries.length).toBeGreaterThanOrEqual(2);

    const userEntry = messageEntries.find((e) => e.payload.role === "user");
    expect(userEntry).toBeDefined();
    expect(userEntry!.payload.content).toBe("Hello from user");

    const assistantEntry = messageEntries.find((e) => e.payload.role === "assistant");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry!.payload.content).toBe("Hello from assistant");
  });

  it("records to tape when getTapeService returns a service", async () => {
    const tapeService = createTapeService(tapeStore, "session:s2");
    const messages = [makeAssistantMessage("Response text")];
    const agentManager = makeAgentManager(messages, () => tapeService);

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: "s2",
      agentId: "test-agent",
      text: "User query",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
    });

    // Tape should have been written
    const entries = tapeService.readAll()!;
    const messageEntries = entries.filter((e) => e.kind === "message");
    expect(messageEntries.length).toBeGreaterThanOrEqual(1);
  });

  it("does not record to tape when getTapeService returns null", async () => {
    const messages = [makeAssistantMessage("Response text")];
    const agentManager = makeAgentManager(messages, () => null);

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: "s3",
      agentId: "test-agent",
      text: "User query",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => null,
    });

    // No tape warning should be emitted
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      "Tape dual-write failed (non-fatal)",
    );
  });

  it("does not record to tape when getTapeService is not provided", async () => {
    const messages = [makeAssistantMessage("Response text")];
    const agentManager = makeAgentManager(messages);

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: "s4",
      agentId: "test-agent",
      text: "User query",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      // getTapeService deliberately omitted
    });

    // No tape errors should be logged
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("continues normally when tape write throws (non-fatal)", async () => {
    const messages = [makeAssistantMessage("Response text")];
    const agentManager = makeAgentManager(messages);

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    const brokenTapeService = {
      appendMessage: vi.fn(() => {
        throw new Error("disk full");
      }),
      appendToolCall: vi.fn(),
      appendToolResult: vi.fn(),
      appendEvent: vi.fn(),
      appendSystem: vi.fn(),
      handoff: vi.fn(),
      ensureBootstrapAnchor: vi.fn(),
      forkTape: vi.fn(),
      mergeFork: vi.fn(),
      info: vi.fn(() => ({
        name: "x",
        entries: 0,
        anchors: 0,
        lastAnchor: null,
        entriesSinceLastAnchor: 0,
      })),
      anchors: vi.fn(() => []),
      fromLastAnchor: vi.fn(() => []),
      betweenAnchors: vi.fn(() => []),
      afterAnchor: vi.fn(() => []),
      search: vi.fn(() => []),
      readAll: vi.fn(() => null),
    };

    // Should not throw even though tape service fails
    await expect(
      runPromptWithCoordinator({
        sessionKey: "s5",
        agentId: "test-agent",
        text: "User query",
        config: {} as never,
        logger,
        agentManager,
        activeMap: new Map(),
        interruptedSet: new Set(),
        flushMemory: async () => true,
        getTapeService: () => brokenTapeService as never,
      }),
    ).resolves.toBeUndefined();

    // A warning should have been logged for the tape failure
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "s5" }),
      "Tape dual-write failed (non-fatal)",
    );
  });

  it("includes meta (sessionKey, agentId, modelRef) in tape entries", async () => {
    const tapeService = createTapeService(tapeStore, "session:s6");
    const messages = [makeAssistantMessage("OK")];
    const agentManager = makeAgentManager(messages, () => tapeService);

    const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };

    await runPromptWithCoordinator({
      sessionKey: "s6",
      agentId: "my-agent",
      text: "Query",
      traceId: "trace-6",
      config: {} as never,
      logger,
      agentManager,
      activeMap: new Map(),
      interruptedSet: new Set(),
      flushMemory: async () => true,
      getTapeService: () => tapeService,
    });

    const entries = tapeService.readAll()!;
    const userEntry = entries.find((e) => e.kind === "message" && e.payload.role === "user");
    expect(userEntry).toBeDefined();
    expect(userEntry!.meta.sessionKey).toBe("s6");
    expect(userEntry!.meta.agentId).toBe("my-agent");
    expect(userEntry!.meta.modelRef).toBe("test/model");
    expect(userEntry!.meta.traceId).toBe("trace-6");
  });
});
