import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelActionName, ChannelActionSpec } from "../../adapters/channels/types";
import type { MessageTurnContext, OrchestratorDeps } from "./contract";
import { StreamingBuffer } from "./services/streaming";
import { MessageTurnRuntime } from "./turn-runtime";

const flowMocks = vi.hoisted(() => ({
  runInboundFlow: vi.fn(),
  runCommandFlow: vi.fn(),
  runLifecycleFlow: vi.fn(),
  runPromptFlow: vi.fn(),
  runExecutionFlow: vi.fn(),
  runErrorFlow: vi.fn(),
  runCleanupFlow: vi.fn(),
}));

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runTurnCompleted: vi.fn(async () => {}),
  },
}));

vi.mock("./flow/inbound-flow", () => ({ runInboundFlow: flowMocks.runInboundFlow }));
vi.mock("./flow/command-flow", () => ({ runCommandFlow: flowMocks.runCommandFlow }));
vi.mock("./flow/lifecycle-flow", () => ({ runLifecycleFlow: flowMocks.runLifecycleFlow }));
vi.mock("./flow/prompt-flow", () => ({ runPromptFlow: flowMocks.runPromptFlow }));
vi.mock("./flow/execution-flow", () => ({ runExecutionFlow: flowMocks.runExecutionFlow }));
vi.mock("./flow/error-flow", () => ({ runErrorFlow: flowMocks.runErrorFlow }));
vi.mock("./flow/cleanup-flow", () => ({ runCleanupFlow: flowMocks.runCleanupFlow }));
vi.mock("../../hooks", () => ({
  getRuntimeHookRunner: () => hookMocks.runner,
}));

const TELEGRAM_ACTIONS = [
  "send_text",
  "send_media",
  "reply",
  "edit",
  "delete",
  "react",
] as const satisfies readonly ChannelActionName[];

const TELEGRAM_ACTION_SPECS: ChannelActionSpec[] = TELEGRAM_ACTIONS.map((name) => ({
  name,
  enabled: true,
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
    getChannel: vi.fn(() => ({
      id: "telegram",
      send: vi.fn(async () => "out"),
      getCapabilities: () => ({
        media: true,
        polls: false,
        reactions: true,
        threads: true,
        editMessage: true,
        deleteMessage: true,
        implicitCurrentTarget: true,
        supportedActions: [...TELEGRAM_ACTIONS],
      }),
      listActions: () => TELEGRAM_ACTION_SPECS,
    })),
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
        new StreamingBuffer(
          {
            send: async () => "out",
            editMessage: async () => {},
          },
          "peer-1",
        ),
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
    getLatestAssistantText: vi.fn(async () => undefined),
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

describe("MessageTurnRuntime stage registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    flowMocks.runInboundFlow.mockResolvedValue("continue");
    flowMocks.runCommandFlow.mockResolvedValue("continue");
    flowMocks.runLifecycleFlow.mockResolvedValue("continue");
    flowMocks.runPromptFlow.mockResolvedValue({
      promptId: "p1",
      agentId: "a1",
      config: {},
    });
    flowMocks.runExecutionFlow.mockResolvedValue("continue");
    flowMocks.runErrorFlow.mockResolvedValue("handled");
    flowMocks.runCleanupFlow.mockResolvedValue(undefined);
  });

  it("stops early when a pre-stage is handled", async () => {
    flowMocks.runInboundFlow.mockResolvedValue("handled");
    const runtime = new MessageTurnRuntime(createDeps());

    const result = await runtime.run(createContext());

    expect(result).toBeNull();
    expect(flowMocks.runCommandFlow).not.toHaveBeenCalled();
    expect(flowMocks.runCleanupFlow).toHaveBeenCalledTimes(1);
  });

  it("passes prompt bundle into execution stage", async () => {
    const runtime = new MessageTurnRuntime(createDeps());
    const ctx = createContext();

    await runtime.run(ctx);

    expect(flowMocks.runExecutionFlow).toHaveBeenCalledWith(
      ctx,
      expect.any(Object),
      expect.objectContaining({ promptId: "p1", agentId: "a1" }),
    );
  });

  it("always runs cleanup after execution error", async () => {
    flowMocks.runExecutionFlow.mockRejectedValue(new Error("boom"));
    const runtime = new MessageTurnRuntime(createDeps());

    const result = await runtime.run(createContext());

    expect(result).toBeNull();
    expect(flowMocks.runErrorFlow).toHaveBeenCalledTimes(1);
    expect(flowMocks.runCleanupFlow).toHaveBeenCalledTimes(1);
  });

  it("emits turn_completed hook when session context is available", async () => {
    hookMocks.runner.hasHooks.mockImplementation(() => true);
    const runtime = new MessageTurnRuntime(createDeps());
    const ctx: MessageTurnContext = {
      ...createContext(),
      state: { sessionKey: "agent:mozi:telegram:dm:chat-1", agentId: "mozi" },
    };

    await runtime.run(ctx);

    expect(hookMocks.runner.runTurnCompleted).toHaveBeenCalledTimes(1);
    expect(hookMocks.runner.runTurnCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "turn:m1",
        messageId: "m1",
        status: "success",
      }),
      expect.objectContaining({
        sessionKey: "agent:mozi:telegram:dm:chat-1",
        agentId: "mozi",
      }),
    );
  });
});
