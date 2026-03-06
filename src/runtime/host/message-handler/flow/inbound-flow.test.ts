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
  const resolvedContext: ReturnType<OrchestratorDeps["resolveSessionContext"]> = {
    sessionKey: "agent:mozi:telegram:dm:chat-1",
    agentId: "mozi",
    peerId: "peer-1",
    dmScope: "main",
    route: {
      channelId: "telegram",
      peerId: "peer-1",
      peerType: "dm",
    },
  };

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
    resolveSessionContext: vi.fn(() => resolvedContext),
    rememberLastRoute: vi.fn(),
    sendDirect: vi.fn(async () => {}),
    getCommandHandlerMap: vi.fn(
      () => ({}) as OrchestratorDeps["getCommandHandlerMap"] extends () => infer R ? R : never,
    ),
    getChannel: vi.fn(() => ({ id: "telegram", send: vi.fn(async () => "out") })),
    dispatchExtensionCommand: vi.fn(async () => false),
    interruptSession: vi.fn(async () => false),
    performSessionReset: vi.fn(async () => {}),
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
    createStreamingBuffer: vi.fn(
      () =>
        ({
          append: vi.fn(),
          initialize: vi.fn(async () => {}),
          finalize: vi.fn(async () => null),
          getAccumulatedText: vi.fn(() => ""),
        }) as unknown as ReturnType<OrchestratorDeps["createStreamingBuffer"]>,
    ),
    runPromptWithFallback: vi.fn(async () => {}),
    maybePreFlushBeforePrompt: vi.fn(async () => {}),
    shouldSuppressSilentReply: vi.fn(() => false),
    shouldSuppressHeartbeatReply: vi.fn(() => false),
    dispatchReply: vi.fn(async () => "out"),
    toError: vi.fn((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
    isAbortError: vi.fn(() => false),
    isAgentBusyError: vi.fn(() => false),
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
    hookMocks.runner.hasHooks.mockReturnValue(true);
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
    hookMocks.runner.hasHooks.mockReturnValue(true);
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

  it("handles unsupported slash as handled and skips command state", async () => {
    const ctx = createContext();
    const deps = createDeps();
    deps.getText = vi.fn(() => "/unknown_cmd");
    deps.parseCommand = vi.fn(() => null);

    const result = await runInboundFlow(ctx, deps);

    expect(result).toBe("handled");
    expect(ctx.state.parsedCommand).toBeUndefined();
    expect(ctx.state.sessionKey).toBeUndefined();
  });

  it("continues for supported slash and stores parsed command state", async () => {
    const ctx = createContext();
    const deps = createDeps();
    deps.getText = vi.fn(() => "/status");
    deps.parseCommand = vi.fn(() => ({ name: "status", args: "" }));

    const result = await runInboundFlow(ctx, deps);

    expect(result).toBe("continue");
    expect(ctx.state.parsedCommand).toEqual({ name: "status", args: "" });
    expect(ctx.state.text).toBe("/status");
    expect(ctx.state.sessionKey).toBe("agent:mozi:telegram:dm:chat-1");
  });

  it("remembers last route from resolved canonical route", async () => {
    const ctx = createContext();
    const deps = createDeps();
    const canonicalRoute = {
      channelId: "telegram",
      peerId: "peer-99",
      peerType: "group" as const,
      accountId: "acct-9",
      threadId: "777",
      replyToId: "r-10",
    };

    const resolvedContext: ReturnType<OrchestratorDeps["resolveSessionContext"]> = {
      sessionKey: "agent:mozi:telegram:group:peer-99",
      agentId: "mozi",
      peerId: "peer-99",
      dmScope: "main",
      route: canonicalRoute,
    };
    deps.resolveSessionContext = vi.fn(() => resolvedContext);

    await runInboundFlow(ctx, deps);

    expect(deps.rememberLastRoute).toHaveBeenCalledWith("mozi", canonicalRoute);
  });
});
