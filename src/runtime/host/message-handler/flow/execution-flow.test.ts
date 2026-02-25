import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageTurnContext, OrchestratorDeps, PreparedPromptBundle } from "../contract";
import { runExecutionFlow } from "./execution-flow";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageSending: vi.fn(async () => {}),
    runMessageSent: vi.fn(async () => {}),
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
    getText: vi.fn(() => ""),
    getMedia: vi.fn(() => []),
    normalizeImplicitControlCommand: vi.fn((v: string) => v),
    parseCommand: vi.fn(() => null),
    parseInlineOverrides: vi.fn(() => null),
    resolveSessionContext: vi.fn(() => ({ sessionKey: "s", agentId: "a", peerId: "p" })),
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
    emitStatusSafely: vi.fn(async () => {}),
    createStreamingBuffer: vi.fn(() => ({
      append: vi.fn(),
      initialize: vi.fn(async () => {}),
      finalize: vi.fn(async () => null),
      getAccumulatedText: vi.fn(() => ""),
    })),
    runPromptWithFallback: vi.fn(async ({ onStream }) => {
      if (onStream) {
        await onStream({ type: "agent_end", fullText: "hi" });
      }
    }),
    maybePreFlushBeforePrompt: vi.fn(async () => {}),
    shouldSuppressSilentReply: vi.fn(() => false),
    shouldSuppressHeartbeatReply: vi.fn(() => false),
    dispatchReply: vi.fn(async () => "out-1"),
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
    state: {
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
      peerId: "peer-1",
      text: "hello",
    },
  };
}

function createBundle(): PreparedPromptBundle {
  return {
    promptId: "m1",
    agentId: "mozi",
    config: {
      promptText: "hello",
      ingestPlan: null,
    },
  };
}

describe("runExecutionFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(false);
  });

  it("emits message_sent hook after dispatch", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_sent");
    const ctx = createContext();
    const deps = createDeps();

    await runExecutionFlow(ctx, deps, createBundle());

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:m1",
        messageId: "m1",
        replyText: "hi",
        outboundId: "out-1",
        channelId: "telegram",
        peerId: "peer-1",
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
      }),
    );
  });

  it("skips dispatch when message_sending cancels", async () => {
    hookMocks.runner.hasHooks.mockImplementation((name: string) => name === "message_sending");
    hookMocks.runner.runMessageSending.mockResolvedValue({ cancel: true });
    const ctx = createContext();
    const deps = createDeps();
    const dispatchReply = vi.spyOn(deps, "dispatchReply");

    await runExecutionFlow(ctx, deps, createBundle());

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
  });
});
