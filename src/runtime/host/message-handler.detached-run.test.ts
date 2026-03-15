import { describe, expect, it, vi } from "vitest";
import { AcpSessionManager } from "../../acp/control-plane";
import type { MoziConfig } from "../../config";
import type { ChannelPlugin } from "../adapters/channels/plugin";
import type { InboundMessage } from "../adapters/channels/types";
import { MessageHandler } from "./message-handler";

function createConfig(): MoziConfig {
  return {
    models: {
      providers: {
        quotio: {
          api: "openai-responses",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          models: [{ id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" }],
        },
      },
    },
    agents: {
      mozi: {
        model: "quotio/gemini-3-flash-preview",
      },
    },
  };
}

describe("MessageHandler.startDetachedRun observability", () => {
  it("projects failed terminal with unified fields", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
      };
      resolveSessionContext: (message: InboundMessage) => {
        sessionKey: string;
        agentId: string;
        peerId: string;
        route: {
          channelId: string;
          peerId: string;
          peerType: "dm" | "group" | "channel";
          accountId?: string;
          threadId?: string;
          replyToId?: string;
        };
      };
      handle: (message: InboundMessage, channel: ChannelPlugin) => Promise<void>;
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
    };
    h.resolveSessionContext = () => ({
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
      peerId: "chat-1",
      route: {
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "dm",
      },
    });

    const err = Object.assign(new Error("boom"), { code: "ACP_TURN_FAILED" });
    h.handle = vi.fn(async () => {
      throw err;
    });

    const onTerminal = vi.fn();
    const message = {
      id: "m-1",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u-1",
      senderName: "tester",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    } as InboundMessage;
    const channel = {
      id: "telegram",
      name: "Telegram",
      connect: async () => {},
      disconnect: async () => {},
      send: async () => "out-1",
      getStatus: () => "connected",
      isConnected: () => true,
      on: () => channel,
      once: () => channel,
      off: () => channel,
      emit: () => true,
      removeAllListeners: () => channel,
    } as unknown as ChannelPlugin;

    await handler.startDetachedRun({ message, channel, queueItemId: "q-1", onTerminal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          runId: "run:m-1",
          sessionKey: "agent:mozi:telegram:dm:chat-1",
          traceId: "turn:m-1",
        }),
        terminal: "failed",
        reason: "boom",
        errorCode: "ACP_TURN_FAILED",
      }),
    );
  });

  it("keeps terminal callback single-shot under late settle race", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
      };
      resolveSessionContext: (message: InboundMessage) => {
        sessionKey: string;
        agentId: string;
        peerId: string;
        route: {
          channelId: string;
          peerId: string;
          peerType: "dm" | "group" | "channel";
          accountId?: string;
          threadId?: string;
          replyToId?: string;
        };
      };
      handle: (message: InboundMessage, channel: ChannelPlugin) => Promise<void>;
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [{ role: "assistant", content: "late-success" }] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
    };
    h.resolveSessionContext = () => ({
      sessionKey: "agent:mozi:telegram:dm:chat-1",
      agentId: "mozi",
      peerId: "chat-1",
      route: {
        channelId: "telegram",
        peerId: "chat-1",
        peerType: "dm",
      },
    });

    const err = Object.assign(new Error("first-fail"), { code: "ACP_TURN_FAILED" });
    h.handle = vi.fn(async () => {
      throw err;
    });

    const onTerminal = vi.fn();
    const message = {
      id: "m-2",
      channel: "telegram",
      peerId: "chat-1",
      peerType: "dm",
      senderId: "u-1",
      senderName: "tester",
      text: "hello",
      timestamp: new Date(),
      raw: {},
    } as InboundMessage;
    const channel = {
      id: "telegram",
      name: "Telegram",
      connect: async () => {},
      disconnect: async () => {},
      send: async () => "out-1",
      getStatus: () => "connected",
      isConnected: () => true,
      on: () => channel,
      once: () => channel,
      off: () => channel,
      emit: () => true,
      removeAllListeners: () => channel,
    } as unknown as ChannelPlugin;

    await handler.startDetachedRun({ message, channel, queueItemId: "q-2", onTerminal });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ runId: "run:m-2", traceId: "turn:m-2" }),
        terminal: "failed",
        reason: "first-fail",
      }),
    );
  });

  it("emits timeout terminal once when detached run exceeds timeout", async () => {
    vi.useFakeTimers();
    try {
      const handler = new MessageHandler(createConfig());
      const h = handler as unknown as {
        agentManager: {
          getAgent: (
            sessionKey: string,
            agentId: string,
          ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
          getSessionMetadata: (sessionKey: string) => Record<string, unknown>;
          resolveDefaultAgentId: () => string;
        };
        runPromptWithFallback: (params: {
          sessionKey: string;
          agentId: string;
          text: string;
          traceId?: string;
        }) => Promise<void>;
        resolveLatestAssistantText: (sessionKey: string, agentId: string) => Promise<string>;
        createHostSubagentRuntime: (
          sessionManager: unknown,
          detachedRunRegistry: unknown,
        ) => {
          startDetachedPromptRun: (params: {
            runId: string;
            sessionKey: string;
            agentId: string;
            text: string;
            timeoutSeconds?: number;
            onTerminal?: (params: {
              terminal: "completed" | "failed" | "aborted" | "timeout";
              partialText?: string;
              error?: Error;
              reason?: string;
              errorCode?: string;
            }) => Promise<void> | void;
          }) => Promise<{ runId: string }>;
        };
      };

      h.agentManager = {
        getAgent: async () => ({
          agent: { messages: [{ role: "assistant", content: "late-success" }] },
          modelRef: "quotio/gemini-3-flash-preview",
        }),
        getSessionMetadata: () => ({}),
        resolveDefaultAgentId: () => "mozi",
      };
      h.resolveLatestAssistantText = async () => "late-success";
      h.runPromptWithFallback = vi.fn(
        () => new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      );

      const runtime = h.createHostSubagentRuntime(
        { get: () => undefined } as never,
        {
          get: () => undefined,
          register: vi.fn(),
          markStarted: vi.fn(),
          setTerminal: vi.fn(),
        } as never,
      );
      const onTerminal = vi.fn();

      await runtime?.startDetachedPromptRun({
        runId: "subagent-timeout-run",
        sessionKey: "agent:worker:subagent:dm:chat-1",
        agentId: "worker",
        text: "work",
        timeoutSeconds: 1,
        onTerminal,
      });

      await vi.advanceTimersByTimeAsync(1000);

      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          terminal: "timeout",
          reason: "subagent-timeout",
        }),
      );

      await vi.advanceTimersByTimeAsync(5000);
      expect(onTerminal).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes ACP detached runs to normalized completed terminal exactly once", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        getSessionMetadata: (sessionKey: string) => Record<string, unknown>;
        resolveDefaultAgentId: () => string;
      };
      createHostSubagentRuntime: (
        sessionManager: unknown,
        detachedRunRegistry: unknown,
      ) => {
        startDetachedPromptRun: (params: {
          runId: string;
          sessionKey: string;
          agentId: string;
          text: string;
          timeoutSeconds?: number;
          onTerminal?: (params: {
            terminal: "completed" | "failed" | "aborted" | "timeout";
            partialText?: string;
            error?: Error;
            reason?: string;
            errorCode?: string;
          }) => Promise<void> | void;
        }) => Promise<{ runId: string }>;
      };
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
      resolveDefaultAgentId: () => "mozi",
    };

    const runTurnMock = vi
      .spyOn(AcpSessionManager.prototype, "runTurn")
      .mockImplementation(async (params) => {
        await params.onTerminal?.({ terminal: "completed", reason: "done" });
      });

    const onTerminal = vi.fn();
    const runtime = h.createHostSubagentRuntime(
      { get: () => ({ parentKey: "parent-session" }) } as never,
      {
        get: () => undefined,
        register: vi.fn(),
        markStarted: vi.fn(),
        setTerminal: vi.fn(),
      } as never,
    );

    await runtime.startDetachedPromptRun({
      runId: "acp-complete-run",
      sessionKey: "agent:worker:subagent:dm:chat-1",
      agentId: "worker",
      text: "work",
      onTerminal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: "completed", reason: "done" }),
    );
    runTurnMock.mockRestore();
  });

  it("routes ACP detached runs to normalized failed terminal exactly once", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: (
          sessionKey: string,
          agentId: string,
        ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        getSessionMetadata: (sessionKey: string) => Record<string, unknown>;
        resolveDefaultAgentId: () => string;
      };
      createHostSubagentRuntime: (
        sessionManager: unknown,
        detachedRunRegistry: unknown,
      ) => {
        startDetachedPromptRun: (params: {
          runId: string;
          sessionKey: string;
          agentId: string;
          text: string;
          timeoutSeconds?: number;
          onTerminal?: (params: {
            terminal: "completed" | "failed" | "aborted" | "timeout";
            partialText?: string;
            error?: Error;
            reason?: string;
            errorCode?: string;
          }) => Promise<void> | void;
        }) => Promise<{ runId: string }>;
      };
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
      resolveDefaultAgentId: () => "mozi",
    };

    const runTurnMock = vi
      .spyOn(AcpSessionManager.prototype, "runTurn")
      .mockImplementation(async (params) => {
        await params.onTerminal?.({
          terminal: "failed",
          reason: "Runtime failed",
          errorCode: "RUNTIME_ERR",
        });
      });

    const onTerminal = vi.fn();
    const runtime = h.createHostSubagentRuntime(
      { get: () => ({ parentKey: "parent-session" }) } as never,
      {
        get: () => undefined,
        register: vi.fn(),
        markStarted: vi.fn(),
        setTerminal: vi.fn(),
      } as never,
    );

    await runtime.startDetachedPromptRun({
      runId: "acp-failed-run",
      sessionKey: "agent:worker:subagent:dm:chat-1",
      agentId: "worker",
      text: "work",
      onTerminal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        terminal: "failed",
        reason: "Runtime failed",
        errorCode: "RUNTIME_ERR",
      }),
    );
    runTurnMock.mockRestore();
  });

  it("registers ACP detached runs durably before execution and marks them started", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: () => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        getSessionMetadata: () => Record<string, unknown>;
        resolveDefaultAgentId: () => string;
      };
      createHostSubagentRuntime: (
        sessionManager: unknown,
        detachedRunRegistry: unknown,
      ) => {
        startDetachedPromptRun: (params: {
          runId: string;
          sessionKey: string;
          agentId: string;
          text: string;
          onTerminal?: (params: {
            terminal: "completed" | "failed" | "aborted" | "timeout";
            partialText?: string;
            error?: Error;
            reason?: string;
            errorCode?: string;
          }) => Promise<void> | void;
        }) => Promise<{ runId: string }>;
      };
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
      resolveDefaultAgentId: () => "mozi",
    };

    const register = vi.fn();
    const markStarted = vi.fn();
    const setTerminal = vi.fn(async () => undefined);
    const get = vi.fn(() => undefined);
    const runTurnMock = vi
      .spyOn(AcpSessionManager.prototype, "runTurn")
      .mockResolvedValue(undefined);
    const runtime = h.createHostSubagentRuntime(
      {
        get: () => ({ parentKey: "parent-session" }),
      } as never,
      { register, markStarted, setTerminal, get } as never,
    );

    await runtime.startDetachedPromptRun({
      runId: "acp-register-run",
      sessionKey: "agent:worker:subagent:dm:chat-1",
      agentId: "worker",
      text: "work",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "acp-register-run",
        kind: "acp",
        childKey: "agent:worker:subagent:dm:chat-1",
        parentKey: "parent-session",
        task: "work",
      }),
    );
    expect(markStarted).toHaveBeenCalledWith("acp-register-run");
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    runTurnMock.mockRestore();
  });

  it("persists ACP terminal exactly once under duplicate settle race", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: () => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
      };
      createHostSubagentRuntime: (
        sessionManager: unknown,
        detachedRunRegistry: unknown,
      ) => {
        startDetachedPromptRun: (params: {
          runId: string;
          sessionKey: string;
          agentId: string;
          text: string;
          onTerminal?: (params: {
            terminal: "completed" | "failed" | "aborted" | "timeout";
            partialText?: string;
            error?: Error;
            reason?: string;
            errorCode?: string;
          }) => Promise<void> | void;
        }) => Promise<{ runId: string }>;
      };
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
      resolveDefaultAgentId: () => "mozi",
    } as never;

    const onTerminal = vi.fn();
    const setTerminal = vi.fn(async () => undefined);
    const runTurnMock = vi
      .spyOn(AcpSessionManager.prototype, "runTurn")
      .mockImplementation(async (params) => {
        await params.onTerminal?.({ terminal: "completed", reason: "done" });
        throw new Error("late-fail");
      });
    const runtime = h.createHostSubagentRuntime(
      {
        get: () => ({ parentKey: "parent-session" }),
      } as never,
      {
        register: vi.fn(),
        markStarted: vi.fn(),
        setTerminal,
        get: vi.fn(() => undefined),
      } as never,
    );

    await runtime.startDetachedPromptRun({
      runId: "acp-dedupe-run",
      sessionKey: "agent:worker:subagent:dm:chat-1",
      agentId: "worker",
      text: "work",
      onTerminal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(setTerminal).toHaveBeenCalledTimes(1);
    expect(setTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "acp-dedupe-run",
        status: "completed",
      }),
    );
    runTurnMock.mockRestore();
  });

  it("persists ACP terminal even without external terminal callback", async () => {
    const handler = new MessageHandler(createConfig());
    const h = handler as unknown as {
      agentManager: {
        getAgent: () => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
        getSessionMetadata: () => Record<string, unknown>;
        resolveDefaultAgentId: () => string;
      };
      createHostSubagentRuntime: (
        sessionManager: unknown,
        detachedRunRegistry: unknown,
      ) => {
        startDetachedPromptRun: (params: {
          runId: string;
          sessionKey: string;
          agentId: string;
          text: string;
        }) => Promise<{ runId: string }>;
      };
    };

    h.agentManager = {
      getAgent: async () => ({
        agent: { messages: [] },
        modelRef: "quotio/gemini-3-flash-preview",
      }),
      getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
      resolveDefaultAgentId: () => "mozi",
    };

    const setTerminal = vi.fn(async () => undefined);
    const runTurnMock = vi
      .spyOn(AcpSessionManager.prototype, "runTurn")
      .mockImplementation(async (params) => {
        await params.onTerminal?.({ terminal: "completed", reason: "done" });
      });
    const runtime = h.createHostSubagentRuntime(
      { get: () => ({ parentKey: "parent-session" }) } as never,
      {
        register: vi.fn(),
        markStarted: vi.fn(),
        setTerminal,
        get: vi.fn(() => undefined),
      } as never,
    );

    await runtime.startDetachedPromptRun({
      runId: "acp-no-callback-run",
      sessionKey: "agent:worker:subagent:dm:chat-1",
      agentId: "worker",
      text: "work",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setTerminal).toHaveBeenCalledTimes(1);
    expect(setTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "acp-no-callback-run",
        status: "completed",
      }),
    );
    runTurnMock.mockRestore();
  });

  it("persists ACP timeout when runTurn exits without onTerminal", async () => {
    vi.useFakeTimers();
    try {
      const handler = new MessageHandler(createConfig());
      const h = handler as unknown as {
        agentManager: {
          getAgent: () => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
          getSessionMetadata: () => Record<string, unknown>;
          resolveDefaultAgentId: () => string;
        };
        createHostSubagentRuntime: (
          sessionManager: unknown,
          detachedRunRegistry: unknown,
        ) => {
          startDetachedPromptRun: (params: {
            runId: string;
            sessionKey: string;
            agentId: string;
            text: string;
            timeoutSeconds?: number;
            onTerminal?: (params: {
              terminal: "completed" | "failed" | "aborted" | "timeout";
              partialText?: string;
              error?: Error;
              reason?: string;
              errorCode?: string;
            }) => Promise<void> | void;
          }) => Promise<{ runId: string }>;
        };
      };

      h.agentManager = {
        getAgent: async () => ({
          agent: { messages: [] },
          modelRef: "quotio/gemini-3-flash-preview",
        }),
        getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
        resolveDefaultAgentId: () => "mozi",
      };

      const setTerminal = vi.fn(async () => undefined);
      const runTurnMock = vi
        .spyOn(AcpSessionManager.prototype, "runTurn")
        .mockImplementation(async ({ signal }) => {
          await new Promise<void>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error(String(signal.reason))), {
              once: true,
            });
          });
        });
      const runtime = h.createHostSubagentRuntime(
        { get: () => ({ parentKey: "parent-session" }) } as never,
        {
          register: vi.fn(),
          markStarted: vi.fn(),
          setTerminal,
          get: vi.fn(() => undefined),
        } as never,
      );
      const onTerminal = vi.fn();

      await runtime.startDetachedPromptRun({
        runId: "acp-timeout-run",
        sessionKey: "agent:worker:subagent:dm:chat-1",
        agentId: "worker",
        text: "work",
        timeoutSeconds: 1,
        onTerminal,
      });

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();

      expect(onTerminal).toHaveBeenCalledTimes(1);
      expect(onTerminal).toHaveBeenCalledWith(
        expect.objectContaining({ terminal: "timeout", reason: "acp-timeout" }),
      );
      expect(setTerminal).toHaveBeenCalledTimes(1);
      expect(setTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "acp-timeout-run",
          status: "timeout",
          error: "acp-timeout",
        }),
      );
      runTurnMock.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs instead of leaking an unhandled rejection when ACP timeout persistence fails", async () => {
    vi.useFakeTimers();
    const loggerModule = await import("../../logger");
    const loggerError = vi.spyOn(loggerModule.logger, "error").mockImplementation(() => undefined);
    try {
      const handler = new MessageHandler(createConfig());
      const h = handler as unknown as {
        agentManager: {
          getAgent: () => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
          getSessionMetadata: () => Record<string, unknown>;
          resolveDefaultAgentId: () => string;
        };
        createHostSubagentRuntime: (
          sessionManager: unknown,
          detachedRunRegistry: unknown,
        ) => {
          startDetachedPromptRun: (params: {
            runId: string;
            sessionKey: string;
            agentId: string;
            text: string;
            timeoutSeconds?: number;
          }) => Promise<{ runId: string }>;
        };
      };

      h.agentManager = {
        getAgent: async () => ({
          agent: { messages: [] },
          modelRef: "quotio/gemini-3-flash-preview",
        }),
        getSessionMetadata: () => ({ acp: { backend: "test-backend", mode: "persistent" } }),
        resolveDefaultAgentId: () => "mozi",
      };

      const setTerminal = vi.fn(async () => {
        throw new Error("disk-full");
      });
      const runTurnMock = vi
        .spyOn(AcpSessionManager.prototype, "runTurn")
        .mockImplementation(async ({ signal }) => {
          await new Promise<void>((_, reject) => {
            signal?.addEventListener("abort", () => reject(new Error(String(signal.reason))), {
              once: true,
            });
          });
        });
      const runtime = h.createHostSubagentRuntime(
        { get: () => ({ parentKey: "parent-session" }) } as never,
        {
          register: vi.fn(),
          markStarted: vi.fn(),
          setTerminal,
          get: vi.fn(() => undefined),
        } as never,
      );

      await runtime.startDetachedPromptRun({
        runId: "acp-timeout-persist-fail-run",
        sessionKey: "agent:worker:subagent:dm:chat-1",
        agentId: "worker",
        text: "work",
        timeoutSeconds: 1,
      });

      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(setTerminal).toHaveBeenCalledTimes(1);
      expect(loggerError).toHaveBeenCalledWith(
        expect.objectContaining({ err: "disk-full", runId: "acp-timeout-persist-fail-run" }),
        "Failed to persist ACP detached run timeout",
      );
      runTurnMock.mockRestore();
    } finally {
      loggerError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("defers internal message while parent run is active, then processes it after terminal", async () => {
    vi.useFakeTimers();
    try {
      const handler = new MessageHandler(createConfig());
      const h = handler as unknown as {
        agentManager: {
          getAgent: (
            sessionKey: string,
            agentId: string,
          ) => Promise<{ agent: { messages: unknown[] }; modelRef: string }>;
          getSessionMetadata: (sessionKey: string) => Record<string, unknown>;
          resolveDefaultAgentId: () => string;
        };
        runPromptWithFallback: (params: {
          sessionKey: string;
          agentId: string;
          text: string;
          traceId?: string;
        }) => Promise<void>;
        resolveLatestAssistantText: (sessionKey: string, agentId: string) => Promise<string>;
        createHostSubagentRuntime: (
          sessionManager: unknown,
          detachedRunRegistry: unknown,
        ) => {
          startDetachedPromptRun: (params: {
            runId: string;
            sessionKey: string;
            agentId: string;
            text: string;
            timeoutSeconds?: number;
            onTerminal?: (params: {
              terminal: "completed" | "failed" | "aborted" | "timeout";
              partialText?: string;
              error?: Error;
              reason?: string;
              errorCode?: string;
            }) => Promise<void> | void;
          }) => Promise<{ runId: string }>;
        };
        handleInternalMessage: (params: {
          sessionKey: string;
          content: string;
          source: string;
          metadata?: Record<string, unknown>;
        }) => Promise<void>;
        pendingInternalMessages: Map<
          string,
          Array<{ content: string; source: string; metadata?: Record<string, unknown> }>
        >;
      };

      const sessionKey = "agent:worker:subagent:dm:chat-defer";
      let resolvePrompt!: () => void;
      const promptPromise = new Promise<void>((resolve) => {
        resolvePrompt = resolve;
      });

      h.agentManager = {
        getAgent: async () => ({
          agent: { messages: [] },
          modelRef: "quotio/gemini-3-flash-preview",
        }),
        getSessionMetadata: () => ({}),
        resolveDefaultAgentId: () => "mozi",
      };
      h.resolveLatestAssistantText = async () => "";
      h.runPromptWithFallback = vi.fn(() => promptPromise);

      const runtime = h.createHostSubagentRuntime(
        { get: () => undefined } as never,
        {
          get: () => undefined,
          register: vi.fn(),
          markStarted: vi.fn(),
          setTerminal: vi.fn(),
        } as never,
      );

      // Start a detached run that won't complete until we resolve the promise
      await runtime.startDetachedPromptRun({
        runId: "defer-parent-run",
        sessionKey,
        agentId: "worker",
        text: "parent task",
      });

      // Advance timers so the microtask fires and the run becomes "started"
      await vi.advanceTimersByTimeAsync(0);

      // Now send an internal message while the run is active — it should be deferred
      void handler.handleInternalMessage({
        sessionKey,
        content: "deferred notification",
        source: "subagent-timeout",
      });

      // Message must be queued, not yet processed
      const queued = h.pendingInternalMessages.get(sessionKey);
      expect(queued).toBeDefined();
      expect(queued).toHaveLength(1);
      expect(queued?.[0]?.content).toBe("deferred notification");

      // runPromptWithFallback should not have been called for the internal message yet
      expect(h.runPromptWithFallback).toHaveBeenCalledTimes(1); // only the parent run call

      // Complete the parent run
      resolvePrompt();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      // After terminal, deferred message should have been flushed
      expect(h.pendingInternalMessages.get(sessionKey)).toBeUndefined();
      expect(h.runPromptWithFallback).toHaveBeenCalledTimes(2); // parent + deferred
      const secondCall = (h.runPromptWithFallback as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(secondCall[0]).toMatchObject({
        sessionKey,
        text: "deferred notification",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
