import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelActionName } from "../../../adapters/channels/types";
import type { MessageTurnContext, OrchestratorDeps, PreparedPromptBundle } from "../contract";
import { runExecutionFlow } from "./execution-flow";

const multimodalMocks = vi.hoisted(() => ({
  resolveProviderInputMediaAsImages: vi.fn(async () => ({ images: [], degradationNotices: [] })),
}));

vi.mock("../../../../multimodal/provider-media", () => ({
  resolveProviderInputMediaAsImages: multimodalMocks.resolveProviderInputMediaAsImages,
}));

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

function createBridgeChannel(
  overrides: Partial<
    OrchestratorDeps["getChannel"] extends (...args: never[]) => infer R ? R : never
  > = {},
) {
  const supportedActions: ChannelActionName[] = ["send_text", "send_media", "reply"];
  return {
    id: "telegram",
    send: vi.fn(async () => "out"),
    supportsThinkingStream: false,
    getCapabilities: () => ({
      media: true,
      polls: false,
      reactions: true,
      threads: true,
      editMessage: false,
      deleteMessage: false,
      implicitCurrentTarget: true,
      supportedActions,
    }),
    ...overrides,
  };
}

function createDeps(): OrchestratorDeps & {
  __loggerInfoMock: ReturnType<typeof vi.fn>;
  __runPromptWithFallbackMock: ReturnType<typeof vi.fn>;
} {
  const loggerInfo = vi.fn();
  const runPromptWithFallbackMock = vi.fn(async ({ onStream }) => {
    if (onStream) {
      await onStream({ type: "agent_end", fullText: "hi" });
    }
  });
  return {
    config: {} as OrchestratorDeps["config"],
    logger: {
      info: loggerInfo,
      warn: vi.fn(),
      error: vi.fn(),
    },
    getText: vi.fn(() => ""),
    getMedia: vi.fn(() => []),
    normalizeImplicitControlCommand: vi.fn((v: string) => v),
    parseCommand: vi.fn(() => null),
    parseInlineOverrides: vi.fn(() => null),
    resolveSessionContext: vi.fn(() => ({
      sessionKey: "s",
      agentId: "a",
      peerId: "p",
      route: {
        channelId: "telegram",
        peerId: "p",
        peerType: "dm" as const,
      },
    })),
    rememberLastRoute: vi.fn(),
    sendDirect: vi.fn(async () => {}),
    getCommandHandlerMap: vi.fn(
      () => ({}) as OrchestratorDeps["getCommandHandlerMap"] extends () => infer R ? R : never,
    ),
    getChannel: vi.fn(() => createBridgeChannel()),
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
    runPromptWithFallback: runPromptWithFallbackMock,
    maybePreFlushBeforePrompt: vi.fn(async () => {}),
    shouldSuppressSilentReply: vi.fn(() => false),
    shouldSuppressHeartbeatReply: vi.fn(() => false),
    dispatchReply: vi.fn(async () => "out-1"),
    toError: vi.fn((err: unknown) => (err instanceof Error ? err : new Error(String(err)))),
    isAbortError: vi.fn(() => false),
    isAgentBusyError: vi.fn(() => false),
    createErrorReplyText: vi.fn(() => "error"),
    setSessionModel: vi.fn(async () => {}),
    stopTypingIndicator: vi.fn(async () => {}),
    __loggerInfoMock: loggerInfo,
    __runPromptWithFallbackMock: runPromptWithFallbackMock,
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
  it("uses the real channel plugin for prompt channel context setup", async () => {
    const ctx = createContext();
    const deps = createDeps();
    const bridgeChannel = createBridgeChannel();
    deps.getChannel = vi.fn(() => bridgeChannel);

    await runExecutionFlow(ctx, deps, createBundle());

    expect(deps.ensureChannelContext.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
        message: ctx.payload,
      }),
    );
    expect(
      (deps.ensureChannelContext as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    ).not.toHaveProperty("channel", bridgeChannel);
  });

  it("preserves telegram thinking stream support from the bridge", async () => {
    const ctx = createContext();
    const deps = createDeps();
    const createStreamingBuffer = vi.spyOn(deps, "createStreamingBuffer");

    deps.getChannel = vi.fn(() =>
      createBridgeChannel({
        supportsThinkingStream: true,
        editMessage: vi.fn(async () => {}),
      }),
    );

    await runExecutionFlow(ctx, deps, createBundle());

    expect(createStreamingBuffer).toHaveBeenCalledTimes(1);
  });

  it("uses timeout-specific fallback copy for streaming flows", async () => {
    const ctx = createContext();
    const deps = createDeps();
    const dispatchReply = vi.spyOn(deps, "dispatchReply");

    deps.getChannel = vi.fn(() =>
      createBridgeChannel({
        editMessage: vi.fn(async () => {}),
      }),
    );
    deps.runPromptWithFallback = vi.fn(async ({ onFallback, onStream }) => {
      await onFallback?.({
        fromModel: "quotio/gemini-3-flash-preview",
        toModel: "quotio/local/minimax-m2.1",
        attempt: 1,
        error: "Agent prompt timed out",
        reason: "timeout",
      });
      await onStream?.({ type: "agent_end", fullText: "hi" });
    });

    await runExecutionFlow(ctx, deps, createBundle());

    expect(dispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText:
          "⚠️ Primary model timed out this turn; using fallback model quotio/local/minimax-m2.1 (from quotio/gemini-3-flash-preview). You can /switch if you want to keep using it.",
      }),
    );
  });

  it("uses timeout-specific fallback copy for non-streaming flows", async () => {
    const ctx = createContext();
    const deps = createDeps();
    const dispatchReply = vi.spyOn(deps, "dispatchReply");

    deps.getChannel = vi.fn(() => createBridgeChannel());
    deps.runPromptWithFallback = vi.fn(async ({ onFallback, onStream }) => {
      await onFallback?.({
        fromModel: "quotio/gemini-3-flash-preview",
        toModel: "quotio/local/minimax-m2.1",
        attempt: 1,
        error: "Agent prompt timed out",
        reason: "timeout",
      });
      await onStream?.({ type: "agent_end", fullText: "hi" });
    });

    await runExecutionFlow(ctx, deps, createBundle());

    expect(dispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText:
          "⚠️ Primary model timed out this turn; using fallback model quotio/local/minimax-m2.1 (from quotio/gemini-3-flash-preview).",
      }),
    );
  });

  it("keeps generic fallback copy for non-timeout failures", async () => {
    const ctx = createContext();
    const deps = createDeps();
    const dispatchReply = vi.spyOn(deps, "dispatchReply");

    deps.getChannel = vi.fn(() => createBridgeChannel());
    deps.runPromptWithFallback = vi.fn(async ({ onFallback, onStream }) => {
      await onFallback?.({
        fromModel: "quotio/gemini-3-flash-preview",
        toModel: "quotio/local/minimax-m2.1",
        attempt: 1,
        error: "400 model failure",
        reason: "error",
      });
      await onStream?.({ type: "agent_end", fullText: "hi" });
    });

    await runExecutionFlow(ctx, deps, createBundle());

    expect(dispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText:
          "⚠️ Primary model failed this turn; using fallback model quotio/local/minimax-m2.1 (from quotio/gemini-3-flash-preview).",
      }),
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    multimodalMocks.resolveProviderInputMediaAsImages.mockResolvedValue({
      images: [],
      degradationNotices: [],
    });
  });
  it("fails fast when vision media exists but strict resolution fails", async () => {
    multimodalMocks.resolveProviderInputMediaAsImages.mockRejectedValueOnce(
      new Error("strict media resolution failed"),
    );
    const ctx = createContext();
    const deps = createDeps();
    const ingestPlan = {
      acceptedInput: [],
      providerInput: [
        {
          id: "p-image",
          role: "user",
          index: 0,
          modality: "image",
          media: { mediaId: "missing", mimeType: "image/png", byteSize: 1, sha256: "sha" },
        },
      ],
      outputModalities: ["text"],
      transforms: [],
      fallbackUsed: false,
    };

    await expect(
      runExecutionFlow(ctx, deps, {
        ...createBundle(),
        config: { promptText: "look", ingestPlan },
      }),
    ).rejects.toThrow("strict media resolution failed");

    expect(deps.__runPromptWithFallbackMock.mock.calls.length).toBe(0);
  });

  it("passes structured images into prompt runner on vision path", async () => {
    multimodalMocks.resolveProviderInputMediaAsImages.mockResolvedValueOnce({
      images: [{ type: "image", data: "AQID", mimeType: "image/png" }],
      degradationNotices: [],
    } as never);
    const ctx = createContext();
    const deps = createDeps();
    const ingestPlan = {
      acceptedInput: [],
      providerInput: [
        {
          id: "p-image",
          role: "user",
          index: 0,
          modality: "image",
          media: { mediaId: "img-ok", mimeType: "image/png", byteSize: 4, sha256: "sha" },
        },
      ],
      outputModalities: ["text"],
      transforms: [],
      fallbackUsed: false,
    };

    await runExecutionFlow(ctx, deps, {
      ...createBundle(),
      config: { promptText: "describe", ingestPlan },
    });

    expect(deps.__runPromptWithFallbackMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ type: "image", data: "AQID", mimeType: "image/png" }),
        ]),
      }),
    );
  });
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(false);
  });

  it("emits message_sent hook after dispatch", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
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

    expect(deps.__loggerInfoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:m1",
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
        deliveryMode: "direct_dispatch",
        terminalSource: "final_only",
      }),
      "Terminal reply delivered",
    );
  });

  it("skips dispatch when message_sending cancels", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);
    hookMocks.runner.runMessageSending.mockImplementation(async () => ({ cancel: true }) as never);
    const ctx = createContext();
    const deps = createDeps();
    const dispatchReply = vi.spyOn(deps, "dispatchReply");

    await runExecutionFlow(ctx, deps, createBundle());

    expect(dispatchReply).not.toHaveBeenCalled();
    expect(hookMocks.runner.runMessageSent).not.toHaveBeenCalled();
  });
});
