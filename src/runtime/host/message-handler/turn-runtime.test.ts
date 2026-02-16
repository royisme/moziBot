import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageTurnContext, OrchestratorDeps } from "./contract";
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

vi.mock("./flow/inbound-flow", () => ({ runInboundFlow: flowMocks.runInboundFlow }));
vi.mock("./flow/command-flow", () => ({ runCommandFlow: flowMocks.runCommandFlow }));
vi.mock("./flow/lifecycle-flow", () => ({ runLifecycleFlow: flowMocks.runLifecycleFlow }));
vi.mock("./flow/prompt-flow", () => ({ runPromptFlow: flowMocks.runPromptFlow }));
vi.mock("./flow/execution-flow", () => ({ runExecutionFlow: flowMocks.runExecutionFlow }));
vi.mock("./flow/error-flow", () => ({ runErrorFlow: flowMocks.runErrorFlow }));
vi.mock("./flow/cleanup-flow", () => ({ runCleanupFlow: flowMocks.runCleanupFlow }));

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

describe("MessageTurnRuntime stage registry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
