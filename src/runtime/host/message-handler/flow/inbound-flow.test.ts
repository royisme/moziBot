import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageTurnContext, OrchestratorDeps } from "../contract";
import { runInboundFlow } from "./inbound-flow";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));

vi.mock("../../../hooks", () => ({
  getRuntimeHookRunner: () => hookMocks.runner,
}));

function createDeps(): OrchestratorDeps {
  return {
    config: {} as OrchestratorDeps["config"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getText: vi.fn(() => "hello"),
    getMedia: vi.fn(() => []),
    normalizeImplicitControlCommand: vi.fn((v: string) => v),
    parseCommand: vi.fn(() => null),
    parseInlineOverrides: vi.fn(() => null),
    resolveSessionContext: vi.fn(() => ({
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
      peerId: "peer-1",
      dmScope: "dm",
    })),
    rememberLastRoute: vi.fn(),
    sendDirect: vi.fn(async () => {}),
    getCommandHandlerMap: vi.fn(
      () => ({}) as OrchestratorDeps["getCommandHandlerMap"] extends () => infer R ? R : never,
    ),
    getChannel: vi.fn(() => ({ id: "telegram", send: vi.fn(async () => "out") })),
    dispatchExtensionCommand: vi.fn(async () => false),
    resetSession: vi.fn(),
    getSessionTimestamps: vi.fn(
      () =>
        ({}) as OrchestratorDeps["getSessionTimestamps"] extends (s: string) => infer R ? R : never,
    ),
    getSessionMetadata: vi.fn(() => ({})),
    updateSessionMetadata: vi.fn(),
    revertToPreviousSegment: vi.fn(() => false),
    getConfigAgents: vi.fn(() => ({})),
    transcribeInboundMessage: vi.fn(async () => undefined),
    checkInputCapability: vi.fn(async () => ({ ok: true })),
    ingestInboundMessage: vi.fn(async () => null),
    buildPromptText: vi.fn(() => ""),
    ensureChannelContext: vi.fn(async () => {}),
    startTypingIndicator: vi.fn(async () => undefined),
    emitPhaseSafely: vi.fn(async () => {}),
    createStreamingBuffer: vi.fn(() => ({
      append: vi.fn(),
      initialize: vi.fn(async () => {}),
      finalize: vi.fn(async () => null),
      getAccumulatedText: vi.fn(() => ""),
    })),
    runPromptWithFallback: vi.fn(async () => {}),
    maybePreFlushBeforePrompt: vi.fn(async () => {}),
    shouldSuppressSilentReply: vi.fn(() => false),
    shouldSuppressHeartbeatReply: vi.fn(() => false),
    dispatchReply: vi.fn(async () => "out"),
    toError: vi.fn((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
    isAbortError: vi.fn(() => false),
    createErrorReplyText: vi.fn(() => "error"),
    setSessionModel: vi.fn(async () => {}),
    stopTypingIndicator: vi.fn(async () => {}),
  };
}

function createContext(): MessageTurnContext {
  return {
    messageId: "m1",
    traceId: "turn:m1",
    type: "message",
    payload: {},
    startTime: Date.now(),
    state: {},
  };
}

describe("runInboundFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(false);
  });

  it("emits message_received hook with session context", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_received");
    const ctx = createContext();
    const deps = createDeps();

    await runInboundFlow(ctx, deps);

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:m1",
        messageId: "m1",
        text: "hello",
        mediaCount: 0,
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
      }),
    );
  });

  it("includes command metadata and media count in message_received hook", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_received");
    const ctx = createContext();
    const deps = createDeps();
    deps.getText = vi.fn(() => "/help now");
    deps.normalizeImplicitControlCommand = vi.fn(() => "normalized");
    deps.parseCommand = vi.fn(() => ({ name: "help", args: "now" }));
    deps.getMedia = vi.fn(() => [1, 2]);

    await runInboundFlow(ctx, deps);

    expect(hookMocks.runner.runMessageReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        normalizedText: "normalized",
        rawStartsWithSlash: true,
        isCommand: true,
        commandName: "help",
        commandArgs: "now",
        mediaCount: 2,
      }),
      expect.any(Object),
    );
  });
});
